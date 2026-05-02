-- Add fingerprint + last_notified_at to alerts for deduplication and re-alerting.
ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS fingerprint       TEXT,
    ADD COLUMN IF NOT EXISTS last_notified_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_alerts_fingerprint_open
    ON alerts(fingerprint)
    WHERE status = 'open';
