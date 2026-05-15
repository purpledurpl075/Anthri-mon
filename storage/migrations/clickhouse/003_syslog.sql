-- 003_syslog.sql
-- Syslog message storage for Phase 7.
-- Receives RFC 3164 and RFC 5424 messages from the syslog collector.
-- Partitioned by month, ordered for efficient per-device time-range queries.
-- TTL: raw messages 90 days; hourly counts 1 year.

-- ============================================================
-- RAW SYSLOG MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS syslog_messages (
    device_id   UUID,                           -- devices.id of the sending host
    device_ip   IPv4,                           -- source IP of the sender
    facility    UInt8,                          -- 0–23 (kern, user, mail, …, local0–local7)
    severity    UInt8,                          -- 0=emerg 1=alert 2=crit 3=err 4=warn 5=notice 6=info 7=debug
    ts          DateTime64(3, 'UTC'),           -- message timestamp (from the message, not received_at)
    hostname    LowCardinality(String),         -- hostname field from the syslog header
    program     LowCardinality(String),         -- program / app-name (e.g. "sshd", "kernel")
    pid         String,                         -- process ID if present
    message     String,                         -- the log message text
    raw         String,                         -- full original message for debugging
    received_at DateTime DEFAULT now()          -- when the collector wrote this row
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (device_id, ts, severity)
TTL toDateTime(ts) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;


-- ============================================================
-- HOURLY SEVERITY COUNTS PER DEVICE
-- Drives the log-rate sparkline and severity heatmap.
-- ============================================================
CREATE TABLE IF NOT EXISTS syslog_agg_1hr (
    hour      DateTime,
    device_id UUID,
    severity  UInt8,
    count     UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (device_id, hour, severity)
TTL hour + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_syslog_agg_1hr
TO syslog_agg_1hr AS
SELECT
    toStartOfHour(ts) AS hour,
    device_id,
    severity,
    count()           AS count
FROM syslog_messages
GROUP BY hour, device_id, severity;
