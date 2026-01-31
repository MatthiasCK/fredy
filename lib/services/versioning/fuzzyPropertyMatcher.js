/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'crypto';

/**
 * Size bucket tolerance in square meters.
 * Listings within this range are considered to have "the same" size.
 */
const SIZE_BUCKET_TOLERANCE = 5;

/**
 * Normalizes a German address into tokens for fuzzy matching.
 * Handles common variations in street names, abbreviations, and formatting.
 *
 * @param {string} address - The raw address string.
 * @returns {string[]} Array of normalized address tokens.
 */
export function extractAddressTokens(address) {
  if (!address) return [];

  const normalized = address
    .toLowerCase()
    // Normalize German street abbreviations
    .replace(/str\./gi, 'strasse')
    .replace(/straße/gi, 'strasse')
    .replace(/platz\b/gi, 'platz')
    .replace(/weg\b/gi, 'weg')
    .replace(/allee\b/gi, 'allee')
    // Normalize umlauts
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    // Remove parenthetical content (like "(Westend)" district names)
    .replace(/\([^)]*\)/g, '')
    // Remove common noise words
    .replace(/\b(bei|am|im|an|der|die|das)\b/gi, '')
    // Remove special characters except alphanumeric and spaces
    .replace(/[^\w\s]/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  // Split into tokens and filter empty ones
  const tokens = normalized.split(' ').filter((t) => t.length > 0);

  // Sort tokens alphabetically for consistent hashing regardless of word order
  return tokens.sort();
}

/**
 * Rounds a size value to the nearest bucket for fuzzy matching.
 *
 * @param {number|string|null} size - The size value.
 * @returns {number|null} The size bucket or null if invalid.
 */
export function computeSizeBucket(size) {
  if (size == null) return null;

  let numericSize;
  if (typeof size === 'number') {
    numericSize = size;
  } else {
    // Extract numeric value from string like "70 m²"
    const cleaned = String(size).replace(/\./g, '').replace(',', '.');
    numericSize = parseFloat(cleaned);
  }

  if (isNaN(numericSize) || numericSize <= 0) return null;

  // Round to nearest bucket
  return Math.round(numericSize / SIZE_BUCKET_TOLERANCE) * SIZE_BUCKET_TOLERANCE;
}

/**
 * Computes a fuzzy identity hash for a listing based on normalized address tokens
 * and size bucket. This identity is more tolerant than the strict property identity
 * and is used to detect re-listings with minor variations.
 *
 * @param {Object} listing - The listing object.
 * @param {string} listing.address - The property address.
 * @param {string|number} [listing.size] - The property size (optional).
 * @returns {string|null} A 16-character hex hash or null if address is missing.
 */
export function computeFuzzyIdentity(listing) {
  if (!listing || !listing.address) {
    return null;
  }

  const tokens = extractAddressTokens(listing.address);
  if (tokens.length === 0) {
    return null;
  }

  const sizeBucket = computeSizeBucket(listing.size);
  const sizeStr = sizeBucket != null ? String(sizeBucket) : '';

  // Combine tokens with size bucket
  const input = `${tokens.join('|')}|${sizeStr}`;

  // Create a short hash for the identity
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash.substring(0, 16);
}

/**
 * Groups listings by their fuzzy identity.
 *
 * @param {Object[]} listings - Array of listings.
 * @returns {Map<string, Object[]>} Map from fuzzy identity to array of listings.
 */
export function groupByFuzzyIdentity(listings) {
  const groups = new Map();

  for (const listing of listings) {
    const identity = computeFuzzyIdentity(listing);
    if (!identity) continue;

    if (!groups.has(identity)) {
      groups.set(identity, []);
    }
    groups.get(identity).push(listing);
  }

  return groups;
}
