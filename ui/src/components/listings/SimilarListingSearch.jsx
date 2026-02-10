/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useState, useEffect } from 'react';
import { Modal, Typography, Slider, Select, Spin, Empty, Divider } from '@douyinfe/semi-ui-19';
import { xhrGet, xhrPost, xhrDelete } from '../../services/xhr.js';
import SimilarityMatchCard from './SimilarityMatchCard.jsx';

import './SimilarListingSearch.less';

const { Text, Title } = Typography;

/**
 * Modal for searching and displaying potential similar listings.
 */
const SimilarListingSearch = ({ visible, listingId, listing, onClose, onLinkChange }) => {
  const [loading, setLoading] = useState(false);
  const [similar, setSimilar] = useState([]);
  const [minScore, setMinScore] = useState(30);
  const [jobScope, setJobScope] = useState('all');
  const [totalCandidates, setTotalCandidates] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (visible && listingId) {
      loadSimilarListings();
    } else {
      setSimilar([]);
      setError(null);
    }
  }, [visible, listingId, minScore, jobScope]);

  const loadSimilarListings = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        minScore: minScore.toString(),
        maxResults: '20',
        jobScope,
      });
      const response = await xhrGet(`/api/similarity/similar/${listingId}?${params}`);

      // Check for error status (xhrGet returns 'status', not 'statusCode')
      if (response.status && response.status >= 400) {
        setError(response.json?.message || `Error: ${response.status}`);
        setSimilar([]);
        setTotalCandidates(0);
        return;
      }

      setSimilar(response.json?.similar || []);
      setTotalCandidates(response.json?.totalCandidates || 0);
    } catch (err) {
      console.error('Failed to load similar listings:', err);
      // Handle rejected promise from xhrGet (4xx/5xx responses)
      const errorMessage = err?.json?.message || err?.message || 'Failed to load similar listings. Please try again.';
      setError(errorMessage);
      setSimilar([]);
      setTotalCandidates(0);
    } finally {
      setLoading(false);
    }
  };

  const handleLink = async (targetListing) => {
    try {
      const response = await xhrPost('/api/similarity/link', {
        listingId: listingId,
        linkedListingId: targetListing.id,
      });

      if (response.json?.success) {
        // Update local state to show linked status
        setSimilar((prev) =>
          prev.map((item) =>
            item.listing.id === targetListing.id || item.listing.hash === targetListing.hash
              ? { ...item, isLinked: true }
              : item,
          ),
        );
        onLinkChange && onLinkChange();
      } else {
        setError(response.json?.message || 'Failed to link listings');
      }
    } catch (error) {
      console.error('Failed to link listings:', error);
      setError('Failed to link listings');
    }
  };

  const handleUnlink = async (targetListing) => {
    try {
      const response = await xhrDelete('/api/similarity/link', {
        listingId: listingId,
        linkedListingId: targetListing.id,
      });

      if (response.json?.success) {
        setSimilar((prev) =>
          prev.map((item) =>
            item.listing.id === targetListing.id || item.listing.hash === targetListing.hash
              ? { ...item, isLinked: false }
              : item,
          ),
        );
        onLinkChange && onLinkChange();
      }
    } catch (error) {
      console.error('Failed to unlink listings:', error);
      setError('Failed to remove link');
    }
  };

  const handleSelectListing = (targetListing) => {
    window.open(targetListing.link, '_blank');
  };

  const formatPrice = (price) => {
    if (price == null) return 'N/A';
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
    }).format(price);
  };

  return (
    <Modal
      title="Find Similar Listings"
      visible={visible}
      onCancel={onClose}
      footer={null}
      width={700}
      className="similarListingSearch"
      bodyStyle={{ maxHeight: '70vh', overflow: 'auto' }}
    >
      {/* Current Listing Summary */}
      {listing && (
        <div className="similarListingSearch__current">
          <Title heading={6}>Comparing:</Title>
          <div className="similarListingSearch__currentInfo">
            <Text strong ellipsis>
              {listing.title}
            </Text>
            <Text type="tertiary" size="small">
              {listing.address} • {formatPrice(listing.price)} • {listing.size ? `${listing.size} m²` : 'N/A'}
            </Text>
          </div>
        </div>
      )}

      <Divider margin={16} />

      {/* Filters */}
      <div className="similarListingSearch__filters">
        <div className="similarListingSearch__filter">
          <Text size="small">Minimum Score:</Text>
          <Slider value={minScore} onChange={setMinScore} min={10} max={90} step={5} style={{ width: 200 }} />
          <Text size="small" type="tertiary">
            {minScore}%
          </Text>
        </div>

        <div className="similarListingSearch__filter">
          <Text size="small">Search Scope:</Text>
          <Select value={jobScope} onChange={setJobScope} style={{ width: 160 }}>
            <Select.Option value="all">All Jobs</Select.Option>
            <Select.Option value="same">Same Job Only</Select.Option>
          </Select>
        </div>
      </div>

      <Divider margin={16} />

      {/* Results */}
      <div className="similarListingSearch__results">
        {loading ? (
          <div className="similarListingSearch__loading">
            <Spin size="large" />
            <Text type="tertiary">Searching for similar listings...</Text>
          </div>
        ) : error ? (
          <Empty description={error} />
        ) : similar.length === 0 ? (
          <Empty
            description={`No listings with similarity score above ${minScore}% were found among ${totalCandidates} candidates.`}
          />
        ) : (
          <>
            <Text type="tertiary" size="small" style={{ marginBottom: 12, display: 'block' }}>
              Found {similar.length} potential matches from {totalCandidates} candidates
            </Text>

            {similar.map((match, index) => (
              <SimilarityMatchCard
                key={match.listing.id || index}
                listing={match.listing}
                similarity={match.similarity}
                isLinked={match.isLinked}
                onLink={handleLink}
                onUnlink={handleUnlink}
                onSelect={handleSelectListing}
              />
            ))}
          </>
        )}
      </div>
    </Modal>
  );
};

export default SimilarListingSearch;
