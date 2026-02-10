/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Card,
  Col,
  Row,
  Image,
  Button,
  Space,
  Typography,
  Pagination,
  Toast,
  Divider,
  Input,
  Select,
  Popover,
  Empty,
} from '@douyinfe/semi-ui-19';
import {
  IconBriefcase,
  IconCart,
  IconClock,
  IconLink,
  IconMapPin,
  IconSearch,
  IconFilter,
  IconRefresh,
} from '@douyinfe/semi-icons';
import no_image from '../../../assets/no_image.jpg';
import * as timeService from '../../../services/time/timeService.js';
import { xhrPost } from '../../../services/xhr.js';
import { useActions, useSelector } from '../../../services/state/store.js';
import debounce from 'lodash/debounce';

import './DeletedListingsGrid.less';
import { IllustrationNoResult, IllustrationNoResultDark } from '@douyinfe/semi-illustrations';

const { Text } = Typography;

/**
 * Format address with district if available from change_set
 */
const formatAddress = (item) => {
  let district = null;
  if (item.change_set) {
    try {
      const cs = typeof item.change_set === 'string' ? JSON.parse(item.change_set) : item.change_set;
      district = cs.district || null;
    } catch (e) {
      // Ignore parse errors
    }
  }

  const address = item.address || '';

  if (district && !address.includes(district)) {
    return `${district}, ${address}`;
  }

  return address || 'No address provided';
};

const DeletedListingsGrid = () => {
  const deletedListingsData = useSelector((state) => state.deletedListingsData);
  const providers = useSelector((state) => state.provider);
  const jobs = useSelector((state) => state.jobsData.jobs);
  const actions = useActions();

  const [page, setPage] = useState(1);
  const pageSize = 40;

  const [sortField, setSortField] = useState('published_at');
  const [sortDir, setSortDir] = useState('desc');
  const [freeTextFilter, setFreeTextFilter] = useState(null);
  const [jobNameFilter, setJobNameFilter] = useState(null);
  const [providerFilter, setProviderFilter] = useState(null);
  const [showFilterBar, setShowFilterBar] = useState(false);

  const loadData = () => {
    actions.deletedListingsData.getDeletedListingsData({
      page,
      pageSize,
      sortfield: sortField,
      sortdir: sortDir,
      freeTextFilter,
      filter: { jobNameFilter, providerFilter },
    });
  };

  useEffect(() => {
    loadData();
  }, [page, sortField, sortDir, freeTextFilter, providerFilter, jobNameFilter]);

  const handleFilterChange = useMemo(() => debounce((value) => setFreeTextFilter(value), 500), []);

  useEffect(() => {
    return () => {
      handleFilterChange.cancel && handleFilterChange.cancel();
    };
  }, [handleFilterChange]);

  const handlePageChange = (_page) => {
    setPage(_page);
  };

  const handleRestore = async (item) => {
    try {
      await xhrPost('/api/listings/restore', { ids: [item.id] });
      Toast.success('Listing restored successfully');
      loadData();
    } catch (e) {
      console.error(e);
      Toast.error('Failed to restore listing');
    }
  };

  const cap = (val) => {
    return String(val).charAt(0).toUpperCase() + String(val).slice(1);
  };

  return (
    <div className="deletedListingsGrid">
      <div className="deletedListingsGrid__searchbar">
        <Input prefix={<IconSearch />} showClear placeholder="Search" onChange={handleFilterChange} />
        <Popover content="Filter / Sort Results" style={{ color: 'white', padding: '.5rem' }}>
          <div>
            <Button
              icon={<IconFilter />}
              onClick={() => {
                setShowFilterBar(!showFilterBar);
              }}
            />
          </div>
        </Popover>
      </div>
      {showFilterBar && (
        <div className="deletedListingsGrid__toolbar">
          <Space wrap style={{ marginBottom: '1rem' }}>
            <div className="deletedListingsGrid__toolbar__card">
              <div>
                <Text strong>Filter by:</Text>
              </div>
              <div style={{ display: 'flex', gap: '.3rem' }}>
                <Select
                  placeholder="Provider"
                  showClear
                  onChange={(val) => setProviderFilter(val)}
                  value={providerFilter}
                >
                  {providers?.map((p) => (
                    <Select.Option key={p.id} value={p.id}>
                      {p.name}
                    </Select.Option>
                  ))}
                </Select>

                <Select
                  placeholder="Job Name"
                  showClear
                  onChange={(val) => setJobNameFilter(val)}
                  value={jobNameFilter}
                >
                  {jobs?.map((j) => (
                    <Select.Option key={j.id} value={j.id}>
                      {j.name}
                    </Select.Option>
                  ))}
                </Select>
              </div>
            </div>
            <Divider layout="vertical" />

            <div className="deletedListingsGrid__toolbar__card">
              <div>
                <Text strong>Sort by:</Text>
              </div>
              <div style={{ display: 'flex', gap: '.3rem' }}>
                <Select
                  placeholder="Sort By"
                  style={{ width: 140 }}
                  value={sortField}
                  onChange={(val) => setSortField(val)}
                >
                  <Select.Option value="job_name">Job Name</Select.Option>
                  <Select.Option value="published_at">Published Date</Select.Option>
                  <Select.Option value="created_at">Found Date</Select.Option>
                  <Select.Option value="price">Price</Select.Option>
                  <Select.Option value="provider">Provider</Select.Option>
                </Select>

                <Select
                  placeholder="Direction"
                  style={{ width: 120 }}
                  value={sortDir}
                  onChange={(val) => setSortDir(val)}
                >
                  <Select.Option value="asc">Ascending</Select.Option>
                  <Select.Option value="desc">Descending</Select.Option>
                </Select>
              </div>
            </div>
          </Space>
        </div>
      )}

      {(deletedListingsData?.result || []).length === 0 && (
        <Empty
          image={<IllustrationNoResult />}
          darkModeImage={<IllustrationNoResultDark />}
          description="No deleted listings..."
        />
      )}
      <Row gutter={[16, 16]}>
        {(deletedListingsData?.result || []).map((item) => (
          <Col key={item.id} xs={24} sm={12} md={8} lg={6} xl={4} xxl={6}>
            <Card
              className="deletedListingsGrid__card"
              cover={
                <div style={{ position: 'relative' }}>
                  <div className="deletedListingsGrid__imageContainer">
                    <Image
                      src={item.image_url || no_image}
                      fallback={no_image}
                      width="100%"
                      height={180}
                      style={{ objectFit: 'cover' }}
                      preview={false}
                    />
                  </div>
                  <div className="deletedListingsGrid__deletedOverlay">Deleted</div>
                </div>
              }
              bodyStyle={{ padding: '12px' }}
            >
              <div className="deletedListingsGrid__content">
                <Text strong ellipsis={{ showTooltip: true }} className="deletedListingsGrid__title">
                  {cap(item.title)}
                </Text>
                <Space vertical align="start" spacing={2} style={{ width: '100%', marginTop: 8 }}>
                  <Text type="secondary" icon={<IconCart />} size="small">
                    {item.price} €
                  </Text>
                  <Text
                    type="secondary"
                    icon={<IconMapPin />}
                    size="small"
                    ellipsis={{ showTooltip: true }}
                    style={{ width: '100%' }}
                  >
                    {formatAddress(item)}
                  </Text>
                  <Text type="tertiary" size="small" icon={<IconClock />}>
                    {item.published_at
                      ? `Published: ${timeService.format(item.published_at, false)}`
                      : `Found: ${timeService.format(item.created_at, false)}`}
                  </Text>
                  <Text type="tertiary" size="small" icon={<IconBriefcase />}>
                    {item.provider.charAt(0).toUpperCase() + item.provider.slice(1)}
                  </Text>
                </Space>
                <Divider margin=".6rem" />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="deletedListingsGrid__linkButton">
                    <a href={item.link} target="_blank" rel="noopener noreferrer">
                      <IconLink />
                    </a>
                  </div>
                  <Button
                    title="Restore"
                    type="primary"
                    size="small"
                    onClick={() => handleRestore(item)}
                    icon={<IconRefresh />}
                  >
                    Restore
                  </Button>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
      {(deletedListingsData?.result || []).length > 0 && (
        <div className="deletedListingsGrid__pagination">
          <Pagination
            currentPage={page}
            pageSize={pageSize}
            total={deletedListingsData?.totalNumber || 0}
            onPageChange={handlePageChange}
            showSizeChanger={false}
          />
        </div>
      )}
    </div>
  );
};

export default DeletedListingsGrid;
