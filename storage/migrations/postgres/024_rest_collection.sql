-- Per-device REST API collection flag.
-- When true, Anthrimon polls BGP/OSPF state via the device's REST API
-- instead of (or in addition to) SNMP. Currently used for ArubaOS-CX which
-- does not implement standard OSPF-MIB / BGP4-MIB via SNMP.

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS rest_collection_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_devices_rest_enabled ON devices(id)
    WHERE rest_collection_enabled = TRUE;

-- Auto-enable for all existing ArubaOS-CX devices.
-- New ArubaOS-CX devices are enabled automatically by the REST state collector
-- on discovery. If REST fails (401/403/unreachable) it is disabled and must
-- be manually re-enabled from the device settings page.
UPDATE devices SET rest_collection_enabled = TRUE WHERE vendor::text = 'aruba_cx';
