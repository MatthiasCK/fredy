/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Enhanced German address normalization for similarity matching.
 * Handles common variations in German addresses from different real estate platforms.
 */

/**
 * Common German street type abbreviations and their normalized forms.
 */
const STREET_TYPE_MAPPINGS = {
  str: 'strasse',
  'str.': 'strasse',
  straße: 'strasse',
  strasse: 'strasse',
  pl: 'platz',
  'pl.': 'platz',
  platz: 'platz',
  wg: 'weg',
  'wg.': 'weg',
  weg: 'weg',
  al: 'allee',
  'al.': 'allee',
  allee: 'allee',
  gasse: 'gasse',
  ring: 'ring',
  damm: 'damm',
  ufer: 'ufer',
  chaussee: 'chaussee',
  promenade: 'promenade',
  steig: 'steig',
  stieg: 'stieg',
  pfad: 'pfad',
  brücke: 'bruecke',
  bruecke: 'bruecke',
};

/**
 * German umlaut replacements.
 */
const UMLAUT_MAP = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  Ä: 'ae',
  Ö: 'oe',
  Ü: 'ue',
};

/**
 * Replace German umlauts with their ASCII equivalents.
 *
 * @param {string} str - Input string.
 * @returns {string} String with umlauts replaced.
 */
export function replaceUmlauts(str) {
  if (!str) return '';
  return str.replace(/[äöüßÄÖÜ]/g, (match) => UMLAUT_MAP[match] || match);
}

/**
 * Extract German ZIP code (PLZ) from an address string.
 * German PLZ is always 5 digits.
 *
 * @param {string} address - The address string.
 * @returns {{ zipCode: string|null, addressWithoutZip: string }} The extracted ZIP and remaining address.
 */
export function extractZipCode(address) {
  if (!address) return { zipCode: null, addressWithoutZip: '' };

  // Match 5-digit German PLZ (may be preceded by D- or DE-)
  const zipMatch = address.match(/(?:^|[\s,])(?:D-?|DE-?)?(\d{5})(?:[\s,]|$)/);

  if (zipMatch) {
    const zipCode = zipMatch[1];
    const addressWithoutZip = address.replace(zipMatch[0], ' ').trim();
    return { zipCode, addressWithoutZip };
  }

  return { zipCode: null, addressWithoutZip: address };
}

/**
 * Extract house number from an address string.
 * Handles formats like: "Musterstr. 12", "Musterstr. 12a", "Musterstr. 12-14", "Musterstr. 12 a"
 *
 * @param {string} address - The address string.
 * @returns {{ houseNumber: string|null, addressWithoutNumber: string }} The extracted house number and remaining address.
 */
export function extractHouseNumber(address) {
  if (!address) return { houseNumber: null, addressWithoutNumber: '' };

  // Match house number patterns:
  // - Simple number: 12
  // - Number with letter: 12a, 12 a
  // - Range: 12-14
  // - Complex: 12a-14b
  const numberMatch = address.match(/\s(\d+(?:\s?[a-zA-Z])?(?:\s?[-–/]\s?\d+(?:\s?[a-zA-Z])?)?)(?:\s|,|$)/);

  if (numberMatch) {
    // Normalize house number: remove spaces, use lowercase
    const houseNumber = numberMatch[1].replace(/\s+/g, '').toLowerCase();
    const addressWithoutNumber = address.replace(numberMatch[0], ' ').trim();
    return { houseNumber, addressWithoutNumber };
  }

  return { houseNumber: null, addressWithoutNumber: address };
}

/**
 * Extract city name from address, handling district/quarter information.
 *
 * @param {string} address - The address string.
 * @returns {{ city: string|null, district: string|null }} City and district if found.
 */
export function extractCityAndDistrict(address) {
  if (!address) return { city: null, district: null };

  let district = null;

  // Check for district in parentheses: "Berlin (Charlottenburg)"
  const parenMatch = address.match(/([^(]+)\s*\(([^)]+)\)/);
  if (parenMatch) {
    district = parenMatch[2].trim();
  }

  // Check for district with dash: "Berlin-Charlottenburg"
  const dashMatch = address.match(/([A-Za-zäöüÄÖÜß]+)-([A-Za-zäöüÄÖÜß]+)(?:\s|,|$)/);
  if (dashMatch && !district) {
    // The first part is likely the city, second is district
    district = dashMatch[2];
  }

  // Try to extract city name (usually the last word before or after ZIP code)
  const { addressWithoutZip } = extractZipCode(address);
  const words = addressWithoutZip.split(/[\s,]+/).filter((w) => w.length > 0);

  // City is often the last significant word (excluding house numbers and street types)
  let city = null;
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    // Skip if it looks like a house number
    if (/^\d+[a-z]?$/.test(word)) continue;
    // Skip if it looks like a street type
    if (Object.keys(STREET_TYPE_MAPPINGS).includes(word.toLowerCase())) continue;
    // Skip small words
    if (word.length < 3) continue;

    city = word;
    break;
  }

  return { city, district };
}

/**
 * Normalize a street name by expanding abbreviations and standardizing format.
 *
 * @param {string} street - The street name.
 * @returns {string} Normalized street name.
 */
export function normalizeStreetName(street) {
  if (!street) return '';

  let normalized = street.toLowerCase();

  // Replace umlauts
  normalized = replaceUmlauts(normalized);

  // Remove common prefixes like "Am", "An der", "Im"
  normalized = normalized.replace(/^(am|an der|an dem|im|in der|in dem|auf der|auf dem|zur|zum)\s+/i, '');

  // Expand street type abbreviations
  for (const [abbr, full] of Object.entries(STREET_TYPE_MAPPINGS)) {
    // Match abbreviation at word boundary or end
    const pattern = new RegExp(`\\b${abbr.replace('.', '\\.')}\\b`, 'gi');
    normalized = normalized.replace(pattern, full);
  }

  // Remove extra whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

/**
 * Parse and normalize a complete German address into its components.
 *
 * @param {string} address - The full address string.
 * @returns {{
 *   original: string,
 *   normalized: string,
 *   zipCode: string|null,
 *   city: string|null,
 *   district: string|null,
 *   street: string|null,
 *   houseNumber: string|null
 * }} Parsed address components.
 */
export function parseAddress(address) {
  if (!address) {
    return {
      original: '',
      normalized: '',
      zipCode: null,
      city: null,
      district: null,
      street: null,
      houseNumber: null,
    };
  }

  const original = address;

  // Step 1: Extract ZIP code
  const { zipCode, addressWithoutZip } = extractZipCode(address);

  // Step 2: Extract house number
  const { houseNumber, addressWithoutNumber } = extractHouseNumber(addressWithoutZip);

  // Step 3: Extract city and district
  const { city, district } = extractCityAndDistrict(addressWithoutZip);

  // Step 4: What remains should be mostly the street name
  let street = addressWithoutNumber;

  // Remove city name from street if present
  if (city) {
    street = street.replace(new RegExp(`\\b${city}\\b`, 'gi'), '').trim();
  }

  // Remove district information
  street = street.replace(/\([^)]+\)/g, '').trim();

  // Remove commas and normalize
  street = street.replace(/,/g, ' ').trim();

  // Normalize the street name
  const normalizedStreet = normalizeStreetName(street);

  // Build normalized full address
  const parts = [];
  if (normalizedStreet) parts.push(normalizedStreet);
  if (houseNumber) parts.push(houseNumber);
  if (zipCode) parts.push(zipCode);
  if (city) parts.push(replaceUmlauts(city.toLowerCase()));

  const normalized = parts.join(' ');

  return {
    original,
    normalized,
    zipCode,
    city: city ? replaceUmlauts(city.toLowerCase()) : null,
    district: district ? replaceUmlauts(district.toLowerCase()) : null,
    street: normalizedStreet || null,
    houseNumber,
  };
}

/**
 * Compare two addresses and determine if they match.
 * Returns a score from 0-100 indicating match quality.
 *
 * @param {string} address1 - First address.
 * @param {string} address2 - Second address.
 * @returns {{ score: number, details: object }} Match score and detailed comparison.
 */
export function compareAddresses(address1, address2) {
  const parsed1 = parseAddress(address1);
  const parsed2 = parseAddress(address2);

  let score = 0;
  const details = {
    zipMatch: false,
    cityMatch: false,
    streetMatch: false,
    houseNumberMatch: false,
  };

  // ZIP code match (25 points)
  if (parsed1.zipCode && parsed2.zipCode) {
    if (parsed1.zipCode === parsed2.zipCode) {
      score += 25;
      details.zipMatch = true;
    }
  }

  // City match (15 points)
  if (parsed1.city && parsed2.city) {
    if (parsed1.city === parsed2.city) {
      score += 15;
      details.cityMatch = true;
    }
  }

  // Street name match (40 points, with fuzzy matching)
  if (parsed1.street && parsed2.street) {
    const streetScore = fuzzyStringMatch(parsed1.street, parsed2.street);
    score += Math.round(streetScore * 40);
    details.streetMatch = streetScore >= 0.8;
    details.streetSimilarity = streetScore;
  }

  // House number match (20 points)
  if (parsed1.houseNumber && parsed2.houseNumber) {
    // Normalize for comparison
    const norm1 = parsed1.houseNumber.replace(/[-–/]/g, '-');
    const norm2 = parsed2.houseNumber.replace(/[-–/]/g, '-');

    if (norm1 === norm2) {
      score += 20;
      details.houseNumberMatch = true;
    } else {
      // Partial match for ranges (e.g., "12" matches "12-14")
      const base1 = norm1.split('-')[0];
      const base2 = norm2.split('-')[0];
      if (base1 === base2) {
        score += 10;
        details.houseNumberPartialMatch = true;
      }
    }
  }

  return { score, details, parsed1, parsed2 };
}

/**
 * Simple fuzzy string matching using Levenshtein-like similarity.
 *
 * @param {string} str1 - First string.
 * @param {string} str2 - Second string.
 * @returns {number} Similarity score between 0 and 1.
 */
function fuzzyStringMatch(str1, str2) {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;

  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  // Check for substring containment
  if (s1.includes(s2) || s2.includes(s1)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    return minLen / maxLen;
  }

  // Token-based matching
  const tokens1 = s1.split(/\s+/);
  const tokens2 = s2.split(/\s+/);

  let matchedTokens = 0;
  for (const t1 of tokens1) {
    for (const t2 of tokens2) {
      if (t1 === t2 || t1.includes(t2) || t2.includes(t1)) {
        matchedTokens++;
        break;
      }
    }
  }

  const totalTokens = Math.max(tokens1.length, tokens2.length);
  return totalTokens > 0 ? matchedTokens / totalTokens : 0;
}
