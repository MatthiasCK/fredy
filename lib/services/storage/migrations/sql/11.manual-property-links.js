/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

// Migration: Create manual_property_links table for user-defined property groupings.

export function up(db) {
  // Helper to check if a table exists
  const tableExists = (tableName) => {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    return !!row;
  };

  // Create manual_property_links table if it doesn't exist
  if (!tableExists('manual_property_links')) {
    db.exec(`
      CREATE TABLE manual_property_links (
        id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL,
        linked_listing_id TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(listing_id, linked_listing_id)
      )
    `);

    // Create indexes for efficient lookups
    db.exec('CREATE INDEX idx_manual_links_listing ON manual_property_links(listing_id)');
    db.exec('CREATE INDEX idx_manual_links_linked ON manual_property_links(linked_listing_id)');
  }
}
