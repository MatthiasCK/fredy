/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Modal,
  Typography,
  Descriptions,
  ImagePreview,
  Space,
  Tag,
  Divider,
  Spin,
  Empty,
  Button,
} from '@douyinfe/semi-ui';
import { IconMapPin, IconLink, IconHistory, IconStar, IconChevronLeft, IconChevronRight } from '@douyinfe/semi-icons';
import { xhrGet } from '../../services/xhr.js';
import * as timeService from '../../services/time/timeService.js';
import VersionTimeline from './VersionTimeline.jsx';
import no_image from '../../assets/no_image.jpg';

import './ListingDetailModal.less';

const { Title, Text } = Typography;

/**
 * Format address with district if available from change_set
 */
const formatAddress = (listing) => {
  if (!listing) return 'No address provided';

  // Extract district from change_set
  const district = listing.change_set?.district || null;
  const address = listing.address || '';

  // If district exists and is not already part of the address, prepend it
  if (district && !address.includes(district)) {
    return `${district}, ${address}`;
  }

  return address || 'No address provided';
};

const ListingDetailModal = ({ visible, listingId, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [listing, setListing] = useState(null);
  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [heroIndex, setHeroIndex] = useState(0);
  const [previewVisible, setPreviewVisible] = useState(false);
  const thumbnailRowRef = useRef(null);

  useEffect(() => {
    if (visible && listingId) {
      loadListingDetails();
      loadVersionHistory();
    } else {
      setListing(null);
      setVersions([]);
      setHeroIndex(0);
    }
  }, [visible, listingId]);

  // Keyboard arrow navigation (works in both gallery and fullscreen lightbox)
  useEffect(() => {
    if (!visible || !listing) return;
    const handleKeyDown = (e) => {
      const images = getAllImages();
      if (images.length <= 1) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setHeroIndex((prev) => (prev - 1 + images.length) % images.length);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setHeroIndex((prev) => (prev + 1) % images.length);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, listing]);

  // Auto-scroll thumbnail row to keep active thumbnail visible
  useEffect(() => {
    const row = thumbnailRowRef.current;
    if (!row) return;
    const thumb = row.children[heroIndex];
    if (!thumb) return;
    const rowRect = row.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    if (thumbRect.left < rowRect.left || thumbRect.right > rowRect.right) {
      thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [heroIndex]);

  const scrollThumbnails = useCallback((direction) => {
    const row = thumbnailRowRef.current;
    if (!row) return;
    row.scrollBy({ left: direction * 240, behavior: 'smooth' });
  }, []);

  const loadListingDetails = async () => {
    setLoading(true);
    try {
      const response = await xhrGet(`/api/listings/details/${listingId}`);
      setListing(response.json);
    } catch (error) {
      console.error('Failed to load listing details:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadVersionHistory = async () => {
    setVersionsLoading(true);
    try {
      const response = await xhrGet(`/api/listings/versions/${listingId}`);
      setVersions(response.json?.versions || []);
    } catch (error) {
      console.error('Failed to load version history:', error);
    } finally {
      setVersionsLoading(false);
    }
  };

  const formatPrice = (price) => {
    if (price == null) return 'N/A';
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
    }).format(price);
  };

  const formatSize = (size) => {
    if (size == null) return 'N/A';
    return `${size} m²`;
  };

  const getEnergyClassColor = (energyClass) => {
    const colors = {
      'A+': 'green',
      A: 'green',
      B: 'lime',
      C: 'yellow',
      D: 'orange',
      E: 'orange',
      F: 'red',
      G: 'red',
      H: 'red',
    };
    return colors[energyClass] || 'grey';
  };

  // Collect all image URLs for the gallery
  const getAllImages = () => {
    if (!listing) return [];

    // Local images: first entry is the low-quality main thumbnail,
    // the gallery images (from index 1 onward) already contain the
    // full-quality version, so skip the first one to avoid duplicates.
    if (listing.local_images && listing.local_images.length > 1) {
      return listing.local_images.slice(1).map((path) => {
        const filename = path.split('/').pop();
        return `/api/media/${listing.hash}/images/${filename}`;
      });
    }
    if (listing.local_images && listing.local_images.length === 1) {
      const filename = listing.local_images[0].split('/').pop();
      return [`/api/media/${listing.hash}/images/${filename}`];
    }

    // Fallback to remote URLs
    const images = [];
    if (listing.image_url) {
      images.push(listing.image_url);
    }
    if (listing.change_set?.additionalImages) {
      listing.change_set.additionalImages.forEach((url) => {
        if (url !== listing.image_url) {
          images.push(url);
        }
      });
    }

    return images.length > 0 ? images : [no_image];
  };

  const renderExtendedDetails = () => {
    if (!listing) return null;

    const cs = listing.change_set || {};
    const data = [];

    // Price information
    data.push({ key: 'Preis', value: formatPrice(listing.price) });
    if (cs.pricePerSqm) {
      data.push({ key: 'Preis/m² (Wohnen)', value: cs.pricePerSqm });
    }
    if (cs.lotSize && listing.price) {
      const pricePerSqmPlot = Math.round(listing.price / cs.lotSize);
      data.push({ key: 'Preis/m² (Grundstück)', value: `${pricePerSqmPlot.toLocaleString('de-DE')} €/m²` });
    }

    // Size information
    data.push({ key: 'Wohnfläche', value: formatSize(listing.size) });
    if (cs.lotSize) {
      data.push({ key: 'Grundstücksfläche', value: `${cs.lotSize} m²` });
    }
    if (cs.usableArea) {
      data.push({ key: 'Nutzfläche', value: `${cs.usableArea} m²` });
    }

    // Room information
    if (listing.rooms) {
      data.push({ key: 'Zimmer', value: listing.rooms });
    }
    if (cs.bedrooms) {
      data.push({ key: 'Schlafzimmer', value: cs.bedrooms });
    }
    if (cs.bathrooms) {
      data.push({ key: 'Badezimmer', value: cs.bathrooms });
    }
    if (cs.numberOfFloors) {
      data.push({ key: 'Etagenzahl', value: cs.numberOfFloors });
    }
    if (listing.floor != null) {
      data.push({ key: 'Etage', value: listing.floor === 0 ? 'Erdgeschoss' : `${listing.floor}. Etage` });
    }

    // Building information
    if (cs.houseType) {
      data.push({ key: 'Haustyp', value: cs.houseType });
    }
    if (listing.construction_year) {
      data.push({ key: 'Baujahr', value: listing.construction_year });
    }
    if (cs.renovationYear) {
      data.push({ key: 'Sanierung/Modernisierung', value: cs.renovationYear });
    }
    if (cs.propertyCondition) {
      data.push({ key: 'Objektzustand', value: cs.propertyCondition });
    }
    if (cs.equipmentQuality) {
      data.push({ key: 'Ausstattungsqualität', value: cs.equipmentQuality });
    }

    // Parking
    if (cs.parkingType) {
      const parkingValue = cs.parkingCount ? `${cs.parkingType} (${cs.parkingCount})` : cs.parkingType;
      data.push({ key: 'Garage/Stellplatz', value: parkingValue });
    }

    // Energy information
    if (listing.energy_efficiency_class) {
      data.push({
        key: 'Energieeffizienzklasse',
        value: (
          <Tag color={getEnergyClassColor(listing.energy_efficiency_class)}>{listing.energy_efficiency_class}</Tag>
        ),
      });
    }
    if (cs.energyConsumption) {
      data.push({ key: 'Endenergiebedarf', value: cs.energyConsumption });
    }
    if (cs.energySource) {
      data.push({ key: 'Energieträger', value: cs.energySource });
    }
    if (listing.heating_type) {
      data.push({ key: 'Heizungsart', value: listing.heating_type });
    }
    if (cs.energyCertificateType) {
      data.push({ key: 'Energieausweistyp', value: cs.energyCertificateType });
    }
    if (cs.constructionYearEnergyCert) {
      data.push({ key: 'Baujahr lt. Energieausweis', value: cs.constructionYearEnergyCert });
    }

    // Availability
    if (cs.availableFrom) {
      data.push({ key: 'Bezugsfrei ab', value: cs.availableFrom });
    }

    return <Descriptions data={data} row size="small" />;
  };

  const renderAmenities = () => {
    const amenities = listing?.change_set?.amenities;
    if (!amenities || amenities.length === 0) return null;

    return (
      <div className="listingDetail__amenities">
        <Text strong>Amenities</Text>
        <Space wrap style={{ marginTop: 8 }}>
          {amenities.map((amenity, index) => (
            <Tag key={index} color="blue">
              {amenity}
            </Tag>
          ))}
        </Space>
      </div>
    );
  };

  const renderDocuments = () => {
    const documents = listing?.local_documents || listing?.change_set?.documents;
    if (!documents || documents.length === 0) return null;

    return (
      <div className="listingDetail__documents">
        <Text strong>Documents</Text>
        <Space wrap style={{ marginTop: 8 }}>
          {documents.map((doc, index) => {
            const isLocal = doc.path != null;
            const url = isLocal ? `/api/media/${listing.hash}/documents/${doc.path.split('/').pop()}` : doc.url;

            return (
              <Button key={index} size="small" onClick={() => window.open(url, '_blank')}>
                {doc.title || doc.type || 'Document'}
              </Button>
            );
          })}
        </Space>
      </div>
    );
  };

  const renderAgentInfo = () => {
    const agent = listing?.change_set?.agent;
    if (!agent) return null;

    return (
      <div className="listingDetail__agent">
        <Divider margin={16} />
        <Text strong>Anbieter</Text>
        <div style={{ marginTop: 8 }}>
          <Descriptions
            row
            size="small"
            data={[
              agent.company && { key: 'Firma', value: agent.company },
              agent.name && { key: 'Ansprechpartner', value: agent.name },
              agent.address && {
                key: 'Adresse',
                value: agent.address.replace(/\n/g, ', '),
              },
              agent.rating && {
                key: 'Bewertung',
                value: (
                  <Space>
                    <IconStar style={{ color: '#f5a623' }} />
                    <Text>{agent.rating} / 5</Text>
                  </Space>
                ),
              },
              agent.website && {
                key: 'Website',
                value: (
                  <a href={agent.website} target="_blank" rel="noopener noreferrer">
                    {agent.website}
                  </a>
                ),
              },
              ...(agent.phoneNumbers || []).map((p) => ({
                key: p.label || 'Telefon',
                value: <a href={`tel:${p.number}`}>{p.number}</a>,
              })),
            ].filter(Boolean)}
          />
        </div>
      </div>
    );
  };

  return (
    <Modal
      title={null}
      visible={visible}
      onCancel={onClose}
      footer={null}
      width={800}
      className="listingDetailModal"
      bodyStyle={{ padding: 0 }}
    >
      {loading ? (
        <div className="listingDetail__loading">
          <Spin size="large" />
        </div>
      ) : !listing ? (
        <Empty description="Listing not found" />
      ) : (
        <div className="listingDetail">
          {/* Image Gallery */}
          {(() => {
            const images = getAllImages();
            return (
              <>
                <ImagePreview
                  src={images}
                  visible={previewVisible}
                  currentIndex={heroIndex}
                  onVisibleChange={(v) => setPreviewVisible(v)}
                  onChange={(idx) => setHeroIndex(idx)}
                />
                <div className="listingDetail__gallery">
                  <div className="listingDetail__heroImage">
                    <img
                      src={images[heroIndex]}
                      onError={(e) => {
                        e.target.src = no_image;
                      }}
                      onClick={() => setPreviewVisible(true)}
                      alt=""
                    />
                    {images.length > 1 && (
                      <>
                        <div className="listingDetail__imageCount">
                          {heroIndex + 1} / {images.length}
                        </div>
                        <button
                          className="listingDetail__navBtn listingDetail__navBtn--left"
                          onClick={() => setHeroIndex((heroIndex - 1 + images.length) % images.length)}
                        >
                          <IconChevronLeft size="large" />
                        </button>
                        <button
                          className="listingDetail__navBtn listingDetail__navBtn--right"
                          onClick={() => setHeroIndex((heroIndex + 1) % images.length)}
                        >
                          <IconChevronRight size="large" />
                        </button>
                      </>
                    )}
                  </div>
                  {images.length > 1 && (
                    <div className="listingDetail__thumbnailStrip">
                      <button
                        className="listingDetail__thumbNav listingDetail__thumbNav--left"
                        onClick={() => scrollThumbnails(-1)}
                      >
                        <IconChevronLeft />
                      </button>
                      <div className="listingDetail__thumbnailRow" ref={thumbnailRowRef}>
                        {images.map((img, index) => (
                          <div
                            key={index}
                            className={`listingDetail__thumbnail${index === heroIndex ? ' listingDetail__thumbnail--active' : ''}`}
                            onClick={() => setHeroIndex(index)}
                          >
                            <img
                              src={img}
                              onError={(e) => {
                                e.target.src = no_image;
                              }}
                              alt=""
                            />
                          </div>
                        ))}
                      </div>
                      <button
                        className="listingDetail__thumbNav listingDetail__thumbNav--right"
                        onClick={() => scrollThumbnails(1)}
                      >
                        <IconChevronRight />
                      </button>
                    </div>
                  )}
                </div>
              </>
            );
          })()}

          {/* Content */}
          <div className="listingDetail__content">
            {/* Header */}
            <div className="listingDetail__header">
              <Title heading={4} ellipsis={{ rows: 2 }}>
                {listing.title}
              </Title>
              <Space>
                <Tag color="blue">{listing.provider}</Tag>
                {listing.is_active === 0 && (
                  <Tag color="red">
                    {listing.deactivated_at
                      ? `Inactive since ${timeService.format(listing.deactivated_at, false)}`
                      : 'Inactive'}
                  </Tag>
                )}
                {listing.previous_version_id && (
                  <Tag color="orange" icon={<IconHistory />}>
                    Has History
                  </Tag>
                )}
              </Space>
            </div>

            {/* Address */}
            <div className="listingDetail__address">
              <IconMapPin />
              <Text>{formatAddress(listing)}</Text>
            </div>

            {/* Meta info */}
            <Space className="listingDetail__meta">
              <Text type="tertiary" size="small">
                Provider: {listing.provider}
              </Text>
              {listing.published_at && (
                <Text type="tertiary" size="small">
                  Published: {timeService.format(listing.published_at, false)}
                </Text>
              )}
              <Text type="tertiary" size="small">
                Found: {timeService.format(listing.created_at, false)}
              </Text>
              {listing.job_name && (
                <Text type="tertiary" size="small">
                  Job: {listing.job_name}
                </Text>
              )}
              {listing.duration_days != null && (
                <Text type="tertiary" size="small">
                  Duration: {listing.duration_days} {listing.duration_days === 1 ? 'day' : 'days'}
                </Text>
              )}
            </Space>

            <Divider margin={16} />

            {/* Extended Details */}
            {renderExtendedDetails()}

            {/* Amenities */}
            {renderAmenities()}

            {/* Documents */}
            {renderDocuments()}

            {/* Object Description */}
            {(listing.change_set?.objectDescription || listing.description) && (
              <div className="listingDetail__description">
                <Divider margin={16} />
                <Text strong>Objektbeschreibung</Text>
                <Text style={{ display: 'block', marginTop: 8, whiteSpace: 'pre-wrap' }}>
                  {listing.change_set?.objectDescription || listing.description}
                </Text>
              </div>
            )}

            {/* Equipment Description */}
            {listing.change_set?.equipmentDescription && (
              <div className="listingDetail__equipment">
                <Divider margin={16} />
                <Text strong>Ausstattung</Text>
                <Text style={{ display: 'block', marginTop: 8, whiteSpace: 'pre-wrap' }}>
                  {listing.change_set.equipmentDescription}
                </Text>
              </div>
            )}

            {/* Location Description */}
            {listing.change_set?.locationDescription && (
              <div className="listingDetail__location">
                <Divider margin={16} />
                <Text strong>Lage</Text>
                <Text style={{ display: 'block', marginTop: 8, whiteSpace: 'pre-wrap' }}>
                  {listing.change_set.locationDescription}
                </Text>
              </div>
            )}

            {/* Other Info */}
            {listing.change_set?.otherInfo && (
              <div className="listingDetail__other">
                <Divider margin={16} />
                <Text strong>Sonstiges</Text>
                <Text style={{ display: 'block', marginTop: 8, whiteSpace: 'pre-wrap' }}>
                  {listing.change_set.otherInfo}
                </Text>
              </div>
            )}

            {/* Agent / Seller Information */}
            {renderAgentInfo()}

            <Divider margin={16} />

            {/* Version History */}
            {versionsLoading ? (
              <div style={{ textAlign: 'center', padding: 16 }}>
                <Spin />
              </div>
            ) : (
              versions.length > 0 && (
                <div className="listingDetail__versions">
                  <Text strong>Listing History</Text>
                  <VersionTimeline versions={versions} currentId={listingId} />
                </div>
              )
            )}

            <Divider margin={16} />

            {/* Actions */}
            <div className="listingDetail__actions">
              <Button type="primary" icon={<IconLink />} onClick={() => window.open(listing.link, '_blank')}>
                View Original
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default ListingDetailModal;
