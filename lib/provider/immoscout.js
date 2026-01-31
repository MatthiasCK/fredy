/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * ImmoScout provider using the mobile API to retrieve listings.
 *
 * The mobile API provides the following endpoints:
 * - GET /search/total?{search parameters}: Returns the total number of listings for the given query
 *   Example: `curl -H "User-Agent: ImmoScout_27.12_26.2_._" https://api.mobile.immobilienscout24.de/search/total?searchType=region&realestatetype=apartmentrent&pricetype=calculatedtotalrent&geocodes=%2Fde%2Fberlin%2Fberlin `
 *
 * - POST /search/list?{search parameters}: Actually retrieves the listings. Body is json encoded and contains
 *   data specifying additional results (advertisements) to return. The format is as follows:
 *   ```
 *   {
 *   "supportedResultListTypes": [],
 *   "userData": {}
 *   }
 *   ```
 *   It is not necessary to provide data for the specified keys.
 *
 *   Example: `curl -X POST 'https://api.mobile.immobilienscout24.de/search/list?pricetype=calculatedtotalrent&realestatetype=apartmentrent&searchType=region&geocodes=%2Fde%2Fberlin%2Fberlin&pagenumber=1' -H "Connection: keep-alive" -H "User-Agent: ImmoScout_27.12_26.2_._" -H "Accept: application/json" -H "Content-Type: application/json" -d '{"supportedResultListType": [], "userData": {}}'`

 * - GET /expose/{id} - Returns the details of a listing. The response contains additional details not included in the
 *   listing response.
 *
 *   Example: `curl -H "User-Agent: ImmoScout_27.12_26.2_._" "https://api.mobile.immobilienscout24.de/expose/158382494"`
 *
 *
 * It is necessary to set the correct User Agent (see `getListings`) in the request header.
 *
 * Note that the mobile API is not publicly documented. I've reverse-engineered
 * it by intercepting traffic from an android emulator running the immoscout app.
 * Moreover, the search parameters differ slightly from the web API. I've mapped them
 * to the web API parameters by comparing a search request with all parameters set between
 * the web and mobile API. The mobile API actually seems to be a superset of the web API,
 * but I have decided not to include new parameters as I wanted to keep the existing UX (i.e.,
 * users only have to provide a link to an existing search).
 *
 */

import { buildHash, isOneOf, sleep, randomBetween } from '../utils.js';
import {
  convertImmoscoutListingToMobileListing,
  convertWebToMobile,
} from '../services/immoscout/immoscout-web-translator.js';
import { getListingDetails } from '../services/immoscout/immoscout-details-extractor.js';
import logger from '../services/logger.js';

let appliedBlackList = [];
let fullFetchMode = false;

/**
 * Parse a German relative time string into an approximate millisecond timestamp.
 *
 * Handles both numeric ("vor 20 Minuten") and word-based ("vor einer Stunde")
 * formats as returned by the ImmoScout mobile API.
 *
 * @param {string|undefined} str - The relative time string from the API.
 * @returns {number|null} Approximate publish timestamp in ms, or null if unparseable.
 */
function parseRelativeTime(str) {
  if (!str) return null;
  const s = str.toLowerCase().trim();

  // Match "vor <amount> <unit>" where amount is digits or a German word for "1"
  const match = s.match(/^vor\s+(\d+|einem|einer|eine)\s+(\w+)$/);
  if (!match) return null;
  const amount = /\d/.test(match[1]) ? parseInt(match[1], 10) : 1;
  const unit = match[2];
  let ms = 0;
  if (unit.startsWith('sekunde') || unit.startsWith('second')) ms = amount * 1000;
  else if (unit.startsWith('minute')) ms = amount * 60 * 1000;
  else if (unit.startsWith('stunde') || unit.startsWith('hour')) ms = amount * 60 * 60 * 1000;
  else if (unit.startsWith('tag') || unit.startsWith('day')) ms = amount * 24 * 60 * 60 * 1000;
  else if (unit.startsWith('woche') || unit.startsWith('week')) ms = amount * 7 * 24 * 60 * 60 * 1000;
  else if (unit.startsWith('monat') || unit.startsWith('month')) ms = amount * 30 * 24 * 60 * 60 * 1000;
  else if (unit.startsWith('jahr') || unit.startsWith('year')) ms = amount * 365 * 24 * 60 * 60 * 1000;
  else return null;
  return Date.now() - ms;
}

// Configuration for pagination
const PAGESIZE = 50;
const MAX_PAGES = 10; // Safety limit to prevent infinite loops
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 2000;

/**
 * Fetch a single page of listings from the ImmoScout mobile API.
 *
 * @param {string} url - The API URL with query parameters
 * @returns {Promise<{items: Array, totalResults: number}>}
 */
async function fetchPage(url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'ImmoScout_27.12_26.2_._',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      supportedResultListTypes: [],
      userData: {},
    }),
  });

  if (!response.ok) {
    logger.error('Error fetching data from ImmoScout Mobile API:', response.statusText);
    return { items: [], totalResults: 0 };
  }

  const responseBody = await response.json();
  return {
    items: responseBody.resultListItems || [],
    totalResults: responseBody.totalResults || 0,
  };
}

/**
 * Parse raw API items into listing objects, filtering out non-listing items.
 *
 * @param {Array} items - Raw items from the API
 * @param {string[]} [knownHashes] - Optional array of known listing hashes for early termination check
 * @returns {{listings: Array, filteredCount: number, filterSummary: Object, newCount: number}}
 */
function parseItems(items, knownHashes = []) {
  const exposeResults = items.filter((item) => item.type === 'EXPOSE_RESULT');
  const filteredOut = items.filter((item) => item.type !== 'EXPOSE_RESULT');

  const filterSummary = filteredOut.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});

  let newCount = 0;
  const listings = exposeResults.map((expose) => {
    const item = expose.item;
    const [price, size] = item.attributes;
    const image = item?.titlePicture?.preview ?? null;

    // Calculate hash to check if listing is already known
    const hash = buildHash(item.id, price?.value);
    if (!knownHashes.includes(hash)) {
      newCount++;
    }

    return {
      id: item.id,
      price: price?.value,
      size: size?.value,
      title: item.title,
      description: item.description,
      link: `${metaInformation.baseUrl}expose/${item.id}`,
      address: item.address?.line,
      image,
      publishedAt: parseRelativeTime(item.published),
    };
  });

  return { listings, filteredCount: filteredOut.length, filterSummary, newCount };
}

/**
 * Fetch all listings with pagination, rate limiting, and early termination.
 *
 * When knownHashes are provided, pagination stops early if a page contains
 * only already-known listings (assuming results are sorted by newest first).
 *
 * @param {string} baseUrl - The base API URL (with pagenumber=1)
 * @param {string[]} [knownHashes] - Optional array of known listing hashes for early termination
 * @returns {Promise<Array>} All listings across fetched pages
 */
async function getListings(baseUrl, knownHashes = []) {
  logger.debug(`ImmoScout fetching listings from: ${baseUrl}`);

  // Determine if early termination should be used
  const useEarlyTermination = !fullFetchMode && knownHashes.length > 0;

  if (fullFetchMode) {
    logger.debug(`ImmoScout full fetch mode enabled - will fetch all pages`);
  } else if (knownHashes.length > 0) {
    logger.debug(`ImmoScout early termination enabled with ${knownHashes.length} known hashes`);
  }

  const allListings = [];
  let totalFiltered = 0;
  const combinedFilterSummary = {};
  let page = 1;
  let totalResults = 0;
  let fetchedItems = 0;
  let consecutivePagesWithNoNew = 0;

  while (page <= MAX_PAGES) {
    // Update URL with current page number
    const url = baseUrl.replace(/pagenumber=\d+/, `pagenumber=${page}`);

    const { items, totalResults: total } = await fetchPage(url);

    if (page === 1) {
      totalResults = total;
      logger.debug(`ImmoScout search has ${totalResults} total results`);
    }

    if (items.length === 0) {
      break;
    }

    fetchedItems += items.length;
    const { listings, filteredCount, filterSummary, newCount } = parseItems(items, knownHashes);

    allListings.push(...listings);
    totalFiltered += filteredCount;

    // Merge filter summaries
    for (const [type, count] of Object.entries(filterSummary)) {
      combinedFilterSummary[type] = (combinedFilterSummary[type] || 0) + count;
    }

    logger.debug(
      `ImmoScout page ${page}: ${items.length} items, ${listings.length} listings, ${newCount} new, ${filteredCount} filtered`,
    );

    // Early termination: stop if this page has no new listings (unless fullFetchMode)
    if (useEarlyTermination && newCount === 0) {
      consecutivePagesWithNoNew++;
      if (consecutivePagesWithNoNew >= 1) {
        logger.debug(`ImmoScout stopping early: page ${page} has no new listings`);
        break;
      }
    } else {
      consecutivePagesWithNoNew = 0;
    }

    // Check if we've fetched all results
    if (fetchedItems >= totalResults || items.length < PAGESIZE) {
      break;
    }

    // Rate limiting before next page
    page++;
    if (page <= MAX_PAGES && fetchedItems < totalResults) {
      const delay = randomBetween(MIN_DELAY_MS, MAX_DELAY_MS);
      logger.debug(`ImmoScout waiting ${delay}ms before fetching page ${page}`);
      await sleep(delay);
    }
  }

  // Log summary
  logger.debug(
    `ImmoScout completed: ${allListings.length} listings from ${page} page(s), ${totalFiltered} items filtered`,
  );
  if (totalFiltered > 0) {
    logger.debug(`ImmoScout filtered item types: ${JSON.stringify(combinedFilterSummary)}`);
  }

  return allListings;
}

async function isListingActive(link) {
  const result = await fetch(convertImmoscoutListingToMobileListing(link), {
    headers: {
      'User-Agent': 'ImmoScout_27.12_26.2_._',
    },
  });

  if (result.status === 200) {
    return 1;
  }

  if (result.status === 404) {
    return 0;
  }

  logger.warn('Unknown status for immoscout listing', link);
  return -1;
}

function nullOrEmpty(val) {
  return val == null || val.length === 0;
}
function normalize(o) {
  const title = nullOrEmpty(o.title) ? 'NO TITLE FOUND' : o.title.replace('NEU', '');
  const address = nullOrEmpty(o.address) ? 'NO ADDRESS FOUND' : (o.address || '').replace(/\(.*\),.*$/, '').trim();
  // Preserve original provider ID for detail fetching
  const providerId = o.id;
  const id = buildHash(o.id, o.price);
  return Object.assign(o, { id, title, address, providerId });
}
function applyBlacklist(o) {
  return !isOneOf(o.title, appliedBlackList);
}
const config = {
  url: null,
  crawlFields: {
    id: 'id',
    title: 'title',
    price: 'price',
    size: 'size',
    link: 'link',
    address: 'address',
  },
  // Not required - used by filter to remove and listings that failed to parse
  sortByDateParam: 'sorting=-firstactivation',
  normalize: normalize,
  filter: applyBlacklist,
  getListings: getListings,
  activeTester: isListingActive,
  getListingDetails: getListingDetails,
};
export const init = (sourceConfig, blacklist) => {
  config.enabled = sourceConfig.enabled;
  config.url = convertWebToMobile(sourceConfig.url);
  appliedBlackList = blacklist || [];
  fullFetchMode = sourceConfig.fullFetch || false;
};
export const metaInformation = {
  name: 'Immoscout',
  baseUrl: 'https://www.immobilienscout24.de/',
  id: 'immoscout',
};

export { config };
