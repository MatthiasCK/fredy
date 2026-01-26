/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'crypto';

/**
 * Normalizes a German address for comparison purposes.
 * Handles common variations in street names and formatting.
 *
 * @param {string} address - The raw address string.
 * @returns {string} Normalized address string.
 */
export function normalizeAddress(address) {
  if (!address) return '';

  return (
    address
      .toLowerCase()
      // Normalize street abbreviations
      .replace(/str\./gi, 'strasse')
      .replace(/straße/gi, 'strasse')
      .replace(/platz\b/gi, 'pl')
      .replace(/weg\b/gi, 'wg')
      .replace(/allee\b/gi, 'al')
      // Normalize umlauts
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      // Remove extra whitespace
      .replace(/\s+/g, ' ')
      // Remove non-alphanumeric characters except spaces
      .replace(/[^\w\s]/g, '')
      .trim()
  );
}

/**
 * Computes a property identity hash based on normalized address and size.
 * This identity is used to detect different versions of the same property.
 *
 * @param {Object} listing - The listing object.
 * @param {string} listing.address - The property address.
 * @param {string|number} [listing.size] - The property size (optional).
 * @returns {string|null} A 16-character hex hash or null if address is missing.
 */
export function computePropertyIdentity(listing) {
  if (!listing || !listing.address) {
    return null;
  }

  const normalizedAddress = normalizeAddress(listing.address);
  if (!normalizedAddress) {
    return null;
  }

  // Combine address with size for uniqueness
  const sizeStr = listing.size != null ? String(listing.size) : '';
  const input = `${normalizedAddress}|${sizeStr}`;

  // Create a short hash for the identity
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash.substring(0, 16);
}

/**
 * Checks if two listings represent the same property based on their identities.
 *
 * @param {Object} listing1 - First listing.
 * @param {Object} listing2 - Second listing.
 * @returns {boolean} True if the listings appear to be the same property.
 */
export function isSameProperty(listing1, listing2) {
  const identity1 = computePropertyIdentity(listing1);
  const identity2 = computePropertyIdentity(listing2);

  if (!identity1 || !identity2) {
    return false;
  }

  return identity1 === identity2;
}
