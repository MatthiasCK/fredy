/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import { Timeline, Typography, Tag, Space, Button } from '@douyinfe/semi-ui';
import { IconArrowUp, IconArrowDown, IconMinus, IconUnlink, IconLink } from '@douyinfe/semi-icons';
import * as timeService from '../../services/time/timeService.js';

import './VersionTimeline.less';

const { Text } = Typography;

const VersionTimeline = ({ versions, currentId, onVersionClick, onUnlinkManual, onUnlinkAuto, currentListingId }) => {
  if (!versions || versions.length === 0) {
    return <Text type="tertiary">No version history available</Text>;
  }

  const formatPrice = (price) => {
    if (price == null) return 'N/A';
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
    }).format(price);
  };

  const getPriceChangeIcon = (currentPrice, previousPrice) => {
    if (currentPrice == null || previousPrice == null) return null;
    if (currentPrice > previousPrice) {
      return <IconArrowUp style={{ color: 'red' }} />;
    } else if (currentPrice < previousPrice) {
      return <IconArrowDown style={{ color: 'green' }} />;
    }
    return <IconMinus style={{ color: 'grey' }} />;
  };

  const getPriceChangePercent = (currentPrice, previousPrice) => {
    if (currentPrice == null || previousPrice == null || previousPrice === 0) return null;
    const change = ((currentPrice - previousPrice) / previousPrice) * 100;
    return change.toFixed(1);
  };

  const computeDuration = (version) => {
    const start = version.published_at || version.created_at;
    const end = version.deactivated_at || (version.is_active === 1 ? Date.now() : null);
    if (!start || !end) return null;
    return Math.round((end - start) / 86400000);
  };

  // Sort versions by published_at (or created_at as fallback) descending (newest first)
  const sortedVersions = [...versions].sort((a, b) => {
    const dateA = a.published_at || a.created_at;
    const dateB = b.published_at || b.created_at;
    return dateB - dateA;
  });

  return (
    <div className="versionTimeline">
      <Timeline>
        {sortedVersions.map((version, index) => {
          const isCurrentVersion = version.id === currentId;
          const previousVersion = sortedVersions[index + 1];
          const priceChange = previousVersion ? getPriceChangePercent(version.price, previousVersion.price) : null;
          const duration = computeDuration(version);
          const displayDate = version.published_at || version.created_at;

          const handleClick = () => {
            if (onVersionClick && !isCurrentVersion) {
              onVersionClick(version.id);
            }
          };

          const canUnlink =
            (version._isManuallyLinked && onUnlinkManual && currentListingId) ||
            (version._isAutoLinked && onUnlinkAuto && currentListingId);

          return (
            <Timeline.Item
              key={version.id}
              time={`listed ${timeService.format(displayDate, false)}`}
              type={isCurrentVersion ? 'ongoing' : 'default'}
              className={isCurrentVersion ? 'versionTimeline__current' : ''}
            >
              <div className="versionTimeline__row">
                <div
                  className={`versionTimeline__item${!isCurrentVersion && onVersionClick ? ' versionTimeline__item--clickable' : ''}`}
                  onClick={handleClick}
                  role={!isCurrentVersion && onVersionClick ? 'button' : undefined}
                  tabIndex={!isCurrentVersion && onVersionClick ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleClick();
                    }
                  }}
                >
                  <div className="versionTimeline__header">
                    <Space>
                      <Text strong>{formatPrice(version.price)}</Text>
                      {priceChange != null && (
                        <Space size={4}>
                          {getPriceChangeIcon(version.price, previousVersion?.price)}
                          <Text type={parseFloat(priceChange) > 0 ? 'danger' : 'success'} size="small">
                            {priceChange > 0 ? '+' : ''}
                            {priceChange}%
                          </Text>
                        </Space>
                      )}
                      {isCurrentVersion && (
                        <Tag color="blue" size="small">
                          Current
                        </Tag>
                      )}
                      {version.is_active === 0 && (
                        <Tag color="red" size="small">
                          Inactive
                        </Tag>
                      )}
                      {!isCurrentVersion && onVersionClick && (
                        <Tag color="grey" size="small">
                          Click to view
                        </Tag>
                      )}
                      {version._isManuallyLinked && (
                        <Tag color="green" size="small" style={{ marginLeft: 4 }}>
                          <IconLink size="extra-small" style={{ marginRight: 2 }} />
                          Linked
                        </Tag>
                      )}
                      {version._isAutoLinked && (
                        <Tag color="cyan" size="small" style={{ marginLeft: 4 }}>
                          <IconLink size="extra-small" style={{ marginRight: 2 }} />
                          Auto
                        </Tag>
                      )}
                    </Space>
                  </div>
                  <div className="versionTimeline__details">
                    <Text type="tertiary" size="small">
                      {version.size ? `${version.size} m²` : ''}
                      {version.rooms ? ` • ${version.rooms} rooms` : ''}
                      {duration != null ? ` • ${duration} ${duration === 1 ? 'day' : 'days'} online` : ''}
                    </Text>
                  </div>
                  {version.provider && (
                    <Text type="tertiary" size="small">
                      found via {version.provider} on {timeService.format(version.created_at, false)}
                    </Text>
                  )}
                </div>
                {canUnlink && (
                  <div className="versionTimeline__actions">
                    {version._isManuallyLinked && onUnlinkManual && (
                      <Button
                        size="small"
                        type="danger"
                        theme="borderless"
                        icon={<IconUnlink />}
                        onClick={() => {
                          console.log('Manual unlink button clicked, version:', version.id);
                          onUnlinkManual(version.id);
                        }}
                      />
                    )}
                    {version._isAutoLinked && onUnlinkAuto && (
                      <Button
                        size="small"
                        type="danger"
                        theme="borderless"
                        icon={<IconUnlink />}
                        onClick={() => {
                          console.log('Auto unlink button clicked, version:', version.id);
                          onUnlinkAuto(version.id);
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            </Timeline.Item>
          );
        })}
      </Timeline>

      {/* Price History Chart from change_set */}
      {sortedVersions[0]?.change_set?.priceHistory && sortedVersions[0].change_set.priceHistory.length > 1 && (
        <div className="versionTimeline__summary">
          <Text type="secondary" size="small">
            Price tracked over {sortedVersions[0].change_set.priceHistory.length} data points
          </Text>
        </div>
      )}
    </div>
  );
};

export default VersionTimeline;
