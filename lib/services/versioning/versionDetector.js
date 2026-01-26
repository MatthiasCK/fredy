/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { computePropertyIdentity } from './propertyIdentity.js';
import { findListingByPropertyIdentity } from '../storage/listingsExtendedStorage.js';
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

  const hasChanges = currentPrice !== existingPrice || parseSize(listing.size) !== existingListing.size;

  if (!hasChanges) {
    // Same property, same details - not a new version
    return listing;
  }

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
 * Parse size from string or number format.
 *
 * @param {string|number} size - The size value.
 * @returns {number|null} Parsed size or null.
 */
function parseSize(size) {
  if (size == null) return null;
  if (typeof size === 'number') return size;

  const cleaned = String(size).replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}
