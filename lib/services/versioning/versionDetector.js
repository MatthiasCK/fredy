/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { computePropertyIdentity } from './propertyIdentity.js';
import { computeFuzzyIdentity, groupByFuzzyIdentity } from './fuzzyPropertyMatcher.js';
import { findListingByPropertyIdentity, findListingsByFuzzyIdentities } from '../storage/listingsExtendedStorage.js';
import { markListingAsSuperseded } from '../storage/listingsStorage.js';
import logger from '../logger.js';

/**
 * Detects if a listing is a new version of an existing property.
 * If a previous version is found, links them together and records price changes.
 *
 * @param {Object} listing - The new listing to check.
 * @param {string} jobId - The job ID for scoping the search.
 * @returns {Object} The listing with versioning information added.
 */
export function detectVersion(listing, jobId) {
  if (!listing) return listing;

  // Compute property identity
  const propertyIdentity = computePropertyIdentity(listing);
  if (!propertyIdentity) {
    return listing;
  }

  listing.propertyIdentity = propertyIdentity;

  // Look for existing listing with same property identity
  let existingListing = null;
  try {
    existingListing = findListingByPropertyIdentity(jobId, propertyIdentity, listing.id);
  } catch (error) {
    // Handle case where migration hasn't been run yet (column doesn't exist)
    if (error.code === 'SQLITE_ERROR' && error.message.includes('no such column')) {
      logger.debug('Version detection skipped: migration pending');
      return listing;
    }
    throw error;
  }

  if (!existingListing) {
    return listing;
  }

  // Found a potential previous version - check if there are actual changes
  const currentPrice = parsePrice(listing.price);
  const existingPrice = existingListing.price;

  // Link as version even if price/size are identical (re-listing detection)
  // This is a new version of the same property
  logger.debug(`Version detected for property at "${listing.address}": ` + `price ${existingPrice} -> ${currentPrice}`);

  listing.previousVersionId = existingListing.id;

  // Initialize or update change_set with price history
  const changeSet = listing.changeSet || {};
  const priceHistory = changeSet.priceHistory || [];

  // Add previous price to history if not already there
  if (existingListing.created_at && existingPrice != null) {
    const existingEntry = priceHistory.find((e) => e.date === existingListing.created_at);
    if (!existingEntry) {
      priceHistory.push({
        date: existingListing.created_at,
        price: existingPrice,
      });
    }
  }

  // Add current price to history
  priceHistory.push({
    date: Date.now(),
    price: currentPrice,
  });

  // Sort by date
  priceHistory.sort((a, b) => a.date - b.date);

  changeSet.priceHistory = priceHistory;
  listing.changeSet = changeSet;

  return listing;
}

/**
 * Process multiple listings for version detection.
 *
 * @param {Object[]} listings - Array of listings to process.
 * @param {string} jobId - The job ID for scoping.
 * @returns {Object[]} Listings with versioning information added.
 */
export function detectVersions(listings, jobId) {
  if (!Array.isArray(listings)) return listings;

  return listings.map((listing) => detectVersion(listing, jobId));
}

/**
 * Parse price from string or number format.
 *
 * @param {string|number} price - The price value.
 * @returns {number|null} Parsed price or null.
 */
function parsePrice(price) {
  if (price == null) return null;
  if (typeof price === 'number') return price;

  const cleaned = String(price).replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Detect version relationships with batch awareness.
 * This function handles the case where multiple listings for the same property
 * arrive in a single batch (before any are saved to the database).
 *
 * Algorithm:
 * 1. Compute fuzzy identities for all listings in the batch
 * 2. Group listings by fuzzy identity
 * 3. Within each group, sort by publishedAt (newest first)
 * 4. Link chain: each listing points to the next older one
 * 5. Query DB for existing entries with matching fuzzy identities
 * 6. Link the oldest batch item to the newest DB entry
 *
 * @param {Object[]} listings - Array of new listings to process.
 * @param {string} jobId - The job ID for scoping the search.
 * @returns {Object[]} Listings with versioning information added.
 */
export function detectVersionsWithBatchAwareness(listings, jobId) {
  if (!Array.isArray(listings) || listings.length === 0) {
    return listings;
  }

  // Step 1: Compute fuzzy identities for all listings
  for (const listing of listings) {
    listing.fuzzyIdentity = computeFuzzyIdentity(listing);
    // Also compute strict property identity for backwards compatibility
    listing.propertyIdentity = computePropertyIdentity(listing);
  }

  // Step 2: Group listings by fuzzy identity
  const groups = groupByFuzzyIdentity(listings);

  // Collect all fuzzy identities for DB lookup
  const allFuzzyIdentities = [...groups.keys()];

  // Step 3: Query DB for existing listings with matching fuzzy identities
  let dbMatches = new Map();
  if (allFuzzyIdentities.length > 0) {
    try {
      dbMatches = findListingsByFuzzyIdentities(jobId, allFuzzyIdentities);
    } catch (error) {
      // Handle case where migration hasn't been run yet
      if (error.code === 'SQLITE_ERROR' && error.message.includes('no such column')) {
        logger.debug('Batch version detection skipped: migration pending');
        // Fall back to single-listing detection
        return listings.map((listing) => detectVersion(listing, jobId));
      }
      throw error;
    }
  }

  // Step 4: Process each group
  for (const [fuzzyIdentity, groupListings] of groups.entries()) {
    if (groupListings.length === 1) {
      // Single listing in group - just link to DB if match exists
      const listing = groupListings[0];
      const dbMatch = dbMatches.get(fuzzyIdentity);
      if (dbMatch) {
        linkListingToExisting(listing, dbMatch);
      }
      continue;
    }

    // Multiple listings with same fuzzy identity - sort by publish date (newest first)
    groupListings.sort((a, b) => {
      const dateA = a.publishedAt || 0;
      const dateB = b.publishedAt || 0;
      return dateB - dateA; // Descending (newest first)
    });

    // Link chain within batch: each listing points to the next older one
    for (let i = 0; i < groupListings.length - 1; i++) {
      const newer = groupListings[i];
      const older = groupListings[i + 1];

      // Use a temporary marker that will be resolved after save
      // Store the older listing's hash for resolution
      newer._batchPreviousHash = older.id;

      logger.debug(
        `Batch version chain: "${newer.title?.substring(0, 30)}..." -> "${older.title?.substring(0, 30)}..."`,
      );
    }

    // Link the oldest batch item to the newest DB entry
    const oldestInBatch = groupListings[groupListings.length - 1];
    const dbMatch = dbMatches.get(fuzzyIdentity);
    if (dbMatch) {
      linkListingToExisting(oldestInBatch, dbMatch);
    }
  }

  // Process listings without fuzzy identity using single-listing detection
  const noIdentity = listings.filter((l) => !l.fuzzyIdentity);
  for (const listing of noIdentity) {
    detectVersion(listing, jobId);
  }

  return listings;
}

/**
 * Link a new listing to an existing DB listing as its previous version.
 *
 * @param {Object} listing - The new listing.
 * @param {Object} existingListing - The existing DB listing.
 */
function linkListingToExisting(listing, existingListing) {
  const currentPrice = parsePrice(listing.price);
  const existingPrice = existingListing.price;

  listing.previousVersionId = existingListing.id;

  // Mark the existing (older) listing as superseded - it will be hidden from overview
  markListingAsSuperseded(existingListing.id);

  logger.debug(`Version detected for property at "${listing.address}": ` + `price ${existingPrice} -> ${currentPrice}`);

  // Initialize or update change_set with price history
  const changeSet = listing.changeSet || {};
  const priceHistory = changeSet.priceHistory || [];

  // Add previous price to history if not already there
  if (existingListing.created_at && existingPrice != null) {
    const existingEntry = priceHistory.find((e) => e.date === existingListing.created_at);
    if (!existingEntry) {
      priceHistory.push({
        date: existingListing.created_at,
        price: existingPrice,
      });
    }
  }

  // Add current price to history
  if (currentPrice != null) {
    priceHistory.push({
      date: Date.now(),
      price: currentPrice,
    });
  }

  // Sort by date
  priceHistory.sort((a, b) => a.date - b.date);

  changeSet.priceHistory = priceHistory;
  listing.changeSet = changeSet;
}
