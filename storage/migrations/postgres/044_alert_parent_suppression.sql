-- Tier-1 parent-child alert suppression.
-- When a parent alert (device_down, interface_down on critical uplink) fires,
-- child alerts caused by the same root event are stored with status='suppressed'
-- and a pointer back to the parent for traceability and unsuppression on resolve.

ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS suppressed_by_alert_id UUID
        REFERENCES alerts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_alerts_suppressed_by
    ON alerts(suppressed_by_alert_id)
    WHERE suppressed_by_alert_id IS NOT NULL;
