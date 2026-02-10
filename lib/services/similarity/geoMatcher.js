/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Geographic matching for property similarity detection.
 * Uses Haversine distance calculation and proximity-based scoring.
 */

const EARTH_RADIUS_METERS = 6371000;

/**
 * Proximity score thresholds.
 * Maps maximum distance in meters to awarded points.
 */
const PROXIMITY_THRESHOLDS = [
  { maxDistance: 30, points: 20 },
  { maxDistance: 50, points: 15 },
  { maxDistance: 100, points: 10 },
  { maxDistance: 200, points: 5 },
];

/**
 * Calculate the great-circle distance between two points using the Haversine formula.
 *
 * @param {number} lat1 - Latitude of first point in degrees.
 * @param {number} lon1 - Longitude of first point in degrees.
 * @param {number} lat2 - Latitude of second point in degrees.
 * @param {number} lon2 - Longitude of second point in degrees.
 * @returns {number} Distance in meters.
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaPhi = toRad(lat2 - lat1);
  const deltaLambda = toRad(lon2 - lon1);

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(EARTH_RADIUS_METERS * c * 10) / 10;
}

/**
 * Calculate a similarity score based on geographic proximity.
 *
 * @param {number} lat1 - Latitude of first property.
 * @param {number} lon1 - Longitude of first property.
 * @param {number} lat2 - Latitude of second property.
 * @param {number} lon2 - Longitude of second property.
 * @returns {{ score: number, distance: number|null, confidence: string }} Geo similarity result.
 */
export function calculateGeoScore(lat1, lon1, lat2, lon2) {
  // Check if coordinates are available
  if (!isValidCoordinate(lat1, lon1) || !isValidCoordinate(lat2, lon2)) {
    return {
      score: 0,
      distance: null,
      confidence: 'none',
      reason: 'Missing coordinates',
    };
  }

  const distance = haversineDistance(lat1, lon1, lat2, lon2);

  // Find applicable threshold
  for (const threshold of PROXIMITY_THRESHOLDS) {
    if (distance <= threshold.maxDistance) {
      return {
        score: threshold.points,
        distance,
        confidence: distance <= 50 ? 'high' : 'medium',
        reason: `Within ${threshold.maxDistance}m`,
      };
    }
  }

  // Beyond all thresholds
  return {
    score: 0,
    distance,
    confidence: 'low',
    reason: `Distance ${Math.round(distance)}m exceeds threshold`,
  };
}

/**
 * Check if latitude and longitude form a valid coordinate pair.
 *
 * @param {number} lat - Latitude value.
 * @param {number} lon - Longitude value.
 * @returns {boolean} True if coordinates are valid.
 */
export function isValidCoordinate(lat, lon) {
  if (lat == null || lon == null) return false;
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (isNaN(lat) || isNaN(lon)) return false;

  // Valid latitude range: -90 to 90
  if (lat < -90 || lat > 90) return false;

  // Valid longitude range: -180 to 180
  if (lon < -180 || lon > 180) return false;

  // Check for zero coordinates (often indicates missing data)
  if (lat === 0 && lon === 0) return false;

  return true;
}

/**
 * Find listings within a specified radius of a point.
 *
 * @param {Object[]} listings - Array of listings with latitude/longitude properties.
 * @param {number} centerLat - Center latitude.
 * @param {number} centerLon - Center longitude.
 * @param {number} radiusMeters - Search radius in meters.
 * @returns {Object[]} Listings within radius, sorted by distance (ascending).
 */
export function findListingsWithinRadius(listings, centerLat, centerLon, radiusMeters) {
  if (!isValidCoordinate(centerLat, centerLon)) {
    return [];
  }

  const results = [];

  for (const listing of listings) {
    const lat = listing.latitude;
    const lon = listing.longitude;

    if (!isValidCoordinate(lat, lon)) {
      continue;
    }

    const distance = haversineDistance(centerLat, centerLon, lat, lon);

    if (distance <= radiusMeters) {
      results.push({
        ...listing,
        _distance: distance,
      });
    }
  }

  // Sort by distance (closest first)
  results.sort((a, b) => a._distance - b._distance);

  return results;
}

/**
 * Create a bounding box around a coordinate for quick filtering.
 * This is a rough approximation that works well for small areas.
 *
 * @param {number} lat - Center latitude.
 * @param {number} lon - Center longitude.
 * @param {number} radiusMeters - Radius in meters.
 * @returns {{ minLat: number, maxLat: number, minLon: number, maxLon: number }} Bounding box.
 */
export function createBoundingBox(lat, lon, radiusMeters) {
  // 1 degree of latitude is approximately 111,320 meters
  const latDelta = radiusMeters / 111320;

  // 1 degree of longitude varies by latitude
  const lonDelta = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}
