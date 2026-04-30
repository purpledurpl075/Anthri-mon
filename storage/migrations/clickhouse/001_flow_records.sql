-- 001_flow_records.sql
-- ClickHouse schema for Phase 2 flow analysis.
-- Receives decoded sFlow v5, NetFlow v5/v9, and IPFIX records.
-- All timestamps UTC. TTL keeps 90 days of raw records.
-- Materialized views pre-aggregate common queries so the dashboard
-- does not scan billions of rows for every top-talkers render.

-- ============================================================
-- RAW FLOW RECORDS
-- One row per flow record as decoded by the flow collector.
-- Partition key: toYYYYMM(flow_start) — monthly parts.
-- Sort key is chosen for the most common query patterns:
--   filter by collector_device_id (which router sent it)
--   then by time range
--   then src/dst IP for specific host queries
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_records (
    -- Collector metadata
    collector_device_id UUID,                   -- devices.id of the exporting router
    collector_ip        IPv4,                   -- IP of the flow collector that received it
    -- "sflow_v5", "netflow_v5", "netflow_v9", "ipfix"
    flow_type           LowCardinality(String),

    -- Flow timing (epoch milliseconds for sub-second precision)
    flow_start          DateTime64(3, 'UTC'),
    flow_end            DateTime64(3, 'UTC'),

    -- Layer 3
    src_ip              IPv4,
    dst_ip              IPv4,
    src_ip6             IPv6,
    dst_ip6             IPv6,
    next_hop            IPv4,

    -- Layer 4
    src_port            UInt16,
    dst_port            UInt16,
    -- IANA protocol number: 6=TCP, 17=UDP, 1=ICMP, 89=OSPF, etc.
    ip_protocol         UInt8,
    tcp_flags           UInt8,

    -- Volume
    bytes               UInt64,
    packets             UInt64,

    -- Interface indexes on the exporting device
    input_if_index      UInt32,
    output_if_index     UInt32,

    -- BGP / routing
    src_asn             UInt32,
    dst_asn             UInt32,
    src_prefix_len      UInt8,
    dst_prefix_len      UInt8,

    -- QoS
    tos                 UInt8,                  -- raw TOS byte
    dscp                UInt8,                  -- upper 6 bits of TOS

    -- Sampling: actual bytes = bytes * sampling_rate
    sampling_rate       UInt32  DEFAULT 1,

    -- Ingest timestamp (when the collector wrote this row)
    received_at         DateTime DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(flow_start)
ORDER BY (collector_device_id, flow_start, src_ip, dst_ip)
TTL toDateTime(flow_start) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;


-- ============================================================
-- 1-MINUTE AGGREGATES
-- Pre-aggregated by source device + src/dst IP pair + protocol.
-- Keeps 1 year. Covers the bandwidth time-series dashboard widget.
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_agg_1min (
    minute              DateTime,
    collector_device_id UUID,
    src_ip              IPv4,
    dst_ip              IPv4,
    ip_protocol         UInt8,
    src_asn             UInt32,
    dst_asn             UInt32,
    bytes_total         UInt64,
    packets_total       UInt64,
    flow_count          UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(minute)
ORDER BY (collector_device_id, minute, src_ip, dst_ip, ip_protocol)
TTL minute + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_flow_agg_1min
TO flow_agg_1min AS
SELECT
    toStartOfMinute(flow_start)     AS minute,
    collector_device_id,
    src_ip,
    dst_ip,
    ip_protocol,
    src_asn,
    dst_asn,
    sum(bytes)                      AS bytes_total,
    sum(packets)                    AS packets_total,
    count()                         AS flow_count
FROM flow_records
GROUP BY minute, collector_device_id, src_ip, dst_ip, ip_protocol, src_asn, dst_asn;


-- ============================================================
-- 5-MINUTE ASN AGGREGATES
-- Drives the "top ASNs" view. Keeps 2 years.
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_agg_asn_5min (
    bucket              DateTime,
    collector_device_id UUID,
    src_asn             UInt32,
    dst_asn             UInt32,
    bytes_total         UInt64,
    packets_total       UInt64,
    flow_count          UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (collector_device_id, bucket, src_asn, dst_asn)
TTL bucket + INTERVAL 2 YEAR
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_flow_agg_asn_5min
TO flow_agg_asn_5min AS
SELECT
    toStartOfFiveMinutes(flow_start) AS bucket,
    collector_device_id,
    src_asn,
    dst_asn,
    sum(bytes)                       AS bytes_total,
    sum(packets)                     AS packets_total,
    count()                          AS flow_count
FROM flow_records
GROUP BY bucket, collector_device_id, src_asn, dst_asn;


-- ============================================================
-- 5-MINUTE PROTOCOL AGGREGATES
-- Drives the "protocol breakdown" pie/area chart. Keeps 2 years.
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_agg_proto_5min (
    bucket              DateTime,
    collector_device_id UUID,
    ip_protocol         UInt8,
    dscp                UInt8,
    bytes_total         UInt64,
    packets_total       UInt64,
    flow_count          UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (collector_device_id, bucket, ip_protocol, dscp)
TTL bucket + INTERVAL 2 YEAR
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_flow_agg_proto_5min
TO flow_agg_proto_5min AS
SELECT
    toStartOfFiveMinutes(flow_start) AS bucket,
    collector_device_id,
    ip_protocol,
    dscp,
    sum(bytes)                       AS bytes_total,
    sum(packets)                     AS packets_total,
    count()                          AS flow_count
FROM flow_records
GROUP BY bucket, collector_device_id, ip_protocol, dscp;


-- ============================================================
-- HOURLY INTERFACE UTILISATION
-- Drives the per-interface bandwidth time-series (Phase 2).
-- Keeps 3 years for capacity planning.
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_agg_iface_1hr (
    hour                DateTime,
    collector_device_id UUID,
    input_if_index      UInt32,
    output_if_index     UInt32,
    bytes_total         UInt64,
    packets_total       UInt64,
    flow_count          UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (collector_device_id, hour, input_if_index, output_if_index)
TTL hour + INTERVAL 3 YEAR
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_flow_agg_iface_1hr
TO flow_agg_iface_1hr AS
SELECT
    toStartOfHour(flow_start)       AS hour,
    collector_device_id,
    input_if_index,
    output_if_index,
    sum(bytes)                      AS bytes_total,
    sum(packets)                    AS packets_total,
    count()                         AS flow_count
FROM flow_records
GROUP BY hour, collector_device_id, input_if_index, output_if_index;
