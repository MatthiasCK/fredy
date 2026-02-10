/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import { Card, Typography, Tag, Space, Progress, Descriptions, Tooltip, Button } from '@douyinfe/semi-ui-19';
import { IconLink, IconUnlink, IconMapPin, IconTick, IconClose } from '@douyinfe/semi-icons';
import no_image from '../../assets/no_image.jpg';

import './SimilarityMatchCard.less';

const { Text, Title } = Typography;

/**
 * Card component displaying a potential similarity match with score details.
 */
const SimilarityMatchCard = ({ listing, similarity, isLinked, onLink, onUnlink, onSelect }) => {
  // Defensive: handle missing similarity data
  if (!similarity || !listing) {
    return null;
  }
  const { score = 0, confidence = 'none', factors = {}, recommendation = '' } = similarity;

  const getConfidenceColor = (conf) => {
    switch (conf) {
      case 'high':
        return 'green';
      case 'medium':
        return 'orange';
      case 'low':
        return 'yellow';
      default:
        return 'grey';
    }
  };

  const getScoreColor = (s) => {
    if (s >= 80) return 'var(--semi-color-success)';
    if (s >= 60) return 'var(--semi-color-warning)';
    if (s >= 40) return 'var(--semi-color-tertiary)';
    return 'var(--semi-color-danger)';
  };

  const formatPrice = (price) => {
    if (price == null) return 'N/A';
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
    }).format(price);
  };

  const renderFactorIndicator = (factor, label, maxPoints) => {
    if (!factor || factor.available === false) {
      return (
        <div className="similarityCard__factor similarityCard__factor--unavailable">
          <Text type="tertiary" size="small">
            {label}: N/A
          </Text>
        </div>
      );
    }

    const percentage = (factor.points / maxPoints) * 100;
    const isGood = percentage >= 80;
    const isMedium = percentage >= 50 && percentage < 80;

    return (
      <Tooltip
        content={
          <div>
            <div>
              Points: {factor.points}/{maxPoints}
            </div>
            {factor.distance != null && <div>Distance: {Math.round(factor.distance)}m</div>}
            {factor.percentDiff != null && <div>Difference: {factor.percentDiff}%</div>}
            {factor.match && <div>Match type: {factor.match}</div>}
          </div>
        }
      >
        <div className="similarityCard__factor">
          <Text size="small">{label}:</Text>
          <span
            className={`similarityCard__factorIcon ${isGood ? 'similarityCard__factorIcon--good' : isMedium ? 'similarityCard__factorIcon--medium' : 'similarityCard__factorIcon--poor'}`}
          >
            {isGood ? <IconTick size="small" /> : isMedium ? '~' : <IconClose size="small" />}
          </span>
        </div>
      </Tooltip>
    );
  };

  return (
    <Card
      className={`similarityCard ${isLinked ? 'similarityCard--linked' : ''}`}
      shadows="hover"
      bodyStyle={{ padding: 12 }}
    >
      <div className="similarityCard__content" onClick={() => onSelect && onSelect(listing)}>
        {/* Image */}
        <div className="similarityCard__image">
          <img src={listing.image_url || no_image} alt="" onError={(e) => (e.target.src = no_image)} />
          {isLinked && (
            <div className="similarityCard__linkedBadge">
              <IconLink size="small" />
              Linked
            </div>
          )}
        </div>

        {/* Details */}
        <div className="similarityCard__details">
          <div className="similarityCard__header">
            <Title heading={6} ellipsis={{ rows: 1 }} className="similarityCard__title">
              {listing.title || 'Untitled'}
            </Title>
            <div className="similarityCard__score">
              <Progress
                percent={score}
                size="small"
                type="circle"
                width={40}
                stroke={getScoreColor(score)}
                format={() => score}
              />
            </div>
          </div>

          <div className="similarityCard__address">
            <IconMapPin size="small" />
            <Text size="small" ellipsis>
              {listing.address || 'No address'}
            </Text>
          </div>

          <Space className="similarityCard__meta">
            <Tag size="small">{listing.provider}</Tag>
            <Tag size="small" color={getConfidenceColor(confidence)}>
              {confidence} confidence
            </Tag>
          </Space>

          <Descriptions
            row
            size="small"
            className="similarityCard__props"
            data={[
              { key: 'Price', value: formatPrice(listing.price) },
              { key: 'Size', value: listing.size ? `${listing.size} m²` : 'N/A' },
              { key: 'Rooms', value: listing.rooms || 'N/A' },
            ]}
          />

          {/* Factor breakdown */}
          <div className="similarityCard__factors">
            {renderFactorIndicator(factors.address, 'Address', 40)}
            {renderFactorIndicator(factors.size, 'Size', 20)}
            {renderFactorIndicator(factors.geo, 'Location', 20)}
            {renderFactorIndicator(factors.rooms, 'Rooms', 10)}
            {renderFactorIndicator(factors.price, 'Price', 10)}
          </div>

          <Text size="small" type="tertiary" className="similarityCard__recommendation">
            {recommendation}
          </Text>
        </div>
      </div>

      {/* Actions */}
      <div className="similarityCard__actions">
        {isLinked ? (
          <Button
            size="small"
            type="danger"
            theme="light"
            icon={<IconUnlink />}
            onClick={(e) => {
              e.stopPropagation();
              onUnlink && onUnlink(listing);
            }}
          >
            Unlink
          </Button>
        ) : (
          <Button
            size="small"
            type="primary"
            theme="light"
            icon={<IconLink />}
            onClick={(e) => {
              e.stopPropagation();
              onLink && onLink(listing);
            }}
          >
            Link as Same Property
          </Button>
        )}
      </div>
    </Card>
  );
};

export default SimilarityMatchCard;
