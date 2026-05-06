-- System-wide key/value settings store.
-- Not tenant-scoped — applies to the whole Anthrimon instance.
CREATE TABLE IF NOT EXISTS system_settings (
    key        TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
