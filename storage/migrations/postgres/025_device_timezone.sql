-- 025_collector_timezone.sql
-- Add per-collector IANA timezone so syslog listeners can correctly interpret
-- RFC 3164 timestamps (which carry no timezone info) from devices at that site.
ALTER TABLE remote_collectors
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
