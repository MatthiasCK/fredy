/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import restana from 'restana';
import { createReadStream, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import logger from '../../services/logger.js';

const service = restana();
const mediaRouter = service.newRouter();

const MEDIA_BASE_PATH = 'db/media';

// MIME types for supported file extensions
const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/**
 * Safely resolve a file path to prevent directory traversal attacks.
 *
 * @param {string} listingId - The listing ID.
 * @param {string} subdir - The subdirectory (images or documents).
 * @param {string} filename - The filename.
 * @returns {string|null} The resolved path or null if invalid.
 */
function safeResolvePath(listingId, subdir, filename) {
  // Prevent directory traversal
  if (
    listingId.includes('..') ||
    listingId.includes('/') ||
    listingId.includes('\\') ||
    subdir.includes('..') ||
    subdir.includes('/') ||
    subdir.includes('\\') ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    return null;
  }

  // Only allow specific subdirectories
  if (subdir !== 'images' && subdir !== 'documents') {
    return null;
  }

  const filePath = join(MEDIA_BASE_PATH, listingId, subdir, filename);

  // Verify the path is still within MEDIA_BASE_PATH
  if (!filePath.startsWith(MEDIA_BASE_PATH)) {
    return null;
  }

  return filePath;
}

/**
 * Send a file to the response stream.
 *
 * @param {string} filePath - The path to the file.
 * @param {Object} res - The response object.
 */
function sendFile(filePath, res) {
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const stat = statSync(filePath);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours

    const stream = createReadStream(filePath);
    stream.pipe(res);
  } catch (error) {
    logger.error(`Error sending file ${filePath}:`, error.message);
    res.statusCode = 500;
    res.body = { message: 'Error serving file' };
    res.send();
  }
}

// Serve images for a listing
// GET /api/media/:listingId/images/:filename
mediaRouter.get('/:listingId/images/:filename', async (req, res) => {
  const { listingId, filename } = req.params;

  const filePath = safeResolvePath(listingId, 'images', filename);
  if (!filePath) {
    res.statusCode = 400;
    res.body = { message: 'Invalid path' };
    return res.send();
  }

  if (!existsSync(filePath)) {
    res.statusCode = 404;
    res.body = { message: 'Image not found' };
    return res.send();
  }

  sendFile(filePath, res);
});

// Serve documents for a listing
// GET /api/media/:listingId/documents/:filename
mediaRouter.get('/:listingId/documents/:filename', async (req, res) => {
  const { listingId, filename } = req.params;

  const filePath = safeResolvePath(listingId, 'documents', filename);
  if (!filePath) {
    res.statusCode = 400;
    res.body = { message: 'Invalid path' };
    return res.send();
  }

  if (!existsSync(filePath)) {
    res.statusCode = 404;
    res.body = { message: 'Document not found' };
    return res.send();
  }

  sendFile(filePath, res);
});

export { mediaRouter };
