/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage layer for manual property links.
 * Allows users to explicitly mark listings as representing the same property.
 * When linked, creates a version chain so the older listing appears in the history
 * of the newer one (mimicking automatic version detection).
 */

import crypto from 'crypto';
import SqliteConnection from '../storage/SqliteConnection.js';
import { markListingAsSuperseded } from '../storage/listingsStorage.js';
import logger from '../logger.js';

/**
 * Find the "head" of a version chain - the newest listing that should remain visible.
 * This traverses both automatic (previous_version_id) and manual links to find all
 * connected listings, then returns the one with the newest date.
 *
 * @param {string} startingId - Starting listing ID.
 * @returns {{ headListing: Object, allInChain: Object[] }} The chain head and all listings in the chain.
 */
function findChainHead(startingId) {
  const visited = new Set();
  const toVisit = [startingId];
  const allListingIds = new Set();

  // BFS to collect all connected listing IDs
  while (toVisit.length > 0) {
    const currentId = toVisit.shift();
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    allListingIds.add(currentId);

    // Get the listing's previous_version_id
    const listing = SqliteConnection.query(`SELECT id, previous_version_id FROM listings WHERE id = @currentId`, {
      currentId,
    })[0];

    if (!listing) continue;

    // Add previous version to visit list
    if (listing.previous_version_id && !visited.has(listing.previous_version_id)) {
      toVisit.push(listing.previous_version_id);
    }

    // Find listings that point TO this one (newer versions)
    const newerListings = SqliteConnection.query(`SELECT id FROM listings WHERE previous_version_id = @currentId`, {
      currentId,
    });
    for (const newer of newerListings) {
      if (!visited.has(newer.id)) {
        toVisit.push(newer.id);
      }
    }

    // Check manual links
    try {
      const manualLinks = SqliteConnection.query(
        `SELECT listing_id, linked_listing_id FROM manual_property_links
         WHERE listing_id = @currentId OR linked_listing_id = @currentId`,
        { currentId },
      );
      for (const link of manualLinks) {
        const linkedId = link.listing_id === currentId ? link.linked_listing_id : link.listing_id;
        if (!visited.has(linkedId)) {
          toVisit.push(linkedId);
        }
      }
    } catch {
      // Table doesn't exist yet, ignore
    }
  }

  // Fetch all listings in the chain
  if (allListingIds.size === 0) {
    return { headListing: null, allInChain: [] };
  }

  const idsArray = Array.from(allListingIds);
  const placeholders = idsArray.map(() => '?').join(',');
  const allInChain = SqliteConnection.query(
    `SELECT id, hash, title, address, price, published_at, created_at, previous_version_id, is_superseded, change_set
     FROM listings WHERE id IN (${placeholders})`,
    idsArray,
  );

  // Find the head (newest by date)
  let headListing = allInChain[0];
  for (const l of allInChain) {
    const headDate = headListing.published_at || headListing.created_at || 0;
    const lDate = l.published_at || l.created_at || 0;
    if (lDate > headDate) {
      headListing = l;
    }
  }

  return { headListing, allInChain };
}

/**
 * Generate a unique ID for a manual link.
 *
 * @returns {string} Unique identifier.
 */
function generateLinkId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Parse price from various formats.
 *
 * @param {string|number|null} price - The price value.
 * @returns {number|null} Numeric price or null.
 */
function parsePrice(price) {
  if (price == null) return null;
  if (typeof price === 'number') return price;
  const cleaned = String(price).replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Update the newer listing's change_set with price history from both listings.
 *
 * @param {Object} newerListing - The newer listing.
 * @param {Object} olderListing - The older listing.
 */
function updatePriceHistory(newerListing, olderListing) {
  // Parse existing change_set
  let changeSet = {};
  if (newerListing.change_set) {
    try {
      changeSet =
        typeof newerListing.change_set === 'string' ? JSON.parse(newerListing.change_set) : newerListing.change_set;
    } catch {
      changeSet = {};
    }
  }

  const priceHistory = changeSet.priceHistory || [];

  // Add older listing's price to history if not already there
  const olderDate = olderListing.published_at || olderListing.created_at;
  const olderPrice = parsePrice(olderListing.price);
  if (olderDate && olderPrice != null) {
    const existingOlder = priceHistory.find((e) => e.date === olderDate);
    if (!existingOlder) {
      priceHistory.push({ date: olderDate, price: olderPrice });
    }
  }

  // Add newer listing's price to history if not already there
  const newerDate = newerListing.published_at || newerListing.created_at;
  const newerPrice = parsePrice(newerListing.price);
  if (newerDate && newerPrice != null) {
    const existingNewer = priceHistory.find((e) => e.date === newerDate);
    if (!existingNewer) {
      priceHistory.push({ date: newerDate, price: newerPrice });
    }
  }

  // Sort by date
  priceHistory.sort((a, b) => a.date - b.date);

  changeSet.priceHistory = priceHistory;

  // Update the newer listing in database
  SqliteConnection.execute(`UPDATE listings SET change_set = @changeSet WHERE id = @id`, {
    id: newerListing.id,
    changeSet: JSON.stringify(changeSet),
  });
}

/**
 * Get a listing by ID or hash.
 *
 * @param {string} idOrHash - Database ID or hash.
 * @returns {Object|null} Listing object or null.
 */
function getListingByIdOrHash(idOrHash) {
  const listing = SqliteConnection.query(
    `SELECT id, hash, title, address, price, published_at, created_at, previous_version_id, change_set
     FROM listings WHERE id = @idOrHash OR hash = @idOrHash`,
    { idOrHash },
  )[0];
  return listing || null;
}

/**
 * Create a manual link between two listings and establish a version chain.
 * The older listing will be marked as superseded and appear in the history
 * of the newer listing.
 *
 * @param {string} listingId - First listing ID (database ID or hash).
 * @param {string} linkedListingId - Second listing ID (database ID or hash).
 * @param {string|null} userId - User who created the link (optional).
 * @returns {{ success: boolean, linkId?: string, error?: string }} Result.
 */
export function createManualLink(listingId, linkedListingId, userId = null) {
  if (!listingId || !linkedListingId) {
    return { success: false, error: 'Both listing IDs are required' };
  }

  if (listingId === linkedListingId) {
    return { success: false, error: 'Cannot link a listing to itself' };
  }

  // Get both listings from database
  const listing1 = getListingByIdOrHash(listingId);
  const listing2 = getListingByIdOrHash(linkedListingId);

  if (!listing1 || !listing2) {
    return { success: false, error: 'One or both listings not found' };
  }

  // Normalize order to prevent duplicate inverse links
  // Sort by numeric ID to ensure consistent ordering regardless of input order
  const [firstListing, secondListing] =
    Number(listing1.id) <= Number(listing2.id) ? [listing1, listing2] : [listing2, listing1];
  const first = firstListing.id;
  const second = secondListing.id;

  // Check if link already exists
  const existing = SqliteConnection.query(
    `SELECT id FROM manual_property_links
     WHERE listing_id = @first AND linked_listing_id = @second`,
    { first, second },
  )[0];

  if (existing) {
    return { success: true, linkId: existing.id, alreadyExists: true };
  }

  const linkId = generateLinkId();
  const createdAt = Date.now();

  try {
    // Insert the manual link record
    SqliteConnection.execute(
      `INSERT INTO manual_property_links (id, listing_id, linked_listing_id, created_by, created_at)
       VALUES (@id, @listingId, @linkedListingId, @createdBy, @createdAt)`,
      {
        id: linkId,
        listingId: first,
        linkedListingId: second,
        createdBy: userId,
        createdAt,
      },
    );

    // Determine which listing is newer (by published_at or created_at) between the two being linked
    const date1 = listing1.published_at || listing1.created_at || 0;
    const date2 = listing2.published_at || listing2.created_at || 0;

    const [newerOfPair, olderOfPair] = date1 >= date2 ? [listing1, listing2] : [listing2, listing1];

    // Set previous_version_id on the newer listing if not already set
    if (!newerOfPair.previous_version_id) {
      SqliteConnection.execute(`UPDATE listings SET previous_version_id = @olderId WHERE id = @newerId`, {
        newerId: newerOfPair.id,
        olderId: olderOfPair.id,
      });
    }

    // Find the head of the ENTIRE combined chain (not just these two listings)
    // This handles cases where we're linking to a listing that's already part of a chain
    const { headListing, allInChain } = findChainHead(listing1.id);

    if (headListing && allInChain.length > 0) {
      // Mark ALL listings in the chain as superseded EXCEPT the head
      for (const chainListing of allInChain) {
        if (chainListing.id !== headListing.id) {
          markListingAsSuperseded(chainListing.id);
        }
      }

      // Ensure the head is NOT superseded (in case it was previously marked)
      SqliteConnection.execute(`UPDATE listings SET is_superseded = 0 WHERE id = @id`, { id: headListing.id });

      // Update the head listing's change_set with price history from all versions
      // Re-fetch head to get latest data
      const freshHead = SqliteConnection.query(
        `SELECT id, hash, title, address, price, published_at, created_at, previous_version_id, change_set
         FROM listings WHERE id = @id`,
        { id: headListing.id },
      )[0];

      if (freshHead) {
        for (const chainListing of allInChain) {
          if (chainListing.id !== freshHead.id) {
            updatePriceHistory(freshHead, chainListing);
          }
        }
      }

      logger.debug(
        `Manual link created: chain head "${headListing.title?.substring(0, 30)}..." with ${allInChain.length} total versions`,
      );
    } else {
      // Fallback to original two-listing logic if chain detection fails
      markListingAsSuperseded(olderOfPair.id);
      updatePriceHistory(newerOfPair, olderOfPair);

      logger.debug(
        `Manual link created version chain: "${newerOfPair.title?.substring(0, 30)}..." -> "${olderOfPair.title?.substring(0, 30)}..."`,
      );
    }

    return { success: true, linkId };
  } catch (error) {
    // Handle unique constraint violation gracefully
    if (error.code === 'SQLITE_CONSTRAINT') {
      return { success: true, alreadyExists: true };
    }
    throw error;
  }
}

/**
 * Remove a manual link between two listings and undo the version chain.
 * If no direct link exists between the two listings, this function will find and remove
 * any manual link that connects listing2 to the chain that listing1 belongs to.
 *
 * @param {string} listingId - First listing ID (database ID or hash).
 * @param {string} linkedListingId - Second listing ID (database ID or hash).
 * @returns {{ success: boolean, removed: boolean }} Result.
 */
export function removeManualLink(listingId, linkedListingId) {
  if (!listingId || !linkedListingId) {
    return { success: false, error: 'Both listing IDs are required' };
  }

  // Resolve IDs (could be database ID or hash)
  const listing1 = getListingByIdOrHash(listingId);
  const listing2 = getListingByIdOrHash(linkedListingId);

  if (!listing1 || !listing2) {
    return { success: false, removed: false };
  }

  // Normalize order (same as when creating) - sort by numeric ID
  const [firstListing, secondListing] =
    Number(listing1.id) <= Number(listing2.id) ? [listing1, listing2] : [listing2, listing1];
  const first = firstListing.id;
  const second = secondListing.id;

  // Try to delete direct link first
  let result = SqliteConnection.execute(
    `DELETE FROM manual_property_links
     WHERE listing_id = @first AND linked_listing_id = @second`,
    { first, second },
  );

  // If no direct link found, find the actual manual link connecting listing2 to listing1's chain
  if (result.changes === 0) {
    logger.debug(`No direct link between ${listing1.id} and ${listing2.id}, searching for indirect connection`);

    // Get all listings in listing1's chain (excluding listing2 and its sub-chain)
    const chain1Ids = getChainIdsExcluding(listing1.id, listing2.id);

    // Find manual links where listing2 is connected to any listing in chain1
    const manualLinksForListing2 = SqliteConnection.query(
      `SELECT id, listing_id, linked_listing_id FROM manual_property_links
       WHERE listing_id = @id OR linked_listing_id = @id`,
      { id: listing2.id },
    );

    for (const link of manualLinksForListing2) {
      const otherListingId = link.listing_id === listing2.id ? link.linked_listing_id : link.listing_id;
      if (chain1Ids.has(otherListingId)) {
        // Found the connecting link - delete it
        result = SqliteConnection.execute(`DELETE FROM manual_property_links WHERE id = @linkId`, { linkId: link.id });
        logger.debug(
          `Removed indirect manual link ${link.id} between ${link.listing_id} and ${link.linked_listing_id}`,
        );
        break;
      }
    }
  }

  if (result.changes > 0) {
    const id1 = listing1.id;
    const id2 = listing2.id;

    // Re-fetch listing2 to get current state
    const fresh2 = getListingByIdOrHash(id2);
    const prevId2 = fresh2?.previous_version_id;

    logger.debug(`Unlinking: id1=${id1}, id2=${id2}, prevId2=${prevId2}`);

    // Always clear listing2's previous_version_id if it points to ANY listing in listing1's chain
    // This ensures the unlinked listing is fully detached
    if (prevId2) {
      const chain1Ids = getChainIdsExcluding(id1, id2);
      if (chain1Ids.has(prevId2)) {
        SqliteConnection.execute(`UPDATE listings SET previous_version_id = NULL WHERE id = @id`, { id: id2 });
        logger.debug(`Cleared previous_version_id on listing ${id2} (was pointing to ${prevId2} in the chain)`);
      }
    }

    // Un-supersede listing2 so it shows in the overview again
    SqliteConnection.execute(`UPDATE listings SET is_superseded = 0 WHERE id = @id`, { id: id2 });
    logger.debug(`Un-superseded listing ${id2}`);
  }

  return { success: true, removed: result.changes > 0 };
}

/**
 * Get all listing IDs in a chain, excluding a specific listing and its sub-chain.
 * Used to find the "other side" of a chain when unlinking.
 *
 * @param {string} startingId - Starting listing ID.
 * @param {string} excludeId - Listing ID to exclude (along with anything only reachable through it).
 * @returns {Set<string>} Set of listing IDs in the chain.
 */
function getChainIdsExcluding(startingId, excludeId) {
  const visited = new Set();
  const toVisit = [startingId];

  while (toVisit.length > 0) {
    const currentId = toVisit.shift();
    if (visited.has(currentId) || currentId === excludeId) continue;
    visited.add(currentId);

    // Get the listing's previous_version_id
    const listing = SqliteConnection.query(`SELECT id, previous_version_id FROM listings WHERE id = @currentId`, {
      currentId,
    })[0];

    if (!listing) continue;

    // Add previous version to visit list
    if (
      listing.previous_version_id &&
      !visited.has(listing.previous_version_id) &&
      listing.previous_version_id !== excludeId
    ) {
      toVisit.push(listing.previous_version_id);
    }

    // Find listings that point TO this one
    const newerListings = SqliteConnection.query(`SELECT id FROM listings WHERE previous_version_id = @currentId`, {
      currentId,
    });
    for (const newer of newerListings) {
      if (!visited.has(newer.id) && newer.id !== excludeId) {
        toVisit.push(newer.id);
      }
    }

    // Check manual links (but don't cross through excludeId)
    try {
      const manualLinks = SqliteConnection.query(
        `SELECT listing_id, linked_listing_id FROM manual_property_links
         WHERE listing_id = @currentId OR linked_listing_id = @currentId`,
        { currentId },
      );
      for (const link of manualLinks) {
        const linkedId = link.listing_id === currentId ? link.linked_listing_id : link.listing_id;
        if (!visited.has(linkedId) && linkedId !== excludeId) {
          toVisit.push(linkedId);
        }
      }
    } catch {
      // Table doesn't exist yet
    }
  }

  return visited;
}

/**
 * Get all manual links for a specific listing.
 *
 * @param {string} listingId - The listing ID.
 * @returns {Object[]} Array of link records.
 */
export function getManualLinks(listingId) {
  if (!listingId) return [];

  // Get links where this listing is either the first or second in the pair
  const links = SqliteConnection.query(
    `SELECT * FROM manual_property_links
     WHERE listing_id = @listingId OR linked_listing_id = @listingId
     ORDER BY created_at DESC`,
    { listingId },
  );

  return links;
}

/**
 * Get all linked listing IDs for a specific listing.
 *
 * @param {string} listingId - The listing ID.
 * @returns {string[]} Array of linked listing IDs.
 */
export function getLinkedListingIds(listingId) {
  if (!listingId) return [];

  const links = getManualLinks(listingId);

  const linkedIds = links.map((link) => {
    return link.listing_id === listingId ? link.linked_listing_id : link.listing_id;
  });

  return linkedIds;
}

/**
 * Get full listing data for all manually linked listings.
 *
 * @param {string} listingId - The listing ID.
 * @returns {Object[]} Array of linked listing records with full data.
 */
export function getLinkedListings(listingId) {
  if (!listingId) return [];

  const linkedIds = getLinkedListingIds(listingId);

  if (linkedIds.length === 0) return [];

  // Query for full listing data
  const placeholders = linkedIds.map(() => '?').join(',');
  const listings = SqliteConnection.query(
    `SELECT l.*, j.name AS job_name
     FROM listings l
     LEFT JOIN jobs j ON j.id = l.job_id
     WHERE l.id IN (${placeholders}) OR l.hash IN (${placeholders})`,
    [...linkedIds, ...linkedIds],
  );

  return listings;
}

/**
 * Check if two listings are manually linked.
 *
 * @param {string} listingId1 - First listing ID.
 * @param {string} listingId2 - Second listing ID.
 * @returns {boolean} True if manually linked.
 */
export function areListingsLinked(listingId1, listingId2) {
  if (!listingId1 || !listingId2) return false;

  // Sort by numeric value for consistent ordering
  const [first, second] =
    Number(listingId1) <= Number(listingId2) ? [listingId1, listingId2] : [listingId2, listingId1];

  const link = SqliteConnection.query(
    `SELECT 1 FROM manual_property_links
     WHERE listing_id = @first AND linked_listing_id = @second`,
    { first, second },
  )[0];

  return !!link;
}

/**
 * Get all manual links in the system (for admin purposes).
 *
 * @param {{ limit?: number, offset?: number }} options - Pagination options.
 * @returns {Object[]} Array of all link records.
 */
export function getAllManualLinks(options = {}) {
  const { limit = 100, offset = 0 } = options;

  const links = SqliteConnection.query(
    `SELECT mpl.*,
            l1.title AS listing_title, l1.address AS listing_address,
            l2.title AS linked_title, l2.address AS linked_address
     FROM manual_property_links mpl
     LEFT JOIN listings l1 ON l1.id = mpl.listing_id OR l1.hash = mpl.listing_id
     LEFT JOIN listings l2 ON l2.id = mpl.linked_listing_id OR l2.hash = mpl.linked_listing_id
     ORDER BY mpl.created_at DESC
     LIMIT @limit OFFSET @offset`,
    { limit, offset },
  );

  return links;
}

/**
 * Remove a manual link by its ID.
 *
 * @param {string} linkId - The link ID.
 * @returns {{ success: boolean, removed: boolean }} Result.
 */
export function removeManualLinkById(linkId) {
  if (!linkId) {
    return { success: false, error: 'Link ID is required' };
  }

  const result = SqliteConnection.execute(`DELETE FROM manual_property_links WHERE id = @linkId`, { linkId });

  return { success: true, removed: result.changes > 0 };
}
