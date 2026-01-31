/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';

/**
 * Regex patterns to identify document/plan images by their caption.
 * The mobile API does not structurally differentiate floor plans uploaded as PICTURE type
 * from regular photos. Caption matching is the only available signal.
 *
 * Safe patterns can match anywhere in the image list.
 * Trailing patterns are too ambiguous on their own (e.g. "EG" also appears in "Badezimmer EG")
 * but are used to detect the start of a trailing document zone — once any pattern matches
 * at the end of the list, all subsequent images are treated as documents too.
 */
const DOCUMENT_CAPTION_PATTERNS = [
  // Floor plans / layouts (German)
  /grundriss/i,
  /geschossplan/i,
  /wohnungsplan/i,
  /geb(ä|ae)udeplan/i,
  /etage(n)?plan/i,
  /raumaufteilung/i,
  /raumplan/i,
  /wohnungsspiegel/i,
  /aufteilungsplan/i,
  /bema(ß|ss)ung/i,
  /draufsicht/i,
  // Floor plans / layouts (English)
  /floor\s*plan/i,
  /blueprint/i,
  /site\s*plan/i,
  /plot\s*plan/i,
  // Technical drawings (German)
  /bauplan/i,
  /schnitt(zeichnung)?/i,
  /querschnitt/i,
  /l(ä|ae)ngsschnitt/i,
  /zeichnung/i,
  /skizze/i,
  // Technical drawings (English)
  /cross\s*section/i,
  /elevation/i,
  /schematic/i,
  /section\s*drawing/i,
  // Cadastral / legal (German)
  /flurkarte/i,
  /katasterplan/i,
  /teilungserkl(ä|ae)rung/i,
  /bebauungsplan/i,
  /liegenschaftskarte/i,
  // Area calculations (German)
  /wohnfl(ä|ae)chenberechnung/i,
  /fl(ä|ae)chenberechnung/i,
  // Energy
  /energieausweis/i,
  /energiepass/i,
  /energy\s*certificate/i,
  /energy\s*performance/i,
  // Site plans
  /lageplan/i,
];

/**
 * Patterns that are too ambiguous to use anywhere in the list, but reliably indicate
 * documents when they appear in the trailing section. Once any of these (or a safe pattern)
 * matches scanning from the end, all remaining trailing images become documents.
 */
const TRAILING_DOCUMENT_PATTERNS = [
  /^[UEO]G$/i, // UG, EG, OG as standalone captions
  /^DG$/i, // Dachgeschoss
  /^KG$/i, // Kellergeschoss
  /^[1-4]\.\s*OG$/i, // 1. OG, 2. OG, etc.
  /ansicht/i, // Hausansicht, Seitenansicht, etc.
  /plan$/i, // anything ending in "plan"
];

/**
 * Fetch detailed information for a single listing from the mobile API.
 * This includes additional fields not available in the list response,
 * such as all images, documents, energy data, etc.
 *
 * @param {string} listingId - The ImmoScout listing ID.
 * @returns {Promise<Object|null>} Extended listing details or null on error.
 */
export async function getListingDetails(listingId) {
  try {
    const response = await fetch(`https://api.mobile.immobilienscout24.de/expose/${listingId}`, {
      headers: {
        'User-Agent': 'ImmoScout_27.3_26.0_._',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      logger.debug(`Failed to fetch details for ImmoScout listing ${listingId}: ${response.status}`);
      return null;
    }

    const expose = await response.json();

    // Extract all available images from the sections array
    // API structure: { sections: [{ type: "MEDIA", media: [{ type: "PICTURE", fullImageUrl: "..." }] }] }
    const additionalImages = [];
    const documents = [];

    if (expose.sections && Array.isArray(expose.sections)) {
      for (const section of expose.sections) {
        // Extract images from MEDIA sections
        if (section.type === 'MEDIA' && Array.isArray(section.media)) {
          // Collect PICTURE items for two-pass classification
          const pictures = section.media.filter((m) => m.type === 'PICTURE');

          // Pass 1: Scan from the end to find where the trailing document zone starts.
          // Documents are typically appended after regular photos. Once we find a match
          // (safe or trailing pattern) scanning backwards, everything from that index on
          // is a document.
          let docZoneStart = pictures.length; // default: no document zone
          for (let i = pictures.length - 1; i >= 0; i--) {
            const caption = pictures[i].caption || '';
            const isSafe = DOCUMENT_CAPTION_PATTERNS.some((p) => p.test(caption));
            const isTrailing = TRAILING_DOCUMENT_PATTERNS.some((p) => p.test(caption));
            if (isSafe || isTrailing) {
              docZoneStart = i;
            } else {
              break; // stop as soon as we hit a regular photo
            }
          }

          // Pass 2: Classify each picture
          for (let i = 0; i < pictures.length; i++) {
            const media = pictures[i];
            const url = media.fullImageUrl || media.previewImageUrl || media.imageUrlForWeb;
            if (!url) continue;

            const caption = media.caption || '';
            const isSafeMatch = DOCUMENT_CAPTION_PATTERNS.some((p) => p.test(caption));
            const inDocZone = i >= docZoneStart;

            if (isSafeMatch || inDocZone) {
              if (!documents.some((d) => d.url === url)) {
                documents.push({
                  type: 'jpg',
                  url: url,
                  title: caption || 'Grundriss',
                });
              }
            } else if (!additionalImages.includes(url)) {
              additionalImages.push(url);
            }
          }

          // Handle non-PICTURE media types
          for (const media of section.media) {
            if (media.type === 'FLOOR_PLAN' || media.type === 'FLOORPLAN') {
              const url = media.fullImageUrl || media.previewImageUrl || media.url;
              if (url && !documents.some((d) => d.url === url)) {
                documents.push({
                  type: 'floorplan',
                  url: url,
                  title: media.caption || 'Grundriss',
                });
              }
            }
          }
        }

        // Extract PDFs directly from sections (they appear at section level, not in media)
        // Structure: { type: "PDF", label: "filename.pdf", url: "https://..." }
        if (section.type === 'PDF' && section.url) {
          if (!documents.some((d) => d.url === section.url)) {
            documents.push({
              type: 'pdf',
              url: section.url,
              title: section.label || 'Dokument.pdf',
            });
          }
        }

        // Also check for nested items with PDF type
        if (section.items && Array.isArray(section.items)) {
          for (const item of section.items) {
            if (item.type === 'PDF' && item.url) {
              if (!documents.some((d) => d.url === item.url)) {
                documents.push({
                  type: 'pdf',
                  url: item.url,
                  title: item.label || 'Dokument.pdf',
                });
              }
            }
          }
        }

        // Extract documents from REFERENCE_LIST sections (e.g., "Weitere Dokumente")
        // Structure: { type: "REFERENCE_LIST", title: "Weitere Dokumente", references: [{ type: "PDF"|"JPG"|..., label: "...", url: "..." }] }
        // All files in document sections should be treated as documents (PDF, JPG, PNG, etc.)
        if (section.type === 'REFERENCE_LIST' && Array.isArray(section.references)) {
          // Check if this is a document section (by title)
          const isDocumentSection =
            section.title &&
            (section.title.toLowerCase().includes('dokument') ||
              section.title.toLowerCase().includes('document') ||
              section.title.toLowerCase().includes('anhang') ||
              section.title.toLowerCase().includes('attachment'));

          for (const ref of section.references) {
            // Skip non-file references (buttons, links, etc.)
            if (!ref.url || ref.type === 'BUTTON' || ref.type === 'URL_LINK') {
              continue;
            }

            // Supported document types
            const docTypes = ['PDF', 'JPG', 'JPEG', 'PNG', 'GIF', 'TIFF', 'TIF', 'BMP', 'WEBP', 'IMAGE'];
            const refType = (ref.type || '').toUpperCase();

            if (docTypes.includes(refType)) {
              if (!documents.some((d) => d.url === ref.url)) {
                // Determine file type for naming
                const fileType = refType === 'IMAGE' ? 'jpg' : refType.toLowerCase();
                documents.push({
                  type: fileType,
                  url: ref.url,
                  title: ref.label || `Dokument.${fileType}`,
                });
              }
            } else if (isDocumentSection && ref.url) {
              // For document sections, include any file type we haven't seen
              if (!documents.some((d) => d.url === ref.url)) {
                // Try to determine type from URL
                const urlLower = ref.url.toLowerCase();
                let fileType = 'document';
                if (urlLower.includes('.pdf')) fileType = 'pdf';
                else if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) fileType = 'jpg';
                else if (urlLower.includes('.png')) fileType = 'png';

                documents.push({
                  type: fileType,
                  url: ref.url,
                  title: ref.label || 'Dokument',
                });
              }
            }
          }
        }
      }
    }

    logger.debug(
      `ImmoScout extracted ${additionalImages.length} images and ${documents.length} documents for listing ${listingId}`,
    );

    // Also check for documents in other locations (legacy API support)
    if (expose.documents && Array.isArray(expose.documents)) {
      for (const doc of expose.documents) {
        const url = doc.url || doc.href;
        if (url && !documents.some((d) => d.url === url)) {
          documents.push({
            type: doc.type || 'document',
            url: url,
            title: doc.title || doc.type || 'Dokument',
          });
        }
      }
    }

    if (expose.floorPlan && expose.floorPlan.url && !documents.some((d) => d.url === expose.floorPlan.url)) {
      documents.push({
        type: 'floorplan',
        url: expose.floorPlan.url,
        title: 'Grundriss',
      });
    }

    // Extract attributes from sections (label/text pairs)
    const attributes = {};
    const textAreas = {};
    let energyEfficiencyClass = null;
    let addressInfo = {};
    let agentInfo = {};

    if (expose.sections && Array.isArray(expose.sections)) {
      for (const section of expose.sections) {
        // Extract text/check attributes
        if (section.attributes && Array.isArray(section.attributes)) {
          for (const attr of section.attributes) {
            const label = (attr.label || '').replace(':', '').trim();
            if (attr.type === 'TEXT' && label && attr.text) {
              attributes[label] = attr.text;
            } else if (attr.type === 'CHECK' && label) {
              // CHECK type means the feature is present (e.g., "Gäste-WC:", "Keller:")
              attributes[label] = 'Ja';
            } else if (attr.type === 'IMAGE' && label === 'Energieeffizienzklasse' && attr.url) {
              // Extract energy class from image URL (e.g., "A-plus.png" -> "A+")
              const match = attr.url.match(/\/([A-H](?:-plus)?)\./i);
              if (match) {
                energyEfficiencyClass = match[1].replace('-plus', '+').toUpperCase();
              }
            }
          }
        }

        // Extract text areas (description, equipment, location, etc.)
        if (section.type === 'TEXT_AREA' && section.title && section.text) {
          textAreas[section.title] = section.text;
        }

        // Extract address from MAP section
        if (section.type === 'MAP') {
          addressInfo = {
            addressLine1: section.addressLine1,
            addressLine2: section.addressLine2,
            coordinates: section.coordinates,
          };
        }

        // Extract agent/seller information
        if (section.type === 'AGENTS_INFO') {
          agentInfo.company = section.company || null;
          agentInfo.name = section.name || null;
          agentInfo.address = section.address || null;
          if (section.rating) {
            agentInfo.rating = section.rating.value || null;
          }
          // Extract homepage from references
          const homepage = (section.references || []).find((r) => r.type === 'URL_LINK' && r.target === 'WEB');
          if (homepage) {
            agentInfo.website = homepage.url;
          }
        }

        // Extract agent phone numbers
        if (section.type === 'CONTACT' && section.phoneNumbers) {
          agentInfo.phoneNumbers = section.phoneNumbers
            .filter((p) => p.text)
            .map((p) => ({ label: p.label, number: p.text }));
        }
      }
    }

    // Parse helper functions
    const parseNumber = (str) => {
      if (!str) return null;
      const num = parseFloat(str.replace(/[^\d,.-]/g, '').replace(',', '.'));
      return isNaN(num) ? null : num;
    };

    const parseFloor = (str) => {
      if (!str) return null;
      const match = str.match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    };

    // Parse German date string "DD.MM.YYYY" to ms timestamp
    const parseGermanDate = (str) => {
      if (!str) return null;
      const match = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (!match) return null;
      const [, day, month, year] = match;
      const date = new Date(Number(year), Number(month) - 1, Number(day));
      return isNaN(date.getTime()) ? null : date.getTime();
    };

    // Extract publish date from attributes
    const publishDateStr = attributes['Erstaktivierung'] || attributes['Online seit'] || null;
    const publishedAt = parseGermanDate(publishDateStr);

    // Build extended details object
    const details = {
      rooms: parseNumber(attributes['Zimmer']) || null,
      floor: parseFloor(attributes['Etage']) || null,
      energyEfficiencyClass: energyEfficiencyClass || null,
      heatingType: attributes['Heizungsart'] || null,
      constructionYear: parseNumber(attributes['Baujahr']) || null,
      additionalImages,
      documents,
      publishedAt,
    };

    // Build change_set with additional data
    const changeSet = {};

    // Energy information
    if (attributes['Wesentliche Energieträger']) {
      changeSet.energySource = attributes['Wesentliche Energieträger'];
    }
    if (attributes['Endenergiebedarf']) {
      changeSet.energyConsumption = attributes['Endenergiebedarf'];
    }
    if (attributes['Energieausweistyp']) {
      changeSet.energyCertificateType = attributes['Energieausweistyp'];
    }
    if (attributes['Baujahr laut Energieausweis']) {
      changeSet.constructionYearEnergyCert = parseNumber(attributes['Baujahr laut Energieausweis']);
    }

    // Property details
    if (attributes['Objektzustand']) {
      changeSet.propertyCondition = attributes['Objektzustand'];
    }
    if (attributes['Grundstück'] || attributes['Grundstücksfläche']) {
      changeSet.lotSize = parseNumber(attributes['Grundstück'] || attributes['Grundstücksfläche']);
    }
    if (attributes['Garage/Stellplatz']) {
      changeSet.parkingType = attributes['Garage/Stellplatz'];
    }
    if (attributes['Anzahl Garage/Stellplatz']) {
      changeSet.parkingCount = parseNumber(attributes['Anzahl Garage/Stellplatz']);
    }
    if (attributes['Etagenzahl']) {
      changeSet.numberOfFloors = parseNumber(attributes['Etagenzahl']);
    }
    if (attributes['Nutzfläche']) {
      changeSet.usableArea = parseNumber(attributes['Nutzfläche']);
    }
    if (attributes['Wohnfläche']) {
      changeSet.livingArea = parseNumber(attributes['Wohnfläche']);
    }

    // Price information
    if (attributes['Preis/m²']) {
      changeSet.pricePerSqm = attributes['Preis/m²'];
    }
    if (attributes['Kaufpreis']) {
      changeSet.purchasePrice = attributes['Kaufpreis'];
    }

    // Renovation/modernization
    if (attributes['Letzte Modernisierung/ Sanierung'] || attributes['Letzte Modernisierung/Sanierung']) {
      changeSet.renovationYear = parseNumber(
        attributes['Letzte Modernisierung/ Sanierung'] || attributes['Letzte Modernisierung/Sanierung'],
      );
    }

    // House type
    if (attributes['Haustyp']) {
      changeSet.houseType = attributes['Haustyp'];
    }

    // Room details
    if (attributes['Schlafzimmer']) {
      changeSet.bedrooms = parseNumber(attributes['Schlafzimmer']);
    }
    if (attributes['Badezimmer']) {
      changeSet.bathrooms = parseNumber(attributes['Badezimmer']);
    }

    // Availability
    if (attributes['Bezugsfrei ab']) {
      changeSet.availableFrom = attributes['Bezugsfrei ab'];
    }

    // Text descriptions
    if (textAreas['Objektbeschreibung']) {
      changeSet.objectDescription = textAreas['Objektbeschreibung'];
    }
    if (textAreas['Ausstattung']) {
      changeSet.equipmentDescription = textAreas['Ausstattung'];
    }
    if (textAreas['Lage']) {
      changeSet.locationDescription = textAreas['Lage'];
    }
    if (textAreas['Sonstiges']) {
      changeSet.otherInfo = textAreas['Sonstiges'];
    }

    // Address information
    // Extract district/quarter from adTargetingParameters (most reliable source)
    if (expose.adTargetingParameters?.obj_regio4) {
      changeSet.district = expose.adTargetingParameters.obj_regio4;
    }
    if (addressInfo.addressLine2) {
      changeSet.addressLine = addressInfo.addressLine2;
    }

    // Agent / seller information
    if (Object.keys(agentInfo).length > 0) {
      changeSet.agent = agentInfo;
    }

    // Extract amenities from various attributes
    const amenities = [];
    if (attributes['Balkon/Terrasse']) amenities.push('Balkon/Terrasse');
    if (attributes['Einbauküche'] === 'Ja') amenities.push('Einbauküche');
    if (attributes['Keller'] === 'Ja') amenities.push('Keller');
    if (attributes['Aufzug'] === 'Ja') amenities.push('Aufzug');
    if (attributes['Garten/-mitbenutzung'] === 'Ja') amenities.push('Garten');
    if (attributes['Gäste-WC'] === 'Ja') amenities.push('Gäste-WC');
    if (attributes['Qualität der Ausstattung']) {
      changeSet.equipmentQuality = attributes['Qualität der Ausstattung'];
    }

    if (amenities.length > 0) {
      changeSet.amenities = amenities;
    }

    // Store all raw attributes for reference
    if (Object.keys(attributes).length > 0) {
      changeSet.rawAttributes = attributes;
    }

    if (Object.keys(changeSet).length > 0) {
      details.changeSet = changeSet;
    }

    return details;
  } catch (error) {
    logger.error(`Error fetching details for ImmoScout listing ${listingId}:`, error.message);
    return null;
  }
}
