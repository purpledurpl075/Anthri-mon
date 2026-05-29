-- 005_collector_logs.sql
-- Operational logs forwarded from each remote collector process.
-- Stores zerolog JSON output, parsed into columns.
-- TTL: 30 days (operational/debug logs, not audit data).

CREATE TABLE IF NOT EXISTS collector_logs (
    collector_id  UUID,
    ts            DateTime64(3, 'UTC'),
    level         LowCardinality(String),
    message       String,
    fields        String                   -- JSON blob of any extra zerolog fields
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (collector_id, ts)
TTL toDateTime(ts) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;
