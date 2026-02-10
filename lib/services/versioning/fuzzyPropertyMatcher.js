/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'crypto';

/**
 * Size tolerance as a percentage (5% tolerance).
 * Example: 200m² matches 190m²-210m² range.
 * Stricter than before to avoid matching different properties.
 */
const SIZE_TOLERANCE_PERCENT = 0.05;

/**
 * Geographic proximity threshold in meters.
 * Listings within this distance are considered potentially the same property.
 * Reduced from 100m to 30m to avoid matching nearby but different properties.
 */
const GEO_PROXIMITY_METERS = 30;

/**
 * Earth radius in meters for Haversine calculation.
 */
const EARTH_RADIUS_METERS = 6371000;

/**
 * Calculate Haversine distance between two coordinate pairs.
 *
 * @param {number} lat1 - Latitude of first point.
 * @param {number} lon1 - Longitude of first point.
 * @param {number} lat2 - Latitude of second point.
 * @param {number} lon2 - Longitude of second point.
 * @returns {number} Distance in meters.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Check if coordinates are valid.
 *
 * @param {number} lat - Latitude.
 * @param {number} lon - Longitude.
 * @returns {boolean} True if valid.
 */
function hasValidCoordinates(lat, lon) {
  return (
    lat != null &&
    lon != null &&
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    !isNaN(lat) &&
    !isNaN(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/**
 * Extract German ZIP code (PLZ) from address.
 *
 * @param {string} address - Address string.
 * @returns {string|null} 5-digit ZIP code or null.
 */
function extractZipCode(address) {
  if (!address) return null;
  const match = address.match(/(?:^|[\s,])(?:D-?|DE-?)?(\d{5})(?:[\s,]|$)/);
  return match ? match[1] : null;
}

/**
 * Extract house number from address.
 *
 * @param {string} address - Address string.
 * @returns {string|null} Normalized house number or null.
 */
function extractHouseNumber(address) {
  if (!address) return null;
  // Match patterns like: 12, 12a, 12-14, 12 a
  const match = address.match(/\s(\d+(?:\s?[a-zA-Z])?(?:\s?[-–/]\s?\d+(?:\s?[a-zA-Z])?)?)(?:\s|,|$)/);
  return match ? match[1].replace(/\s+/g, '').toLowerCase() : null;
}

/**
 * Normalizes a German address into tokens for fuzzy matching.
 * More aggressive normalization that handles common variations.
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
 * Parse numeric size from various formats.
 *
 * @param {number|string|null} size - The size value.
 * @returns {number|null} Numeric size or null.
 */
function parseSize(size) {
  if (size == null) return null;
  if (typeof size === 'number') return size;
  const cleaned = String(size).replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) || num <= 0 ? null : num;
}

/**
 * Check if two sizes are within tolerance.
 *
 * @param {number|string|null} size1 - First size.
 * @param {number|string|null} size2 - Second size.
 * @returns {boolean} True if sizes match within tolerance.
 */
function sizesMatch(size1, size2) {
  const s1 = parseSize(size1);
  const s2 = parseSize(size2);
  // Be conservative: require both sizes to be known for a match
  if (s1 == null || s2 == null) return false;
  const avg = (s1 + s2) / 2;
  const diff = Math.abs(s1 - s2) / avg;
  return diff <= SIZE_TOLERANCE_PERCENT;
}

/**
 * Rounds a size value to the nearest bucket for fuzzy matching.
 * Uses 3m² buckets for tighter matching.
 *
 * @param {number|string|null} size - The size value.
 * @returns {number|null} The size bucket or null if invalid.
 */
export function computeSizeBucket(size) {
  const numericSize = parseSize(size);
  if (numericSize == null) return null;

  // Use 3m² buckets for tight matching
  const bucketSize = 3;
  return Math.round(numericSize / bucketSize) * bucketSize;
}

/**
 * Parse price from various formats.
 *
 * @param {number|string|null} price - The price value.
 * @returns {number|null} Numeric price or null.
 */
function parsePrice(price) {
  if (price == null) return null;
  if (typeof price === 'number') return price;
  // Handle formats like "250.000 €", "250,000", "250000"
  const cleaned = String(price)
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) || num <= 0 ? null : num;
}

/**
 * Rounds a price value to the nearest bucket for fuzzy matching.
 * Uses 2% buckets (e.g., €500k rounds to nearest €10k).
 *
 * @param {number|string|null} price - The price value.
 * @returns {number|null} The price bucket or null if invalid.
 */
function computePriceBucket(price) {
  const numericPrice = parsePrice(price);
  if (numericPrice == null) return null;

  // Use 2% of price as bucket size, minimum 5000
  const bucketSize = Math.max(5000, Math.round((numericPrice * 0.02) / 1000) * 1000);
  return Math.round(numericPrice / bucketSize) * bucketSize;
}

/**
 * Computes a fuzzy identity hash for a listing based on multiple factors.
 * This identity is used to detect re-listings with minor variations.
 *
 * The identity is stricter than before to avoid false positives.
 * Requires multiple strong factors to match:
 * - Geo (rounded to ~30m) OR ZIP+house number
 * - Size bucket (3m² precision)
 * - Exact room count
 * - Price bucket (2% precision)
 *
 * @param {Object} listing - The listing object.
 * @returns {string|null} A 16-character hex hash or null if insufficient data.
 */
export function computeFuzzyIdentity(listing) {
  if (!listing) return null;

  const parts = [];

  // Method 1: Geo-based identity (most reliable)
  if (hasValidCoordinates(listing.latitude, listing.longitude)) {
    // Round coordinates to ~30m precision
    // At 50° latitude, 0.0003 degrees ≈ 25m
    const roundedLat = Math.round(listing.latitude * 3333) / 3333;
    const roundedLon = Math.round(listing.longitude * 3333) / 3333;
    parts.push(`geo:${roundedLat.toFixed(4)}:${roundedLon.toFixed(4)}`);
  }

  // Add ZIP code if available (very reliable for German addresses)
  const zipCode = extractZipCode(listing.address);
  if (zipCode) {
    parts.push(`plz:${zipCode}`);
  }

  // Add house number if available
  const houseNumber = extractHouseNumber(listing.address);
  if (houseNumber) {
    parts.push(`hn:${houseNumber}`);
  }

  // Add size bucket (required - be strict)
  const sizeBucket = computeSizeBucket(listing.size);
  if (sizeBucket != null) {
    parts.push(`size:${sizeBucket}`);
  }

  // Add exact rooms (required - no rounding to avoid matching different properties)
  if (listing.rooms != null && listing.rooms > 0) {
    parts.push(`rooms:${listing.rooms}`);
  }

  // Add price bucket (strong differentiator for different properties)
  const priceBucket = computePriceBucket(listing.price);
  if (priceBucket != null) {
    parts.push(`price:${priceBucket}`);
  }

  // Require at least 4 identifying factors to generate an identity
  // This prevents matching properties with insufficient data
  if (parts.length < 4) {
    return null;
  }

  // Create hash from combined parts
  const input = parts.sort().join('||');
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash.substring(0, 16);
}

/**
 * Check if two prices are within tolerance (5%).
 *
 * @param {number|string|null} price1 - First price.
 * @param {number|string|null} price2 - Second price.
 * @returns {boolean} True if prices match within tolerance.
 */
function pricesMatch(price1, price2) {
  const p1 = parsePrice(price1);
  const p2 = parsePrice(price2);
  // Be conservative: require both prices to be known for a match
  if (p1 == null || p2 == null) return false;
  const avg = (p1 + p2) / 2;
  const diff = Math.abs(p1 - p2) / avg;
  return diff <= 0.05; // 5% tolerance
}

/**
 * Check if two listings could represent the same property.
 * Uses multiple factors for comparison - stricter than before.
 *
 * Requires:
 * - Geographic proximity (30m) OR same ZIP + house number
 * - Size match (5% tolerance)
 * - Exact room count match
 * - Price match (5% tolerance)
 *
 * @param {Object} listing1 - First listing.
 * @param {Object} listing2 - Second listing.
 * @returns {boolean} True if listings appear to be the same property.
 */
export function couldBeSameProperty(listing1, listing2) {
  if (!listing1 || !listing2) return false;

  // Quick check: same hash means definitely same listing
  if (listing1.hash && listing2.hash && listing1.hash === listing2.hash) {
    return true;
  }

  // Check size match first (fast elimination)
  if (!sizesMatch(listing1.size, listing2.size)) {
    return false;
  }

  // Check room count - require exact match
  if (listing1.rooms != null && listing2.rooms != null) {
    if (listing1.rooms !== listing2.rooms) {
      return false; // Different room count = different properties
    }
  } else {
    // If rooms are unknown for either, be conservative
    return false;
  }

  // Check price match (strong differentiator)
  if (!pricesMatch(listing1.price, listing2.price)) {
    return false;
  }

  // Check ZIP code match
  const zip1 = extractZipCode(listing1.address);
  const zip2 = extractZipCode(listing2.address);
  if (zip1 && zip2 && zip1 !== zip2) {
    return false; // Different ZIP codes = different properties
  }

  // Check house number match
  const hn1 = extractHouseNumber(listing1.address);
  const hn2 = extractHouseNumber(listing2.address);
  if (hn1 && hn2 && hn1 !== hn2) {
    return false; // Different house numbers = different properties
  }

  // Check geocoordinates
  const hasGeo1 = hasValidCoordinates(listing1.latitude, listing1.longitude);
  const hasGeo2 = hasValidCoordinates(listing2.latitude, listing2.longitude);

  if (hasGeo1 && hasGeo2) {
    const distance = haversineDistance(listing1.latitude, listing1.longitude, listing2.latitude, listing2.longitude);
    // If within 30m, all other checks passed, very likely same property
    if (distance <= GEO_PROXIMITY_METERS) {
      return true;
    }
    // If more than 200m apart, definitely not the same
    if (distance > 200) {
      return false;
    }
  }

  // Final check: fuzzy identity match (requires 4+ factors)
  const identity1 = computeFuzzyIdentity(listing1);
  const identity2 = computeFuzzyIdentity(listing2);

  return identity1 && identity2 && identity1 === identity2;
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
