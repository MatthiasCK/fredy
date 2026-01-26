/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

// Migration: Add extended listing data columns for versioning and detailed property information

export function up(db) {
  // Helper to check if a column exists
  const columnExists = (table, column) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === column);
  };

  // Helper to check if an index exists
  const indexExists = (indexName) => {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName);
    return !!row;
  };

  // Extended property data columns
  if (!columnExists('listings', 'rooms')) {
    db.exec('ALTER TABLE listings ADD COLUMN rooms REAL');
  }
  if (!columnExists('listings', 'floor')) {
    db.exec('ALTER TABLE listings ADD COLUMN floor INTEGER');
  }
  if (!columnExists('listings', 'energy_efficiency_class')) {
    db.exec('ALTER TABLE listings ADD COLUMN energy_efficiency_class TEXT');
  }
  if (!columnExists('listings', 'heating_type')) {
    db.exec('ALTER TABLE listings ADD COLUMN heating_type TEXT');
  }
  if (!columnExists('listings', 'construction_year')) {
    db.exec('ALTER TABLE listings ADD COLUMN construction_year INTEGER');
  }

  // Versioning columns
  if (!columnExists('listings', 'property_identity')) {
    db.exec('ALTER TABLE listings ADD COLUMN property_identity TEXT');
  }
  if (!columnExists('listings', 'previous_version_id')) {
    db.exec('ALTER TABLE listings ADD COLUMN previous_version_id TEXT REFERENCES listings(id)');
  }

  // Local media storage paths (JSON arrays)
  if (!columnExists('listings', 'local_images')) {
    db.exec('ALTER TABLE listings ADD COLUMN local_images TEXT');
  }
  if (!columnExists('listings', 'local_documents')) {
    db.exec('ALTER TABLE listings ADD COLUMN local_documents TEXT');
  }

  // Indexes for common queries
  if (!indexExists('idx_listings_rooms')) {
    db.exec('CREATE INDEX idx_listings_rooms ON listings(rooms)');
  }
  if (!indexExists('idx_listings_property_identity')) {
    db.exec('CREATE INDEX idx_listings_property_identity ON listings(property_identity)');
  }
  if (!indexExists('idx_listings_previous_version')) {
    db.exec('CREATE INDEX idx_listings_previous_version ON listings(previous_version_id)');
  }
}
