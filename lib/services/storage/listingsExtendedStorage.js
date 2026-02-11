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
 * Get the version history for a listing by following the previous_version_id chain
 * AND including manually linked listings.
 * Returns listings from newest to oldest, with markers for link type.
 *
 * @param {string} id - The listing database ID to get history for.
 * @returns {Object[]} Array of listing objects representing version history.
 */
export const getVersionHistory = (id) => {
  const listing = getListingById(id);
  if (!listing) return [];

  const visited = new Set([id]); // Prevent infinite loops
  const allListings = [listing];

  // Check if manual_property_links table exists
  const manualLinksTableExists = (() => {
    try {
      const row = SqliteConnection.query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manual_property_links'",
      )[0];
      return !!row;
    } catch {
      return false;
    }
  })();

  // Helper to check if two listings are manually linked
  const areManuallyLinked = (id1, id2) => {
    if (!manualLinksTableExists) return false;
    const [first, second] = Number(id1) <= Number(id2) ? [id1, id2] : [id2, id1];
    const link = SqliteConnection.query(
      `SELECT 1 FROM manual_property_links WHERE listing_id = @first AND linked_listing_id = @second`,
      { first, second },
    )[0];
    return !!link;
  };

  // Follow the chain backwards via previous_version_id
  let currentId = listing.previous_version_id;
  let previousId = id;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const prev = getListingById(currentId);
    if (!prev) break;

    // Check if this link is manual or automatic
    if (areManuallyLinked(previousId, currentId)) {
      prev._isManuallyLinked = true;
    } else {
      prev._isAutoLinked = true;
    }

    allListings.push(prev);
    previousId = currentId;
    currentId = prev.previous_version_id;
  }

  // Also find newer versions that reference this listing
  const newerVersions = SqliteConnection.query(`SELECT id FROM listings WHERE previous_version_id = @id`, { id });

  for (const newer of newerVersions) {
    if (!visited.has(newer.id)) {
      visited.add(newer.id);
      const newerListing = getListingById(newer.id);
      if (newerListing) {
        // Check if this link is manual or automatic
        if (areManuallyLinked(id, newer.id)) {
          newerListing._isManuallyLinked = true;
        } else {
          newerListing._isAutoLinked = true;
        }
        allListings.push(newerListing);
      }
    }
  }

  // Also include manually linked listings not yet found via previous_version_id
  if (manualLinksTableExists) {
    const idsToCheck = [...visited];
    for (const checkId of idsToCheck) {
      const linkedIds = SqliteConnection.query(
        `SELECT CASE WHEN listing_id = @checkId THEN linked_listing_id ELSE listing_id END AS linked_id
         FROM manual_property_links
         WHERE listing_id = @checkId OR linked_listing_id = @checkId`,
        { checkId },
      );

      for (const row of linkedIds) {
        if (!visited.has(row.linked_id)) {
          visited.add(row.linked_id);
          const linkedListing = getListingById(row.linked_id);
          if (linkedListing) {
            linkedListing._isManuallyLinked = true;
            allListings.push(linkedListing);
          }
        }
      }
    }
  }

  // Sort all listings by date (newest first)
  allListings.sort((a, b) => {
    const dateA = a.published_at || a.created_at || 0;
    const dateB = b.published_at || b.created_at || 0;
    return dateB - dateA;
  });

  return allListings;
};

/**
 * Break the version chain between two listings.
 * This clears the previous_version_id link and un-supersedes the older listing.
 *
 * @param {string} listingId1 - First listing ID.
 * @param {string} listingId2 - Second listing ID.
 * @returns {{ success: boolean, removed: boolean, error?: string }} Result.
 */
export const breakVersionChain = (listingId1, listingId2) => {
  if (!listingId1 || !listingId2) {
    return { success: false, removed: false, error: 'Both listing IDs are required' };
  }

  const listing1 = getListingById(listingId1);
  const listing2 = getListingById(listingId2);

  if (!listing1 || !listing2) {
    return { success: false, removed: false, error: 'One or both listings not found' };
  }

  const id1 = listing1.id;
  const id2 = listing2.id;

  let removed = false;

  // Break direct previous_version_id links
  if (listing1.previous_version_id === id2) {
    SqliteConnection.execute(`UPDATE listings SET previous_version_id = NULL WHERE id = @id`, { id: id1 });
    removed = true;
  }
  if (listing2.previous_version_id === id1) {
    SqliteConnection.execute(`UPDATE listings SET previous_version_id = NULL WHERE id = @id`, { id: id2 });
    removed = true;
  }

  // Break indirect previous_version_id links: walk the chain from listing1 to find any
  // listing whose previous_version_id points to listing2 (handles A→B→C when breaking A-C)
  let walkId = id1;
  const visited = new Set();
  while (walkId && !visited.has(walkId)) {
    visited.add(walkId);
    const current = SqliteConnection.query(`SELECT id, previous_version_id FROM listings WHERE id = @id`, {
      id: walkId,
    })[0];
    if (!current || !current.previous_version_id) break;
    if (current.previous_version_id === id2) {
      SqliteConnection.execute(`UPDATE listings SET previous_version_id = NULL WHERE id = @id`, { id: current.id });
      removed = true;
      break;
    }
    walkId = current.previous_version_id;
  }

  // Also walk from listing2 to find links back to listing1
  walkId = id2;
  visited.clear();
  while (walkId && !visited.has(walkId)) {
    visited.add(walkId);
    const current = SqliteConnection.query(`SELECT id, previous_version_id FROM listings WHERE id = @id`, {
      id: walkId,
    })[0];
    if (!current || !current.previous_version_id) break;
    if (current.previous_version_id === id1) {
      SqliteConnection.execute(`UPDATE listings SET previous_version_id = NULL WHERE id = @id`, { id: current.id });
      removed = true;
      break;
    }
    walkId = current.previous_version_id;
  }

  // Also remove any manual links between the two listings
  try {
    const manualLinksTableExists = SqliteConnection.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manual_property_links'",
    )[0];
    if (manualLinksTableExists) {
      const result = SqliteConnection.execute(
        `DELETE FROM manual_property_links
         WHERE (listing_id = @id1 AND linked_listing_id = @id2)
            OR (listing_id = @id2 AND linked_listing_id = @id1)`,
        { id1, id2 },
      );
      if (result.changes > 0) removed = true;
    }
  } catch {
    // Table doesn't exist, ignore
  }

  // Un-supersede listing2 so it shows in the overview again
  SqliteConnection.execute(`UPDATE listings SET is_superseded = 0 WHERE id = @id`, { id: id2 });

  return { success: true, removed };
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

/**
 * Find existing listings with matching fuzzy identities within a job.
 * Returns the most recent listing for each fuzzy identity.
 * Used for batch-aware version detection.
 *
 * @param {string} jobId - The job identifier.
 * @param {string[]} fuzzyIdentities - Array of fuzzy identity hashes to look up.
 * @returns {Map<string, Object>} Map from fuzzy identity to the most recent matching listing.
 */
export const findListingsByFuzzyIdentities = (jobId, fuzzyIdentities) => {
  const result = new Map();

  if (!fuzzyIdentities || fuzzyIdentities.length === 0) {
    return result;
  }

  // Build query with placeholders
  const placeholders = fuzzyIdentities.map(() => '?').join(',');
  const params = [jobId, ...fuzzyIdentities];

  // Query for the most recent listing per fuzzy identity using a window function
  const rows = SqliteConnection.query(
    `SELECT *
     FROM (
       SELECT *,
              ROW_NUMBER() OVER (PARTITION BY fuzzy_identity ORDER BY created_at DESC) as rn
       FROM listings
       WHERE job_id = ?
         AND fuzzy_identity IN (${placeholders})
         AND manually_deleted = 0
     )
     WHERE rn = 1`,
    params,
  );

  for (const row of rows) {
    if (row.fuzzy_identity) {
      result.set(row.fuzzy_identity, row);
    }
  }

  return result;
};
