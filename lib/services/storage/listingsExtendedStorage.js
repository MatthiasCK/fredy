/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from './SqliteConnection.js';

/**
 * Get a single listing by its database ID with full details.
 *
 * @param {string} id - The listing database ID.
 * @returns {Object|null} The listing object or null if not found.
 */
export const getListingById = (id) => {
  const row = SqliteConnection.query(
    `SELECT l.*, j.name AS job_name
     FROM listings l
     LEFT JOIN jobs j ON j.id = l.job_id
     WHERE l.id = @id`,
    { id },
  )[0];

  if (!row) return null;

  // Parse JSON fields
  if (row.local_images) {
    try {
      row.local_images = JSON.parse(row.local_images);
    } catch {
      row.local_images = [];
    }
  }
  if (row.local_documents) {
    try {
      row.local_documents = JSON.parse(row.local_documents);
    } catch {
      row.local_documents = [];
    }
  }
  if (row.change_set) {
    try {
      row.change_set = JSON.parse(row.change_set);
    } catch {
      row.change_set = {};
    }
  }

  // Compute listing duration in days
  const publishBase = row.published_at || row.created_at;
  if (row.deactivated_at) {
    row.duration_days = Math.round((row.deactivated_at - publishBase) / 86400000);
  } else if (row.is_active === 1) {
    row.duration_days = Math.round((Date.now() - publishBase) / 86400000);
  } else {
    row.duration_days = null;
  }

  return row;
};

/**
 * Get the version history for a listing by following the previous_version_id chain.
 * Returns listings from newest to oldest.
 *
 * @param {string} id - The listing database ID to get history for.
 * @returns {Object[]} Array of listing objects representing version history.
 */
export const getVersionHistory = (id) => {
  const listing = getListingById(id);
  if (!listing) return [];

  const history = [listing];

  // Follow the chain backwards via previous_version_id
  let currentId = listing.previous_version_id;
  const visited = new Set([id]); // Prevent infinite loops

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const prev = getListingById(currentId);
    if (!prev) break;
    history.push(prev);
    currentId = prev.previous_version_id;
  }

  // Also find newer versions that reference this listing
  const newerVersions = SqliteConnection.query(`SELECT id FROM listings WHERE previous_version_id = @id`, { id });

  for (const newer of newerVersions) {
    if (!visited.has(newer.id)) {
      visited.add(newer.id);
      const newerListing = getListingById(newer.id);
      if (newerListing) {
        history.unshift(newerListing); // Add to beginning (newer)
      }
    }
  }

  return history;
};

/**
 * Find an existing listing with the same property identity within a job.
 * Used for version detection.
 *
 * @param {string} jobId - The job identifier.
 * @param {string} propertyIdentity - The computed property identity hash.
 * @param {string} [excludeHash] - Optional hash to exclude from results (the current listing).
 * @returns {Object|null} The most recent matching listing or null.
 */
export const findListingByPropertyIdentity = (jobId, propertyIdentity, excludeHash = null) => {
  if (!propertyIdentity) return null;

  const params = { jobId, propertyIdentity };
  let sql = `
    SELECT *
    FROM listings
    WHERE job_id = @jobId
      AND property_identity = @propertyIdentity
  `;

  if (excludeHash) {
    sql += ` AND hash != @excludeHash`;
    params.excludeHash = excludeHash;
  }

  sql += ` ORDER BY created_at DESC LIMIT 1`;

  const row = SqliteConnection.query(sql, params)[0];
  return row || null;
};
