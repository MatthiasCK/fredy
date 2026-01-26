/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { mkdir, writeFile, access, constants } from 'fs/promises';
import { join, extname } from 'path';
import logger from '../logger.js';
import { sleep, randomBetween } from '../../utils.js';

const MEDIA_BASE_PATH = 'db/media';

/**
 * Ensures the base media directory exists.
 */
async function ensureBaseDirectory() {
  try {
    await mkdir(MEDIA_BASE_PATH, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Downloads a file from a URL and saves it locally.
 *
 * @param {string} url - The URL to download from.
 * @param {string} localPath - The local path to save the file.
 * @returns {Promise<string|null>} The local path on success, null on failure.
 */
async function downloadFile(url, localPath) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Fredy/1.0)',
      },
    });

    if (!response.ok) {
      logger.debug(`Failed to download ${url}: ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localPath, buffer);
    return localPath;
  } catch (error) {
    logger.debug(`Error downloading ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Gets the file extension from a URL, defaulting to .jpg for images.
 *
 * @param {string} url - The URL.
 * @param {string} defaultExt - Default extension if none found.
 * @returns {string} The file extension including the dot.
 */
function getExtension(url, defaultExt = '.jpg') {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const ext = extname(pathname).toLowerCase();
    const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.tiff', '.tif', '.bmp'];
    if (ext && validExtensions.includes(ext)) {
      return ext;
    }
  } catch {
    // Invalid URL
  }
  return defaultExt;
}

/**
 * Gets the appropriate file extension based on document type.
 *
 * @param {string} docType - The document type (e.g., 'pdf', 'jpg', 'png').
 * @returns {string} The file extension including the dot.
 */
function getExtensionFromType(docType) {
  const typeMap = {
    pdf: '.pdf',
    jpg: '.jpg',
    jpeg: '.jpg',
    png: '.png',
    gif: '.gif',
    webp: '.webp',
    tiff: '.tiff',
    tif: '.tif',
    bmp: '.bmp',
    image: '.jpg',
    document: '.pdf',
    floorplan: '.pdf',
  };
  return typeMap[(docType || '').toLowerCase()] || '.pdf';
}

/**
 * Checks if a file exists at the given path.
 *
 * @param {string} filePath - The path to check.
 * @returns {Promise<boolean>} True if the file exists.
 */
async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads all media (images and documents) for a listing.
 *
 * @param {string} listingId - The unique listing identifier.
 * @param {string[]} imageUrls - Array of image URLs to download.
 * @param {Array<{type: string, url: string}>} documentUrls - Array of document objects.
 * @returns {Promise<{imagePaths: string[], docPaths: Array<{type: string, path: string}>}>}
 */
export async function downloadListingMedia(listingId, imageUrls = [], documentUrls = []) {
  await ensureBaseDirectory();

  const listingDir = join(MEDIA_BASE_PATH, listingId);
  const imagesDir = join(listingDir, 'images');
  const docsDir = join(listingDir, 'documents');

  // Create directories
  await mkdir(imagesDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });

  const imagePaths = [];
  const docPaths = [];

  // Download images
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    if (!url) continue;

    const ext = getExtension(url, '.jpg');
    const filename = `${String(i + 1).padStart(3, '0')}${ext}`;
    const localPath = join(imagesDir, filename);

    // Skip if already downloaded
    if (await fileExists(localPath)) {
      imagePaths.push(localPath);
      continue;
    }

    const result = await downloadFile(url, localPath);
    if (result) {
      imagePaths.push(result);
    }

    // Small delay between downloads to be respectful
    if (i < imageUrls.length - 1) {
      await sleep(randomBetween(100, 300));
    }
  }

  // Download documents
  for (let i = 0; i < documentUrls.length; i++) {
    const doc = documentUrls[i];
    if (!doc || !doc.url) continue;

    // Try to get extension from URL first, then from document type
    let ext = getExtension(doc.url, null);
    if (!ext) {
      ext = getExtensionFromType(doc.type);
    }
    // Use title for filename (with index prefix for uniqueness), fallback to type
    const baseName = sanitizeFilename(doc.title || doc.type || 'document');
    const filename = `${String(i + 1).padStart(2, '0')}_${baseName}${ext}`;
    const localPath = join(docsDir, filename);

    // Skip if already downloaded
    if (await fileExists(localPath)) {
      docPaths.push({ type: doc.type, title: doc.title, path: localPath });
      continue;
    }

    const result = await downloadFile(doc.url, localPath);
    if (result) {
      docPaths.push({ type: doc.type, title: doc.title, path: result });
    }

    // Small delay between downloads
    if (i < documentUrls.length - 1) {
      await sleep(randomBetween(100, 300));
    }
  }

  logger.debug(`Downloaded ${imagePaths.length} images and ${docPaths.length} documents for listing ${listingId}`);

  return { imagePaths, docPaths };
}

/**
 * Sanitizes a filename by removing invalid characters.
 *
 * @param {string} name - The name to sanitize.
 * @returns {string} Sanitized filename.
 */
function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 50);
}

/**
 * Gets the media directory path for a listing.
 *
 * @param {string} listingId - The listing identifier.
 * @returns {string} The media directory path.
 */
export function getMediaPath(listingId) {
  return join(MEDIA_BASE_PATH, listingId);
}

/**
 * Gets the images directory path for a listing.
 *
 * @param {string} listingId - The listing identifier.
 * @returns {string} The images directory path.
 */
export function getImagesPath(listingId) {
  return join(MEDIA_BASE_PATH, listingId, 'images');
}

/**
 * Gets the documents directory path for a listing.
 *
 * @param {string} listingId - The listing identifier.
 * @returns {string} The documents directory path.
 */
export function getDocumentsPath(listingId) {
  return join(MEDIA_BASE_PATH, listingId, 'documents');
}
