/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { NoNewListingsWarning } from './errors.js';
import {
  storeListings,
  getKnownListingHashesForJobAndProvider,
  resolveBatchVersionChains,
  markAllVersionsAsSuperseded,
} from './services/storage/listingsStorage.js';
import { getJob } from './services/storage/jobStorage.js';
import * as notify from './notification/notify.js';
import Extractor from './services/extractor/extractor.js';
import urlModifier from './services/queryStringMutator.js';
import logger from './services/logger.js';
import { sleep, randomBetween } from './utils.js';
import { geocodeAddress } from './services/geocoding/geoCodingService.js';
import { detectVersionsWithBatchAwareness } from './services/versioning/versionDetector.js';
import { downloadListingMedia } from './services/media/mediaDownloader.js';
import { distanceMeters } from './services/listings/distanceCalculator.js';
import { getUserSettings } from './services/storage/settingsStorage.js';
import { updateListingDistance } from './services/storage/listingsStorage.js';

/**
 * @typedef {Object} Listing
 * @property {string} id Stable unique identifier (hash) of the listing.
 * @property {string} title Title or headline of the listing.
 * @property {string} [address] Optional address/location text.
 * @property {string} [price] Optional price text/value.
 * @property {string} [url] Link to the listing detail page.
 * @property {any} [meta] Provider-specific additional metadata.
 */

/**
 * @typedef {Object} SimilarityCache
 * @property {(title:string, address?:string)=>boolean} hasSimilarEntries Returns true if a similar entry is known.
 * @property {(title:string, address?:string)=>void} addCacheEntry Adds a new entry to the similarity cache.
 */

/**
 * Runtime orchestrator for fetching, normalizing, filtering, deduplicating, storing,
 * and notifying about new listings from a configured provider.
 *
 * The execution flow is:
 * 1) Prepare provider URL (sorting, etc.)
 * 2) Extract raw listings from the provider
 * 3) Normalize listings to the provider schema
 * 4) Filter out incomplete/blacklisted listings
 * 5) Identify new listings (vs. previously stored hashes)
 * 6) Persist new listings
 * 7) Filter out entries similar to already seen ones
 * 8) Dispatch notifications
 */
class FredyPipelineExecutioner {
  /**
   * Create a new runtime instance for a single provider/job execution.
   *
   * @param {Object} providerConfig Provider configuration.
   * @param {string} providerConfig.url Base URL to crawl.
   * @param {string} [providerConfig.sortByDateParam] Query parameter used to enforce sorting by date (provider-specific).
   * @param {string} [providerConfig.waitForSelector] CSS selector to wait for before parsing content.
   * @param {Object.<string, string>} providerConfig.crawlFields Mapping of field names to selectors/paths to extract.
   * @param {string} providerConfig.crawlContainer CSS selector for the container holding listing items.
   * @param {(raw:any)=>Listing} providerConfig.normalize Function to convert raw scraped data into a Listing shape.
   * @param {(listing:Listing)=>boolean} providerConfig.filter Function to filter out unwanted listings.
   * @param {(url:string, waitForSelector?:string)=>Promise<void>|Promise<Listing[]>} [providerConfig.getListings] Optional override to fetch listings.
   *
   * @param {Object} notificationConfig Notification configuration passed to notification adapters.
   * @param {string} providerId The ID of the provider currently in use.
   * @param {string} jobKey Key of the job that is currently running (from within the config).
   * @param {SimilarityCache} similarityCache Cache instance for checking similar entries.
   */
  constructor(providerConfig, notificationConfig, providerId, jobKey, similarityCache) {
    this._providerConfig = providerConfig;
    this._notificationConfig = notificationConfig;
    this._providerId = providerId;
    this._jobKey = jobKey;
    this._similarityCache = similarityCache;
  }

  /**
   * Execute the end-to-end pipeline for a single provider run.
   *
   * @returns {Promise<Listing[]|void>} Resolves to the list of new (and similarity-filtered) listings
   * after notifications have been sent; resolves to void when there are no new listings.
   */
  execute() {
    return Promise.resolve(urlModifier(this._providerConfig.url, this._providerConfig.sortByDateParam))
      .then(this._fetchListingsWithKnownHashes.bind(this))
      .then(this._normalize.bind(this))
      .then(this._filter.bind(this))
      .then(this._findNew.bind(this))
      .then(this._geocode.bind(this))
      .then(this._enrichWithDetails.bind(this))
      .then(this._downloadMedia.bind(this))
      .then(this._detectVersions.bind(this))
      .then(this._save.bind(this))
      .then(this._calculateDistance.bind(this))
      .then(this._filterBySimilarListings.bind(this))
      .then(this._notify.bind(this))
      .catch(this._handleError.bind(this));
  }

  /**
   * Geocode new listings.
   *
   * @param {Listing[]} newListings New listings to geocode.
   * @returns {Promise<Listing[]>} Resolves with the listings (potentially with added coordinates).
   */
  async _geocode(newListings) {
    for (const listing of newListings) {
      if (listing.address) {
        const coords = await geocodeAddress(listing.address);
        if (coords) {
          listing.latitude = coords.lat;
          listing.longitude = coords.lng;
        }
      }
    }
    return newListings;
  }

  /**
   * Enrich listings with detailed information from the provider.
   * Only runs if the provider has a getListingDetails function.
   *
   * @param {Listing[]} newListings New listings to enrich.
   * @returns {Promise<Listing[]>} Resolves with enriched listings.
   */
  async _enrichWithDetails(newListings) {
    if (!this._providerConfig.getListingDetails) {
      return newListings;
    }

    logger.debug(`Enriching ${newListings.length} listings with details (Provider: '${this._providerId}')`);

    for (const listing of newListings) {
      try {
        // Use the preserved provider ID for detail fetching
        const listingId = listing.providerId || listing.id;
        if (!listingId) continue;

        const details = await this._providerConfig.getListingDetails(listingId);
        if (details) {
          // Merge extended fields
          if (details.rooms != null) listing.rooms = details.rooms;
          if (details.floor != null) listing.floor = details.floor;
          if (details.energyEfficiencyClass) listing.energyEfficiencyClass = details.energyEfficiencyClass;
          if (details.heatingType) listing.heatingType = details.heatingType;
          if (details.constructionYear) listing.constructionYear = details.constructionYear;

          // Merge additional images
          if (details.additionalImages && details.additionalImages.length > 0) {
            listing.additionalImages = details.additionalImages;
          }

          // Merge documents
          if (details.documents && details.documents.length > 0) {
            listing.documents = details.documents;
          }

          // Merge change_set
          if (details.changeSet) {
            listing.changeSet = { ...(listing.changeSet || {}), ...details.changeSet };
          }

          // Merge publish date
          if (details.publishedAt) listing.publishedAt = details.publishedAt;
        }

        // Rate limiting between detail fetches
        await sleep(randomBetween(500, 1500));
      } catch (error) {
        logger.debug(`Failed to enrich listing ${listing.id}: ${error.message}`);
      }
    }

    return newListings;
  }

  /**
   * Download media (images and documents) for new listings.
   *
   * @param {Listing[]} newListings New listings to download media for.
   * @returns {Promise<Listing[]>} Resolves with listings including local media paths.
   */
  async _downloadMedia(newListings) {
    for (const listing of newListings) {
      try {
        // Collect all image URLs (main image + additional images)
        const allImages = [listing.image, ...(listing.additionalImages || [])].filter(Boolean);
        const documents = listing.documents || [];

        if (allImages.length === 0 && documents.length === 0) {
          continue;
        }

        // Use the listing's hash as the unique identifier for the media folder
        const mediaId = listing.id || 'unknown';

        const { imagePaths, docPaths } = await downloadListingMedia(mediaId, allImages, documents);

        if (imagePaths.length > 0) {
          listing.localImages = imagePaths;
        }

        if (docPaths.length > 0) {
          listing.localDocuments = docPaths;
        }

        // Rate limiting between downloads
        await sleep(randomBetween(200, 500));
      } catch (error) {
        logger.debug(`Failed to download media for listing ${listing.id}: ${error.message}`);
      }
    }

    return newListings;
  }

  /**
   * Detect version relationships between new listings and existing ones.
   * Uses batch-aware detection to handle multiple versions of the same property
   * arriving in a single batch.
   *
   * @param {Listing[]} newListings New listings to check for versioning.
   * @returns {Listing[]} Listings with versioning information added.
   */
  _detectVersions(newListings) {
    logger.debug(`Detecting versions for ${newListings.length} listings (Provider: '${this._providerId}')`);
    return detectVersionsWithBatchAwareness(newListings, this._jobKey);
  }

  /**
   * Fetch listings with known hashes for early termination optimization.
   * Passes known listing hashes to providers that support it, allowing them
   * to stop pagination early when encountering only known listings.
   *
   * @param {string} url The provider URL to fetch from.
   * @returns {Promise<Listing[]>} Resolves with an array of listings.
   */
  _fetchListingsWithKnownHashes(url) {
    const knownHashes = getKnownListingHashesForJobAndProvider(this._jobKey, this._providerId) || [];
    logger.debug(`Fetching listings with ${knownHashes.length} known hashes (Provider: '${this._providerId}')`);

    if (this._providerConfig.getListings) {
      // Provider has custom getListings - pass known hashes as second argument
      return this._providerConfig.getListings.call(this, url, knownHashes);
    }
    // Use default extractor-based fetching (no early termination support)
    return this._getListings(url);
  }

  /**
   * Fetch listings from the provider, using the default Extractor flow unless
   * a provider-specific getListings override is supplied.
   *
   * @param {string} url The provider URL to fetch from.
   * @returns {Promise<Listing[]>} Resolves with an array of listings (empty when none found).
   */
  _getListings(url) {
    const extractor = new Extractor();
    return new Promise((resolve, reject) => {
      extractor
        .execute(url, this._providerConfig.waitForSelector)
        .then(() => {
          const listings = extractor.parseResponseText(
            this._providerConfig.crawlContainer,
            this._providerConfig.crawlFields,
            url,
          );
          resolve(listings == null ? [] : listings);
        })
        .catch((err) => {
          reject(err);
          logger.error(err);
        });
    });
  }

  /**
   * Normalize raw listings into the provider-specific Listing shape.
   *
   * @param {any[]} listings Raw listing entries from the extractor or override.
   * @returns {Listing[]} Normalized listings.
   */
  _normalize(listings) {
    return listings.map(this._providerConfig.normalize);
  }

  /**
   * Filter out listings that are missing required fields and those rejected by the
   * provider's blacklist/filter function.
   *
   * @param {Listing[]} listings Listings to filter.
   * @returns {Listing[]} Filtered listings that pass validation and provider filter.
   */
  _filter(listings) {
    const keys = Object.keys(this._providerConfig.crawlFields);
    const withRequiredFields = listings.filter((item) => keys.every((key) => key in item));
    const missingFields = listings.length - withRequiredFields.length;
    if (missingFields > 0) {
      logger.debug(`Filtered ${missingFields} listings missing required fields (Provider: '${this._providerId}')`);
    }

    const afterBlacklist = withRequiredFields.filter(this._providerConfig.filter);
    const blacklisted = withRequiredFields.length - afterBlacklist.length;
    if (blacklisted > 0) {
      logger.debug(`Filtered ${blacklisted} listings by blacklist (Provider: '${this._providerId}')`);
    }

    return afterBlacklist;
  }

  /**
   * Determine which listings are new by comparing their IDs against stored hashes.
   *
   * @param {Listing[]} listings Listings to evaluate for novelty.
   * @returns {Listing[]} New listings not seen before.
   * @throws {NoNewListingsWarning} When no new listings are found.
   */
  _findNew(listings) {
    logger.debug(`Checking ${listings.length} listings for new entries (Provider: '${this._providerId}')`);
    const hashes = getKnownListingHashesForJobAndProvider(this._jobKey, this._providerId) || [];

    const newListings = listings.filter((o) => !hashes.includes(o.id));
    const alreadyKnown = listings.length - newListings.length;
    if (alreadyKnown > 0) {
      logger.debug(`Skipped ${alreadyKnown} already known listings (Provider: '${this._providerId}')`);
    }
    if (newListings.length === 0) {
      throw new NoNewListingsWarning();
    }
    logger.debug(`Found ${newListings.length} new listings (Provider: '${this._providerId}')`);
    return newListings;
  }

  /**
   * Send notifications for new listings using the configured notification adapter(s).
   *
   * @param {Listing[]} newListings New listings to notify about.
   * @returns {Promise<Listing[]>} Resolves to the provided listings after notifications complete.
   * @throws {NoNewListingsWarning} When there are no listings to notify about.
   */
  _notify(newListings) {
    if (newListings.length === 0) {
      throw new NoNewListingsWarning();
    }
    const sendNotifications = notify.send(this._providerId, newListings, this._notificationConfig, this._jobKey);
    return Promise.all(sendNotifications).then(() => newListings);
  }

  /**
   * Persist new listings and pass them through.
   *
   * @param {Listing[]} newListings Listings to store.
   * @returns {Listing[]} The same listings, unchanged.
   */
  _save(newListings) {
    logger.debug(`Storing ${newListings.length} new listings (Provider: '${this._providerId}')`);
    storeListings(this._jobKey, this._providerId, newListings);

    // Resolve batch version chains after saving
    // This converts _batchPreviousHash markers to actual previousVersionId links
    resolveBatchVersionChains(this._jobKey, newListings);

    // Mark all older versions with the same fuzzy identity as superseded
    // This ensures only the newest version appears in the overview
    // Group by fuzzy identity and only mark superseded using the NEWEST listing in each group
    const listingsWithFuzzyId = newListings.filter((l) => l.fuzzyIdentity);
    if (listingsWithFuzzyId.length > 0) {
      // Find which hashes are referenced as previous versions (these are older)
      const referencedAsOlder = new Set(listingsWithFuzzyId.map((l) => l._batchPreviousHash).filter(Boolean));

      // Group by fuzzy identity
      const byFuzzyId = new Map();
      for (const listing of listingsWithFuzzyId) {
        if (!byFuzzyId.has(listing.fuzzyIdentity)) {
          byFuzzyId.set(listing.fuzzyIdentity, []);
        }
        byFuzzyId.get(listing.fuzzyIdentity).push(listing);
      }

      // For each group, find the newest (not referenced by others) and mark older versions
      for (const [fuzzyId, group] of byFuzzyId) {
        // The newest listing is the one not referenced as a previous version by any other
        const newest = group.find((l) => !referencedAsOlder.has(l.id)) || group[group.length - 1];
        markAllVersionsAsSuperseded(this._jobKey, fuzzyId, newest.id);
      }
    }

    return newListings;
  }

  /**
   * Calculate distance for new listings.
   *
   * @param {Listing[]} listings
   * @returns {Listing[]}
   * @private
   */
  _calculateDistance(listings) {
    if (listings.length === 0) return [];

    const job = getJob(this._jobKey);
    const userId = job?.userId;

    if (userId == null || typeof userId !== 'string') {
      logger.debug('Skipping distance calculation: userId is missing or invalid');
      return listings;
    }

    const userSettings = getUserSettings(userId);
    const homeAddress = userSettings?.home_address;

    if (!homeAddress || !homeAddress.coords) {
      return listings;
    }

    const { lat, lng } = homeAddress.coords;
    for (const listing of listings) {
      if (listing.latitude != null && listing.longitude != null) {
        const dist = distanceMeters(lat, lng, listing.latitude, listing.longitude);
        updateListingDistance(listing.id, dist);
        listing.distance_to_destination = dist;
      }
    }
    return listings;
  }

  /**
   * Remove listings that are similar to already known entries according to the similarity cache.
   * Adds the remaining listings to the cache.
   *
   * @param {Listing[]} listings Listings to filter by similarity.
   * @returns {Listing[]} Listings considered unique enough to keep.
   */
  _filterBySimilarListings(listings) {
    const filtered = listings.filter((listing) => {
      const similar = this._similarityCache.checkAndAddEntry({
        title: listing.title,
        address: listing.address,
        price: listing.price,
      });
      if (similar) {
        logger.debug(
          `Filtering similar entry for title '${listing.title}' and address '${listing.address}' (Provider: '${this._providerId}')`,
        );
      }
      return !similar;
    });
    const similarCount = listings.length - filtered.length;
    if (similarCount > 0) {
      logger.debug(`Filtered ${similarCount} similar listings (Provider: '${this._providerId}')`);
    }
    return filtered;
  }

  /**
   * Handle errors occurring in the pipeline, logging levels depending on type.
   *
   * @param {Error} err Error instance thrown by previous steps.
   * @returns {void}
   */
  _handleError(err) {
    if (err.name === 'NoNewListingsWarning') {
      logger.debug(`No new listings found (Provider: '${this._providerId}').`);
    } else {
      logger.error(err);
    }
  }
}

export default FredyPipelineExecutioner;
