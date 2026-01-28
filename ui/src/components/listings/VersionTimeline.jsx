/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import { Timeline, Typography, Tag, Space } from '@douyinfe/semi-ui';
import { IconArrowUp, IconArrowDown, IconMinus } from '@douyinfe/semi-icons';
import * as timeService from '../../services/time/timeService.js';

import './VersionTimeline.less';

const { Text } = Typography;

const VersionTimeline = ({ versions, currentId }) => {
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

  // Sort versions by created_at descending (newest first)
  const sortedVersions = [...versions].sort((a, b) => b.created_at - a.created_at);

  return (
    <div className="versionTimeline">
      <Timeline>
        {sortedVersions.map((version, index) => {
          const isCurrentVersion = version.id === currentId;
          const previousVersion = sortedVersions[index + 1];
          const priceChange = previousVersion ? getPriceChangePercent(version.price, previousVersion.price) : null;
          const duration = computeDuration(version);
          const displayDate = version.published_at || version.created_at;

          return (
            <Timeline.Item
              key={version.id}
              time={`listed ${timeService.format(displayDate, false)}`}
              type={isCurrentVersion ? 'ongoing' : 'default'}
              className={isCurrentVersion ? 'versionTimeline__current' : ''}
            >
              <div className="versionTimeline__item">
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
