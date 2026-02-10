/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import restana from 'restana';
import { getListingById } from '../../services/storage/listingsExtendedStorage.js';
import { computeSimilarity, findSimilarListings } from '../../services/similarity/enhancedSimilarityScorer.js';
import * as manualLinkStorage from '../../services/similarity/manualLinkStorage.js';
import { isAdmin as isAdminFn } from '../security.js';
import logger from '../../services/logger.js';
import SqliteConnection from '../../services/storage/SqliteConnection.js';

/**
 * Check if the manual_property_links table exists.
 */
function manualLinksTableExists() {
  try {
    const row = SqliteConnection.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manual_property_links'",
    )[0];
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Safe wrapper for areListingsLinked that handles missing table.
 */
function areListingsLinked(id1, id2) {
  if (!manualLinksTableExists()) return false;
  try {
    return manualLinkStorage.areListingsLinked(id1, id2);
  } catch (error) {
    logger.debug('Error checking linked status:', error.message);
    return false;
  }
}

const service = restana();
const similarityRouter = service.newRouter();

/**
 * Get similar listings for a given listing ID.
 * Uses enhanced multi-factor similarity scoring.
 *
 * Query params:
 * - minScore: Minimum similarity score (0-100), default 50
 * - maxResults: Maximum number of results, default 10
 * - jobScope: 'same' (same job only) or 'all' (cross-job), default 'all'
 */
similarityRouter.get('/similar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { minScore = 50, maxResults = 10, jobScope = 'all' } = req.query || {};

    if (!id) {
      res.statusCode = 400;
      res.body = { message: 'Listing ID is required' };
      return res.send();
    }

    // Get the target listing
    const targetListing = getListingById(id);
    if (!targetListing) {
      res.statusCode = 404;
      res.body = { message: 'Listing not found' };
      return res.send();
    }

    // Get candidate listings for comparison
    const candidates = getCandidateListings(targetListing, {
      jobScope,
      userId: req.session.currentUser,
      isAdmin: isAdminFn(req),
    });

    // Find similar listings
    const similar = findSimilarListings(targetListing, candidates, {
      minScore: parseInt(minScore, 10) || 50,
      maxResults: parseInt(maxResults, 10) || 10,
    });

    // Check which results are already manually linked
    const results = similar.map((match) => ({
      listing: formatListingForResponse(match.listing),
      similarity: match.similarity,
      isLinked: areListingsLinked(id, match.listing.id) || areListingsLinked(id, match.listing.hash),
    }));

    res.body = {
      targetListing: formatListingForResponse(targetListing),
      similar: results,
      totalCandidates: candidates.length,
    };
  } catch (error) {
    logger.error('Error finding similar listings:', error);
    res.statusCode = 500;
    res.body = { message: 'Failed to find similar listings' };
  }
  res.send();
});

/**
 * Compare two specific listings for similarity.
 *
 * Query params:
 * - id1: First listing ID
 * - id2: Second listing ID
 */
similarityRouter.get('/compare', async (req, res) => {
  try {
    const { id1, id2 } = req.query || {};

    if (!id1 || !id2) {
      res.statusCode = 400;
      res.body = { message: 'Both listing IDs (id1, id2) are required' };
      return res.send();
    }

    const listing1 = getListingById(id1);
    const listing2 = getListingById(id2);

    if (!listing1) {
      res.statusCode = 404;
      res.body = { message: `Listing ${id1} not found` };
      return res.send();
    }

    if (!listing2) {
      res.statusCode = 404;
      res.body = { message: `Listing ${id2} not found` };
      return res.send();
    }

    const similarity = computeSimilarity(listing1, listing2);
    const isLinked = areListingsLinked(id1, id2);

    res.body = {
      listing1: formatListingForResponse(listing1),
      listing2: formatListingForResponse(listing2),
      similarity,
      isLinked,
    };
  } catch (error) {
    logger.error('Error comparing listings:', error);
    res.statusCode = 500;
    res.body = { message: 'Failed to compare listings' };
  }
  res.send();
});

/**
 * Create a manual link between two listings.
 *
 * Body:
 * - listingId: First listing ID
 * - linkedListingId: Second listing ID
 */
similarityRouter.post('/link', async (req, res) => {
  try {
    const { listingId, linkedListingId } = req.body || {};
    const userId = req.session?.currentUser;

    if (!listingId || !linkedListingId) {
      res.statusCode = 400;
      res.body = { message: 'Both listingId and linkedListingId are required' };
      return res.send();
    }

    if (!manualLinksTableExists()) {
      res.statusCode = 503;
      res.body = { message: 'Manual linking feature not available. Please run database migrations.' };
      return res.send();
    }

    const result = manualLinkStorage.createManualLink(listingId, linkedListingId, userId);

    if (!result.success) {
      res.statusCode = 400;
      res.body = { message: result.error || 'Failed to create link' };
      return res.send();
    }

    res.body = {
      success: true,
      linkId: result.linkId,
      alreadyExists: result.alreadyExists || false,
    };
  } catch (error) {
    logger.error('Error creating manual link:', error);
    res.statusCode = 500;
    res.body = { message: 'Failed to create link' };
  }
  res.send();
});

/**
 * Remove a manual link between two listings.
 *
 * Body:
 * - listingId: First listing ID
 * - linkedListingId: Second listing ID
 */
similarityRouter.delete('/link', async (req, res) => {
  try {
    const { listingId, linkedListingId } = req.body || {};

    if (!listingId || !linkedListingId) {
      res.statusCode = 400;
      res.body = { message: 'Both listingId and linkedListingId are required' };
      return res.send();
    }

    if (!manualLinksTableExists()) {
      res.body = { success: true, removed: false };
      return res.send();
    }

    const result = manualLinkStorage.removeManualLink(listingId, linkedListingId);

    res.body = {
      success: true,
      removed: result.removed,
    };
  } catch (error) {
    logger.error('Error removing manual link:', error);
    res.statusCode = 500;
    res.body = { message: 'Failed to remove link' };
  }
  res.send();
});

/**
 * Get all manually linked listings for a given listing.
 */
similarityRouter.get('/linked/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      res.statusCode = 400;
      res.body = { message: 'Listing ID is required' };
      return res.send();
    }

    if (!manualLinksTableExists()) {
      res.body = { linkedListings: [] };
      return res.send();
    }

    const linkedListings = manualLinkStorage.getLinkedListings(id);

    res.body = {
      linkedListings: linkedListings.map(formatListingForResponse),
    };
  } catch (error) {
    logger.error('Error getting linked listings:', error);
    res.statusCode = 500;
    res.body = { message: 'Failed to get linked listings' };
  }
  res.send();
});

/**
 * Get candidate listings for similarity comparison.
 *
 * @param {Object} targetListing - The listing to find matches for.
 * @param {Object} options - Query options.
 * @returns {Object[]} Array of candidate listings.
 */
function getCandidateListings(targetListing, { jobScope = 'all', userId = null, isAdmin = false } = {}) {
  const params = { userId: userId || '__NO_USER__' };
  const whereParts = ['l.manually_deleted = 0'];

  // Exclude the target listing itself
  params.excludeId = targetListing.id;
  params.excludeHash = targetListing.hash;
  whereParts.push('l.id != @excludeId');
  whereParts.push('(l.hash IS NULL OR l.hash != @excludeHash)');

  // Scope to same job if requested
  if (jobScope === 'same' && targetListing.job_id) {
    params.jobId = targetListing.job_id;
    whereParts.push('l.job_id = @jobId');
  }

  // Apply user permissions
  if (!isAdmin) {
    whereParts.push(
      `(j.user_id = @userId OR EXISTS (SELECT 1 FROM json_each(j.shared_with_user) AS sw WHERE sw.value = @userId))`,
    );
  }

  // Build query
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const candidates = SqliteConnection.query(
    `SELECT l.*, COALESCE(j.name, l.job_name) AS job_name
     FROM listings l
     LEFT JOIN jobs j ON j.id = l.job_id
     ${whereSql}
     ORDER BY l.created_at DESC
     LIMIT 500`,
    params,
  );

  return candidates;
}

/**
 * Format a listing for API response.
 *
 * @param {Object} listing - The listing object.
 * @returns {Object} Formatted listing.
 */
function formatListingForResponse(listing) {
  if (!listing) return null;

  return {
    id: listing.id,
    hash: listing.hash,
    title: listing.title,
    address: listing.address,
    price: listing.price,
    size: listing.size,
    rooms: listing.rooms,
    provider: listing.provider,
    job_name: listing.job_name,
    image_url: listing.image_url,
    link: listing.link,
    latitude: listing.latitude,
    longitude: listing.longitude,
    is_active: listing.is_active,
    created_at: listing.created_at,
    published_at: listing.published_at,
  };
}

export { similarityRouter };
