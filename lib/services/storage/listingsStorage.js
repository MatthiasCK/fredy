/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nullOrEmpty } from '../../utils.js';
import SqliteConnection from './SqliteConnection.js';
import { nanoid } from 'nanoid';
import { getJob } from './jobStorage.js';

/**
 * Return a list of known listing hashes for a given job and provider.
 * Useful to de-duplicate before inserting new listings.
 *
 * @param {string} jobId - The job identifier.
 * @param {string} providerId - The provider identifier (e.g., 'immoscout').
 * @returns {string[]} Array of listing hashes.
 */
export const getKnownListingHashesForJobAndProvider = (jobId, providerId) => {
  return SqliteConnection.query(
    `SELECT hash
     FROM listings
     WHERE job_id = @jobId
       AND provider = @providerId`,
    { jobId, providerId },
  ).map((r) => r.hash);
};

/**
 * Compute KPI aggregates for a given set of job IDs from the listings table.
 *
 * - numberOfActiveListings: count of listings where is_active = 1
 * - avgPriceOfListings: average of numeric price, rounded to nearest integer
 *
 * When no jobIds are provided, returns zeros.
 *
 * @param {string[]} jobIds
 * @returns {{ numberOfActiveListings: number, avgPriceOfListings: number }}
 */
export const getListingsKpisForJobIds = (jobIds = []) => {
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return { numberOfActiveListings: 0, avgPriceOfListings: 0 };
  }

  const placeholders = jobIds.map(() => '?').join(',');
  const row =
    SqliteConnection.query(
      `SELECT
          SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS activeCount,
          AVG(price) AS avgPrice
       FROM listings
       WHERE job_id IN (${placeholders})
         AND manually_deleted = 0`,
      jobIds,
    )[0] || {};

  return {
    numberOfActiveListings: Number(row.activeCount || 0),
    avgPriceOfListings: row?.avgPrice == null ? 0 : Math.round(Number(row.avgPrice)),
  };
};

/**
 * Compute distribution of listings by provider for the given set of job IDs.
 * Returns data ready for the pie chart component with fields `type` and `value` (percentage).
 *
 * Example return:
 * [ { type: 'immoscout', value: 62 }, { type: 'immowelt', value: 38 } ]
 *
 * When no jobIds are provided or no listings exist, returns empty array.
 *
 * @param {string[]} jobIds
 * @returns {{ type: string, value: number }[]}
 */
export const getProviderDistributionForJobIds = (jobIds = []) => {
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return [];
  }

  const placeholders = jobIds.map(() => '?').join(',');
  const rows = SqliteConnection.query(
    `SELECT provider, COUNT(*) AS cnt
     FROM listings
     WHERE job_id IN (${placeholders})
       AND manually_deleted = 0
     GROUP BY provider
     ORDER BY cnt DESC`,
    jobIds,
  );

  const total = rows.reduce((acc, r) => acc + Number(r.cnt || 0), 0);
  if (total === 0) return [];

  // Map counts to integer percentage values (0-100). Ensure sum is ~100 by rounding.
  const percentages = rows.map((r) => ({
    type: r.provider,
    value: Math.round((Number(r.cnt) / total) * 100),
  }));

  // Adjust rounding drift to keep sum at 100 (optional minor correction)
  const drift = 100 - percentages.reduce((s, p) => s + p.value, 0);
  if (drift !== 0 && percentages.length > 0) {
    // apply drift to the largest slice to keep UX simple
    let maxIdx = 0;
    for (let i = 1; i < percentages.length; i++) {
      if (percentages[i].value > percentages[maxIdx].value) maxIdx = i;
    }
    percentages[maxIdx].value = Math.max(0, percentages[maxIdx].value + drift);
  }

  return percentages;
};

/**
 * Return a list of listing that either are active or have an unknown status
 * to constantly check if they are still online
 *
 * @returns {string[]} Array of listings
 */
export const getActiveOrUnknownListings = () => {
  return SqliteConnection.query(
    `SELECT *
     FROM listings
     WHERE (is_active is null OR is_active = 1)
       AND manually_deleted = 0
     ORDER BY provider`,
  );
};

/**
 * Deactivates listings by setting is_active = 0 for all matching IDs.
 *
 * @param {string[]} ids - Array of listing IDs to deactivate.
 * @returns {object[]} Result of the SQLite query execution.
 */
export const deactivateListings = (ids) => {
  const placeholders = ids.map(() => '?').join(',');
  const hasDeactivatedAt = SqliteConnection.columnExists('listings', 'deactivated_at');
  const now = Date.now();

  const sql = hasDeactivatedAt
    ? `UPDATE listings
       SET is_active = 0,
           deactivated_at = CASE WHEN deactivated_at IS NULL THEN ${now} ELSE deactivated_at END
       WHERE id IN (${placeholders})`
    : `UPDATE listings SET is_active = 0 WHERE id IN (${placeholders})`;

  return SqliteConnection.execute(sql, ids);
};

/**
 * Persist a batch of scraped listings for a given job and provider.
 *
 * - Empty or non-array inputs are ignored.
 * - Each listing is inserted with ON CONFLICT(hash) DO NOTHING to avoid duplicates.
 * - Performs inserts in a single transaction for performance.
 *
 * Listing input shape (minimal expected):
 * {
 *   id: string,            // unique id
 *   hash: string           // stable hash/id of the listing (used as unique hash)
 *   price?: string,        // e.g., "1.234 €" or "1,234€"
 *   size?: string,         // e.g., "70 m²"
 *   title?: string,
 *   image?: string,        // image URL
 *   description?: string,
 *   address?: string,      // free-text address possibly containing parentheses
 *   link?: string,
 *   rooms?: number,        // number of rooms
 *   floor?: number,        // floor number
 *   energyEfficiencyClass?: string,
 *   heatingType?: string,
 *   constructionYear?: number,
 *   propertyIdentity?: string,      // computed identity for version linking
 *   previousVersionId?: string,     // ID of previous version if detected
 *   localImages?: string[],         // local paths to downloaded images
 *   localDocuments?: object[],      // local paths to downloaded documents
 *   changeSet?: object              // extended data stored as JSON
 * }
 *
 * @param {string} jobId - The job identifier.
 * @param {string} providerId - The provider identifier.
 * @param {Array<Object>} listings - Array of listing objects as described above.
 * @returns {void}
 */
export const storeListings = (jobId, providerId, listings) => {
  if (!Array.isArray(listings) || listings.length === 0) {
    return;
  }

  // Check if extended columns exist (migration has been run)
  const hasExtendedColumns = SqliteConnection.columnExists('listings', 'property_identity');
  const hasLifecycleColumns = hasExtendedColumns && SqliteConnection.columnExists('listings', 'published_at');
  const hasFuzzyIdentity = hasExtendedColumns && SqliteConnection.columnExists('listings', 'fuzzy_identity');

  // Look up job name once for the batch (job_name column added in migration 11, which implies extended columns)
  const jobName = hasExtendedColumns ? (getJob(jobId)?.name ?? null) : null;

  SqliteConnection.withTransaction((db) => {
    // Use different INSERT statement depending on whether migration has been run
    const lifecycleCols = hasLifecycleColumns ? ', published_at' : '';
    const lifecycleVals = hasLifecycleColumns ? ', @published_at' : '';
    const fuzzyIdentityCols = hasFuzzyIdentity ? ', fuzzy_identity' : '';
    const fuzzyIdentityVals = hasFuzzyIdentity ? ', @fuzzy_identity' : '';
    const stmt = hasExtendedColumns
      ? db.prepare(
          `INSERT INTO listings (id, hash, provider, job_id, job_name, price, size, title, image_url, description, address,
                               link, created_at, is_active, latitude, longitude, rooms, floor,
                               energy_efficiency_class, heating_type, construction_year,
                               property_identity, previous_version_id, local_images, local_documents, change_set${lifecycleCols}${fuzzyIdentityCols})
         VALUES (@id, @hash, @provider, @job_id, @job_name, @price, @size, @title, @image_url, @description, @address, @link,
                 @created_at, 1, @latitude, @longitude, @rooms, @floor,
                 @energy_efficiency_class, @heating_type, @construction_year,
                 @property_identity, @previous_version_id, @local_images, @local_documents, @change_set${lifecycleVals}${fuzzyIdentityVals})
         ON CONFLICT(job_id, hash) DO NOTHING`,
        )
      : db.prepare(
          `INSERT INTO listings (id, hash, provider, job_id, price, size, title, image_url, description, address,
                               link, created_at, is_active, latitude, longitude)
         VALUES (@id, @hash, @provider, @job_id, @price, @size, @title, @image_url, @description, @address, @link,
                 @created_at, 1, @latitude, @longitude)
         ON CONFLICT(job_id, hash) DO NOTHING`,
        );

    for (const item of listings) {
      const params = {
        id: nanoid(),
        hash: item.id,
        provider: providerId,
        job_id: jobId,
        price: extractNumber(item.price),
        size: extractNumber(item.size),
        title: item.title,
        image_url: item.image,
        description: item.description,
        address: removeParentheses(item.address),
        link: item.link,
        created_at: Date.now(),
        latitude: item.latitude || null,
        longitude: item.longitude || null,
      };

      // Add extended fields only if migration has been run
      if (hasExtendedColumns) {
        params.job_name = jobName;
        params.rooms = item.rooms || null;
        params.floor = item.floor || null;
        params.energy_efficiency_class = item.energyEfficiencyClass || null;
        params.heating_type = item.heatingType || null;
        params.construction_year = item.constructionYear || null;
        params.property_identity = item.propertyIdentity || null;
        params.previous_version_id = item.previousVersionId || null;
        params.local_images = item.localImages ? JSON.stringify(item.localImages) : null;
        params.local_documents = item.localDocuments ? JSON.stringify(item.localDocuments) : null;
        params.change_set = item.changeSet ? JSON.stringify(item.changeSet) : null;
        if (hasLifecycleColumns) {
          params.published_at = item.publishedAt || null;
        }
        if (hasFuzzyIdentity) {
          params.fuzzy_identity = item.fuzzyIdentity || null;
        }
      }

      stmt.run(params);
    }
  });

  /**
   * Extract the first number from a string like "1.234 €" or "70 m²".
   * Removes dots/commas before parsing. Returns null on invalid input.
   * @param {string|undefined|null} str
   * @returns {number|null}
   */
  function extractNumber(str) {
    if (!str) return null;
    const cleaned = str.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  /**
   * Remove any parentheses segments (including surrounding whitespace) from a string.
   * Returns null for empty input.
   * @param {string|undefined|null} str
   * @returns {string|null}
   */
  function removeParentheses(str) {
    if (nullOrEmpty(str)) {
      return null;
    }
    return str.replace(/\s*\([^)]*\)/g, '');
  }
};

/**
 * Resolve batch version chains after listings have been stored.
 * This converts temporary _batchPreviousHash markers to actual previousVersionId
 * by looking up the database IDs of the linked listings.
 *
 * @param {string} jobId - The job identifier.
 * @param {Array<Object>} listings - Array of listing objects that may have _batchPreviousHash.
 * @returns {void}
 */
export const resolveBatchVersionChains = (jobId, listings) => {
  if (!Array.isArray(listings) || listings.length === 0) {
    return;
  }

  // Check if the required column exists
  if (!SqliteConnection.columnExists('listings', 'previous_version_id')) {
    return;
  }

  // Find listings with batch chain markers
  const withBatchChain = listings.filter((l) => l._batchPreviousHash);
  if (withBatchChain.length === 0) {
    return;
  }

  // Collect all hashes we need to look up
  const hashesToLookup = new Set();
  for (const listing of withBatchChain) {
    hashesToLookup.add(listing.id); // The current listing's hash
    hashesToLookup.add(listing._batchPreviousHash); // The previous listing's hash
  }

  // Look up DB IDs for all relevant hashes
  const placeholders = [...hashesToLookup].map(() => '?').join(',');
  const rows = SqliteConnection.query(`SELECT id, hash FROM listings WHERE job_id = ? AND hash IN (${placeholders})`, [
    jobId,
    ...hashesToLookup,
  ]);

  // Build hash -> DB ID map
  const hashToDbId = new Map();
  for (const row of rows) {
    hashToDbId.set(row.hash, row.id);
  }

  // Check if is_superseded column exists
  const hasSupersededColumn = SqliteConnection.columnExists('listings', 'is_superseded');

  // Update previous_version_id for each listing with a batch chain
  // Also mark the older listing as superseded
  for (const listing of withBatchChain) {
    const currentDbId = hashToDbId.get(listing.id);
    const previousDbId = hashToDbId.get(listing._batchPreviousHash);

    if (currentDbId && previousDbId) {
      SqliteConnection.execute(`UPDATE listings SET previous_version_id = @previousDbId WHERE id = @currentDbId`, {
        currentDbId,
        previousDbId,
      });

      // Mark the older listing as superseded (hidden from overview)
      if (hasSupersededColumn) {
        SqliteConnection.execute(`UPDATE listings SET is_superseded = 1 WHERE id = @previousDbId`, {
          previousDbId,
        });
      }
    }
  }
};

/**
 * Mark a listing as superseded (hidden from overview but kept for history).
 *
 * @param {string} listingId - The database ID of the listing to mark as superseded.
 * @returns {void}
 */
export const markListingAsSuperseded = (listingId) => {
  if (!listingId) return;

  if (!SqliteConnection.columnExists('listings', 'is_superseded')) {
    return;
  }

  SqliteConnection.execute(`UPDATE listings SET is_superseded = 1 WHERE id = @listingId`, { listingId });
};

/**
 * Mark all listings with a given fuzzy identity as superseded, except for the specified one.
 * This is used when a new version of a property is detected - all older versions should be hidden.
 *
 * @param {string} jobId - The job identifier.
 * @param {string} fuzzyIdentity - The fuzzy identity to match.
 * @param {string} excludeHash - The hash of the new listing to exclude from being marked.
 * @returns {void}
 */
export const markAllVersionsAsSuperseded = (jobId, fuzzyIdentity, excludeHash) => {
  if (!jobId || !fuzzyIdentity) return;

  if (!SqliteConnection.columnExists('listings', 'is_superseded')) {
    return;
  }

  SqliteConnection.execute(
    `UPDATE listings
     SET is_superseded = 1
     WHERE job_id = @jobId
       AND fuzzy_identity = @fuzzyIdentity
       AND hash != @excludeHash`,
    { jobId, fuzzyIdentity, excludeHash },
  );
};

/**
 * Query listings with pagination, filtering and sorting.
 *
 * @param {Object} params
 * @param {number} [params.pageSize=50]
 * @param {number} [params.page=1]
 * @param {string} [params.freeTextFilter]
 * @param {object} [params.activityFilter]
 * @param {object} [params.jobNameFilter]
 * @param {object} [params.providerFilter]
 * @param {object} [params.watchListFilter]
 * @param {boolean} [params.includeSuperseded=false] - When true, includes older versions that have been superseded.
 * @param {boolean} [params.deletedFilter=false] - When true, returns deleted listings (manually_deleted = 1).
 * @param {string|null} [params.sortField=null] - One of: 'created_at','price','size','provider','title'.
 * @param {('asc'|'desc')} [params.sortDir='asc']
 * @param {string} [params.userId] - Current user id used to scope listings (ignored for admins).
 * @param {boolean} [params.isAdmin=false] - When true, returns all listings.
 * @returns {{ totalNumber:number, page:number, result:Object[] }}
 */
export const queryListings = ({
  pageSize = 50,
  page = 1,
  activityFilter,
  jobNameFilter,
  jobIdFilter,
  providerFilter,
  watchListFilter,
  includeSuperseded = false,
  deletedFilter = false,
  freeTextFilter,
  sortField = null,
  sortDir = 'asc',
  userId = null,
  isAdmin = false,
} = {}) => {
  // sanitize inputs
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.min(500, Math.floor(pageSize)) : 50;
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const offset = (safePage - 1) * safePageSize;

  // build WHERE filter across common text columns
  const whereParts = [];
  const params = { limit: safePageSize, offset };
  // always provide userId param for watched-flag evaluation (null -> no matches)
  params.userId = userId || '__NO_USER__';
  // user scoping (non-admin only): restrict to listings whose job belongs to user
  // Orphaned listings (job_id IS NULL) are visible to admins only
  if (!isAdmin) {
    whereParts.push(
      `(j.user_id = @userId OR EXISTS (SELECT 1 FROM json_each(j.shared_with_user) AS sw WHERE sw.value = @userId))`,
    );
  }
  if (freeTextFilter && String(freeTextFilter).trim().length > 0) {
    params.filter = `%${String(freeTextFilter).trim()}%`;
    whereParts.push(`(title LIKE @filter OR address LIKE @filter OR provider LIKE @filter OR link LIKE @filter)`);
  }
  // activityFilter: when true -> only active listings (is_active = 1), false -> only inactive
  if (activityFilter === true) {
    whereParts.push('(is_active = 1)');
  } else if (activityFilter === false) {
    whereParts.push('(is_active = 0)');
  }
  // Prefer filtering by job id when provided (unambiguous and robust)
  if (jobIdFilter && String(jobIdFilter).trim().length > 0) {
    params.jobId = String(jobIdFilter).trim();
    whereParts.push('(l.job_id = @jobId)');
  } else if (jobNameFilter && String(jobNameFilter).trim().length > 0) {
    // Match job name from live job or stored job_name for orphaned listings
    params.jobName = String(jobNameFilter).trim();
    whereParts.push('(COALESCE(j.name, l.job_name) = @jobName)');
  }
  // providerFilter: when provided as string (assumed provider name), filter listings where provider equals that name (exact match)
  if (providerFilter && String(providerFilter).trim().length > 0) {
    params.providerName = String(providerFilter).trim();
    whereParts.push('(provider = @providerName)');
  }
  // watchListFilter: when true -> only watched listings, false -> only unwatched
  if (watchListFilter === true) {
    whereParts.push('(wl.id IS NOT NULL)');
  } else if (watchListFilter === false) {
    whereParts.push('(wl.id IS NULL)');
  }

  // Build whereSql (filtering by manually_deleted based on deletedFilter)
  whereParts.push(deletedFilter ? '(l.manually_deleted = 1)' : '(l.manually_deleted = 0)');

  // Filter out superseded listings (older versions) unless explicitly requested
  if (!includeSuperseded && SqliteConnection.columnExists('listings', 'is_superseded')) {
    whereParts.push('(l.is_superseded = 0 OR l.is_superseded IS NULL)');
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const whereSqlWithAlias = whereSql
    .replace(/\btitle\b/g, 'l.title')
    .replace(/\bdescription\b/g, 'l.description')
    .replace(/\baddress\b/g, 'l.address')
    .replace(/\bprovider\b/g, 'l.provider')
    .replace(/\blink\b/g, 'l.link')
    .replace(/\bis_active\b/g, 'l.is_active')
    .replace(/\bj\.user_id\b/g, 'j.user_id')
    .replace(/\bj\.name\b/g, 'j.name')
    .replace(/\bwl\.id\b/g, 'wl.id');

  // whitelist sortable fields to avoid SQL injection
  const sortable = new Set([
    'created_at',
    'published_at',
    'price',
    'size',
    'provider',
    'title',
    'job_name',
    'is_active',
    'isWatched',
  ]);
  const safeSortField = sortField && sortable.has(sortField) ? sortField : null;
  const safeSortDir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderSql = safeSortField ? `ORDER BY ${safeSortField} ${safeSortDir}` : 'ORDER BY published_at DESC';
  const orderSqlWithAlias = orderSql
    .replace(/\bcreated_at\b/g, 'l.created_at')
    .replace(/\bpublished_at\b/g, 'COALESCE(l.published_at, l.created_at)')
    .replace(/\bprice\b/g, 'l.price')
    .replace(/\bsize\b/g, 'l.size')
    .replace(/\bprovider\b/g, 'l.provider')
    .replace(/\btitle\b/g, 'l.title')
    .replace(/\bjob_name\b/g, 'COALESCE(j.name, l.job_name)')
    // Sort by computed watch flag when requested
    .replace(/\bisWatched\b/g, 'CASE WHEN wl.id IS NOT NULL THEN 1 ELSE 0 END');

  // count total with same WHERE
  const countRow = SqliteConnection.query(
    `SELECT COUNT(1) as cnt
     FROM listings l
            LEFT JOIN jobs j ON j.id = l.job_id
            LEFT JOIN watch_list wl ON wl.listing_id = l.id AND wl.user_id = @userId
       ${whereSqlWithAlias}`,
    params,
  );
  const totalNumber = countRow?.[0]?.cnt ?? 0;

  // Check if manual_property_links table exists for the history flag
  const hasManualLinksTable = SqliteConnection.tableExists('manual_property_links');

  // Build subquery for has_version_history flag
  const historySubquery = hasManualLinksTable
    ? `CASE WHEN l.previous_version_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM listings l2 WHERE l2.previous_version_id = l.id)
            OR EXISTS (SELECT 1 FROM manual_property_links mpl WHERE mpl.listing_id = l.id OR mpl.linked_listing_id = l.id)
       THEN 1 ELSE 0 END`
    : `CASE WHEN l.previous_version_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM listings l2 WHERE l2.previous_version_id = l.id)
       THEN 1 ELSE 0 END`;

  // fetch page
  const rows = SqliteConnection.query(
    `SELECT l.*,
            COALESCE(j.name, l.job_name)                  AS job_name,
            CASE WHEN wl.id IS NOT NULL THEN 1 ELSE 0 END AS isWatched,
            ${historySubquery} AS has_version_history
     FROM listings l
            LEFT JOIN jobs j ON j.id = l.job_id
            LEFT JOIN watch_list wl ON wl.listing_id = l.id AND wl.user_id = @userId
       ${whereSqlWithAlias}
         ${orderSqlWithAlias}
     LIMIT @limit OFFSET @offset`,
    params,
  );

  return { totalNumber, page: safePage, result: rows };
};

/**
 * Delete all listings for a given job id.
 *
 * @param {string} jobId - The job identifier whose listings should be removed.
 * @returns {any} The result from SqliteConnection.execute (may contain changes count).
 */
export const deleteListingsByJobId = (jobId) => {
  if (!jobId) return;
  return SqliteConnection.execute(
    `UPDATE listings
     SET manually_deleted = 1
     WHERE job_id = @jobId`,
    { jobId },
  );
};

/**
 * Delete listings by a list of listing IDs.
 *
 * @param {string[]} ids - Array of listing IDs to delete.
 * @returns {any} The result from SqliteConnection.execute.
 */
export const deleteListingsById = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  return SqliteConnection.execute(
    `UPDATE listings
     SET manually_deleted = 1
     WHERE id IN (${placeholders})`,
    ids,
  );
};

/**
 * Restore listings by a list of listing IDs (undo soft delete).
 *
 * @param {string[]} ids - Array of listing IDs to restore.
 * @returns {any} The result from SqliteConnection.execute.
 */
export const restoreListingsById = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  return SqliteConnection.execute(
    `UPDATE listings
     SET manually_deleted = 0
     WHERE id IN (${placeholders})`,
    ids,
  );
};

/**
 * Return all listings that are active, have an address, and do not yet have geocoordinates.
 *
 * @returns {Object[]} Array of listing objects {id, address}.
 */
export const getListingsToGeocode = () => {
  return SqliteConnection.query(
    `SELECT id, address
     FROM listings
     WHERE is_active = 1
       AND manually_deleted = 0
       AND address IS NOT NULL
       AND (latitude IS NULL OR longitude IS NULL)`,
  );
};

/**
 * Update the geocoordinates for a listing.
 *
 * @param {string} id - The listing ID.
 * @param {number} latitude
 * @param {number} longitude
 * @returns {void}
 */
export const updateListingGeocoordinates = (id, latitude, longitude) => {
  SqliteConnection.execute(
    `UPDATE listings
     SET latitude = @latitude,
         longitude = @longitude
     WHERE id = @id`,
    { id, latitude, longitude },
  );
};

/**
 * Return listings with geocoordinates for the map view, with optional filtering.
 *
 * @param {Object} params
 * @param {string} [params.jobId]
 * @param {string} [params.userId]
 * @param {boolean} [params.isAdmin=false]
 * @returns {{listings: Object[], maxPrice: number}} Object containing listings and maxPrice.
 */
export const getListingsForMap = ({ jobId, userId = null, isAdmin = false } = {}) => {
  const baseWhereParts = [
    'l.latitude IS NOT NULL',
    'l.longitude IS NOT NULL',
    'l.latitude != -1',
    'l.longitude != -1',
    'l.is_active = 1',
    'l.manually_deleted = 0',
  ];
  const params = { userId: userId || '__NO_USER__' };

  if (!isAdmin) {
    baseWhereParts.push(
      `(j.user_id = @userId OR EXISTS (SELECT 1 FROM json_each(j.shared_with_user) AS sw WHERE sw.value = @userId))`,
    );
  }

  if (jobId) {
    params.jobId = jobId;
    baseWhereParts.push('l.job_id = @jobId');
  }

  const wherePartsForListings = [...baseWhereParts];

  const listings = SqliteConnection.query(
    `SELECT l.*, COALESCE(j.name, l.job_name) AS job_name
     FROM listings l
     LEFT JOIN jobs j ON j.id = l.job_id
     WHERE ${wherePartsForListings.join(' AND ')}`,
    params,
  );

  return {
    listings,
  };
};

/**
 * Return all listings with only the fields: title, address, and price.
 * This is the single helper requested for simple consumers.
 *
 * @returns {{title: string|null, address: string|null, price: number|null}[]}
 */
export const getAllEntriesFromListings = () => {
  return SqliteConnection.query(`SELECT title, address, price FROM listings WHERE manually_deleted = 0`);
};

/**
 * Return geocoordinates for a given address if it has been geocoded before.
 *
 * @param {string} address
 * @returns {{lat: number, lng: number}|null}
 */
export const getGeocoordinatesByAddress = (address) => {
  const row = SqliteConnection.query(
    `SELECT latitude, longitude
     FROM listings
     WHERE address = @address
       AND manually_deleted = 0
       AND latitude IS NOT NULL
       AND longitude IS NOT NULL
       AND latitude != -1
       AND longitude != -1
     LIMIT 1`,
    { address },
  )[0];
  return row ? { lat: row.latitude, lng: row.longitude } : null;
};

/**
 * Return all active listings for a given job that have geocoordinates but no distance set.
 *
 * @param {string} jobId
 * @returns {Object[]}
 */
export const getListingsToCalculateDistance = (jobId) => {
  return SqliteConnection.query(
    `SELECT id, latitude, longitude
     FROM listings
     WHERE job_id = @jobId
       AND is_active = 1
       AND manually_deleted = 0
       AND latitude IS NOT NULL
       AND longitude IS NOT NULL
       AND distance_to_destination IS NULL`,
    { jobId },
  );
};

/**
 * Return all active listings for a given user (across all jobs) that have geocoordinates.
 *
 * @param {string} userId
 * @returns {Object[]}
 */
export const getListingsForUserToCalculateDistance = (userId) => {
  return SqliteConnection.query(
    `SELECT l.id, l.latitude, l.longitude
     FROM listings l
     JOIN jobs j ON l.job_id = j.id
     WHERE j.user_id = @userId
       AND l.is_active = 1
       AND l.manually_deleted = 0
       AND l.latitude IS NOT NULL
       AND l.longitude IS NOT NULL`,
    { userId },
  );
};

/**
 * Update the distance to destination for a listing.
 *
 * @param {string} id
 * @param {number} distance
 * @returns {void}
 */
export const updateListingDistance = (id, distance) => {
  SqliteConnection.execute(
    `UPDATE listings
     SET distance_to_destination = @distance
     WHERE id = @id`,
    { id, distance },
  );
};
