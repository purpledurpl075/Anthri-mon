-- 002_add_exporter_ip.sql
-- Add exporter_ip: the IP of the router/switch sending the flows.
-- collector_ip already tracks which collector received them.
-- Needed for device lookup when collector_device_id isn't pre-resolved,
-- and for fast per-exporter queries without joining to PostgreSQL.

ALTER TABLE flow_records
    ADD COLUMN IF NOT EXISTS exporter_ip IPv4 DEFAULT toIPv4('0.0.0.0')
    AFTER collector_ip;
