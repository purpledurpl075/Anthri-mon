-- 009_alert_exclusions_and_custom_oid.sql
-- Per-device alert exclusions and custom OID alerting support.

-- alert_exclusions on devices:
-- {
--   "metrics": ["cpu_util_pct"],          -- silence these metrics entirely
--   "interface_ids": ["uuid1", "uuid2"]   -- silence interface_down for specific interfaces
-- }
ALTER TABLE devices
    ADD COLUMN alert_exclusions JSONB NOT NULL DEFAULT '{"metrics":[],"interface_ids":[]}';

-- custom_oid on alert_rules — stores the OID to poll for custom OID alert rules.
-- Only used when metric = 'custom_oid'.
ALTER TABLE alert_rules
    ADD COLUMN custom_oid TEXT;
