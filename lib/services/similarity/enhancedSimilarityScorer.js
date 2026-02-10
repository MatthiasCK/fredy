/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Enhanced multi-factor similarity scoring for property matching.
 * Combines address, size, geographic, room count, and price factors.
 */

import { compareAddresses } from './addressNormalizer.js';
import { calculateGeoScore } from './geoMatcher.js';

/**
 * Factor weights for the overall similarity score (total: 100).
 */
const FACTOR_WEIGHTS = {
  address: 40,
  size: 20,
  geo: 20,
  rooms: 10,
  price: 10,
};

/**
 * Confidence thresholds.
 */
const CONFIDENCE_THRESHOLDS = {
  high: 80,
  medium: 60,
  low: 40,
};

/**
 * Calculate overall similarity between two listings.
 *
 * @param {Object} listing1 - First listing.
 * @param {Object} listing2 - Second listing.
 * @returns {{
 *   score: number,
 *   confidence: 'high'|'medium'|'low'|'none',
 *   factors: Object,
 *   recommendation: string
 * }} Detailed similarity result.
 */
export function computeSimilarity(listing1, listing2) {
  const factors = {};
  let totalScore = 0;

  // Factor 1: Address matching (40 points max)
  const addressResult = calculateAddressScore(listing1, listing2);
  factors.address = addressResult;
  totalScore += addressResult.points;

  // Factor 2: Size matching (20 points max)
  const sizeResult = calculateSizeScore(listing1, listing2);
  factors.size = sizeResult;
  totalScore += sizeResult.points;

  // Factor 3: Geographic proximity (20 points max)
  const geoResult = calculateGeoSimilarityScore(listing1, listing2);
  factors.geo = geoResult;
  totalScore += geoResult.points;

  // Factor 4: Room count (10 points max)
  const roomResult = calculateRoomScore(listing1, listing2);
  factors.rooms = roomResult;
  totalScore += roomResult.points;

  // Factor 5: Price similarity (10 points max)
  const priceResult = calculatePriceScore(listing1, listing2);
  factors.price = priceResult;
  totalScore += priceResult.points;

  // Calculate confidence level
  const confidence = calculateConfidence(totalScore, factors);

  // Generate recommendation
  const recommendation = generateRecommendation(totalScore, confidence, factors);

  return {
    score: Math.round(totalScore),
    confidence,
    factors,
    recommendation,
  };
}

/**
 * Calculate address similarity score.
 *
 * @param {Object} listing1 - First listing.
 * @param {Object} listing2 - Second listing.
 * @returns {{ points: number, details: Object }} Address score details.
 */
function calculateAddressScore(listing1, listing2) {
  const maxPoints = FACTOR_WEIGHTS.address;

  const address1 = listing1.address;
  const address2 = listing2.address;

  if (!address1 || !address2) {
    return {
      points: 0,
      available: false,
      reason: 'Missing address data',
    };
  }

  const comparison = compareAddresses(address1, address2);

  // Scale the address comparison score (0-100) to our max points
  const points = Math.round((comparison.score / 100) * maxPoints);

  return {
    points,
    available: true,
    score: comparison.score,
    details: comparison.details,
    address1: comparison.parsed1,
    address2: comparison.parsed2,
  };
}

/**
 * Calculate size similarity score using percentage-based tolerance.
 *
 * @param {Object} listing1 - First listing.
 * @param {Object} listing2 - Second listing.
 * @returns {{ points: number, details: Object }} Size score details.
 */
function calculateSizeScore(listing1, listing2) {
  const maxPoints = FACTOR_WEIGHTS.size;

  const size1 = parseSize(listing1.size);
  const size2 = parseSize(listing2.size);

  if (size1 == null || size2 == null) {
    return {
      points: 0,
      available: false,
      reason: 'Missing size data',
    };
  }

  // Calculate percentage difference
  const avgSize = (size1 + size2) / 2;
  const percentDiff = Math.abs(size1 - size2) / avgSize;

  // Scoring:
  // - Within 5%: full points
  // - Within 10%: 80% of points
  // - Within 15%: 50% of points
  // - Beyond 15%: 0 points
  let points = 0;
  let match = 'none';

  if (percentDiff <= 0.05) {
    points = maxPoints;
    match = 'exact';
  } else if (percentDiff <= 0.1) {
    points = Math.round(maxPoints * 0.8);
    match = 'close';
  } else if (percentDiff <= 0.15) {
    points = Math.round(maxPoints * 0.5);
    match = 'approximate';
  }

  return {
    points,
    available: true,
    size1,
    size2,
    percentDiff: Math.round(percentDiff * 100),
    match,
  };
}

/**
 * Calculate geographic similarity score.
 *
 * @param {Object} listing1 - First listing.
 * @param {Object} listing2 - Second listing.
 * @returns {{ points: number, details: Object }} Geo score details.
 */
function calculateGeoSimilarityScore(listing1, listing2) {
  const lat1 = listing1.latitude;
  const lon1 = listing1.longitude;
  const lat2 = listing2.latitude;
  const lon2 = listing2.longitude;

  const geoResult = calculateGeoScore(lat1, lon1, lat2, lon2);

  return {
    points: geoResult.score,
    available: geoResult.distance != null,
    distance: geoResult.distance,
    reason: geoResult.reason,
  };
}

/**
 * Calculate room count similarity score.
 *
 * @param {Object} listing1 - First listing.
 * @param {Object} listing2 - Second listing.
 * @returns {{ points: number, details: Object }} Room score details.
 */
function calculateRoomScore(listing1, listing2) {
  const maxPoints = FACTOR_WEIGHTS.rooms;

  const rooms1 = parseRooms(listing1.rooms);
  const rooms2 = parseRooms(listing2.rooms);

  if (rooms1 == null || rooms2 == null) {
    return {
      points: 0,
      available: false,
      reason: 'Missing room data',
    };
  }

  const diff = Math.abs(rooms1 - rooms2);

  // Scoring:
  // - Exact match: full points
  // - Within 0.5 difference: 80% of points
  // - Within 1 room difference: 50% of points
  // - Beyond 1 room: 0 points
  let points = 0;
  let match = 'none';

  if (diff === 0) {
    points = maxPoints;
    match = 'exact';
  } else if (diff <= 0.5) {
    points = Math.round(maxPoints * 0.8);
    match = 'close';
  } else if (diff <= 1) {
    points = Math.round(maxPoints * 0.5);
    match = 'approximate';
  }

  return {
    points,
    available: true,
    rooms1,
    rooms2,
    difference: diff,
    match,
  };
}

/**
 * Calculate price similarity score.
 *
 * @param {Object} listing1 - First listing.
 * @param {Object} listing2 - Second listing.
 * @returns {{ points: number, details: Object }} Price score details.
 */
function calculatePriceScore(listing1, listing2) {
  const maxPoints = FACTOR_WEIGHTS.price;

  const price1 = parsePrice(listing1.price);
  const price2 = parsePrice(listing2.price);

  if (price1 == null || price2 == null) {
    return {
      points: 0,
      available: false,
      reason: 'Missing price data',
    };
  }

  // Calculate percentage difference
  const avgPrice = (price1 + price2) / 2;
  const percentDiff = Math.abs(price1 - price2) / avgPrice;

  // Scoring:
  // - Within 5%: full points
  // - Within 10%: 80% of points
  // - Within 20%: 50% of points
  // - Beyond 20%: 0 points (different price points)
  let points = 0;
  let match = 'none';

  if (percentDiff <= 0.05) {
    points = maxPoints;
    match = 'exact';
  } else if (percentDiff <= 0.1) {
    points = Math.round(maxPoints * 0.8);
    match = 'close';
  } else if (percentDiff <= 0.2) {
    points = Math.round(maxPoints * 0.5);
    match = 'approximate';
  }

  return {
    points,
    available: true,
    price1,
    price2,
    percentDiff: Math.round(percentDiff * 100),
    match,
  };
}

/**
 * Determine overall confidence level.
 *
 * @param {number} totalScore - Total similarity score.
 * @param {Object} factors - Individual factor results.
 * @returns {'high'|'medium'|'low'|'none'} Confidence level.
 */
function calculateConfidence(totalScore, factors) {
  // Count available factors
  const availableFactors = Object.values(factors).filter((f) => f.available !== false).length;

  // Need at least 3 factors for high confidence
  if (availableFactors < 3) {
    if (totalScore >= CONFIDENCE_THRESHOLDS.medium) {
      return 'medium';
    }
    return 'low';
  }

  // Check for strong geo + address match (very reliable)
  const hasStrongGeo = factors.geo.available && factors.geo.distance != null && factors.geo.distance <= 50;
  const hasStrongAddress = factors.address.available && factors.address.score >= 80;

  if (hasStrongGeo && hasStrongAddress) {
    if (totalScore >= CONFIDENCE_THRESHOLDS.medium) {
      return 'high';
    }
  }

  // Standard confidence based on score
  if (totalScore >= CONFIDENCE_THRESHOLDS.high) {
    return 'high';
  }
  if (totalScore >= CONFIDENCE_THRESHOLDS.medium) {
    return 'medium';
  }
  if (totalScore >= CONFIDENCE_THRESHOLDS.low) {
    return 'low';
  }

  return 'none';
}

/**
 * Generate a human-readable recommendation.
 *
 * @param {number} score - Total score.
 * @param {string} confidence - Confidence level.
 * @returns {string} Recommendation text.
 */
function generateRecommendation(score, confidence) {
  if (confidence === 'high' && score >= 80) {
    return 'Very likely the same property. Auto-linking recommended.';
  }

  if (confidence === 'high' || (confidence === 'medium' && score >= 70)) {
    return 'Likely the same property. Manual review recommended.';
  }

  if (confidence === 'medium' && score >= 50) {
    return 'Possibly the same property. User verification needed.';
  }

  if (score >= 40) {
    return 'Some similarities detected. Manual comparison advised.';
  }

  return 'Unlikely to be the same property.';
}

/**
 * Parse size value from various formats.
 *
 * @param {string|number|null} size - Size value.
 * @returns {number|null} Parsed size in square meters.
 */
function parseSize(size) {
  if (size == null) return null;
  if (typeof size === 'number') return size;

  // Extract numeric value from strings like "70 m²", "70,5m2", "70.5"
  const cleaned = String(size)
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) || num <= 0 ? null : num;
}

/**
 * Parse room count from various formats.
 *
 * @param {string|number|null} rooms - Room count value.
 * @returns {number|null} Parsed room count.
 */
function parseRooms(rooms) {
  if (rooms == null) return null;
  if (typeof rooms === 'number') return rooms;

  // Handle formats like "3", "3.5", "3,5", "3 Zimmer"
  const cleaned = String(rooms)
    .replace(',', '.')
    .replace(/[^\d.]/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) || num <= 0 ? null : num;
}

/**
 * Parse price from various formats.
 *
 * @param {string|number|null} price - Price value.
 * @returns {number|null} Parsed price.
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
 * Find similar listings from a collection.
 *
 * @param {Object} targetListing - The listing to find matches for.
 * @param {Object[]} candidates - Array of candidate listings.
 * @param {{ minScore?: number, maxResults?: number }} options - Search options.
 * @returns {Object[]} Array of matches with similarity scores.
 */
export function findSimilarListings(targetListing, candidates, options = {}) {
  const { minScore = 50, maxResults = 10 } = options;

  const results = [];

  for (const candidate of candidates) {
    // Skip self-comparison
    if (candidate.id === targetListing.id || candidate.hash === targetListing.hash) {
      continue;
    }

    const similarity = computeSimilarity(targetListing, candidate);

    if (similarity.score >= minScore) {
      results.push({
        listing: candidate,
        similarity,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.similarity.score - a.similarity.score);

  // Limit results
  return results.slice(0, maxResults);
}
