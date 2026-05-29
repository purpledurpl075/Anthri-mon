-- 028_device_api_methods.sql
-- Per-device API method tracking: probe state, enablement, and auto-configure history.
-- Replaces the single rest_collection_enabled boolean with a proper per-method table.

CREATE TABLE device_api_methods (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    method              TEXT        NOT NULL,  -- 'snmp' | 'arista_eapi' | 'aruba_cx_rest' | 'gnmi'
    enabled             BOOLEAN     NOT NULL DEFAULT false,
    -- Last connectivity probe result
    reachable           BOOLEAN,               -- NULL = never probed
    last_probe_at       TIMESTAMPTZ,
    probe_error         TEXT,
    -- Auto-configure state
    configure_status    TEXT,                  -- NULL | 'running' | 'success' | 'failed'
    configure_output    TEXT,
    configure_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, method)
);

CREATE INDEX idx_device_api_methods_device  ON device_api_methods(device_id);
CREATE INDEX idx_device_api_methods_method  ON device_api_methods(method);
CREATE INDEX idx_device_api_methods_enabled ON device_api_methods(device_id) WHERE enabled = true;

CREATE TRIGGER trg_device_api_methods_updated_at
    BEFORE UPDATE ON device_api_methods
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Seed initial rows from existing state ─────────────────────────────────────

-- SNMP: enabled for any device that has snmp_v2c or snmp_v3 credentials
INSERT INTO device_api_methods (device_id, method, enabled)
SELECT DISTINCT dc.device_id, 'snmp', true
FROM device_credentials dc
JOIN credentials c ON c.id = dc.credential_id
WHERE c.type IN ('snmp_v2c', 'snmp_v3')
ON CONFLICT (device_id, method) DO NOTHING;

-- Arista eAPI: row for all Arista devices, disabled by default
INSERT INTO device_api_methods (device_id, method, enabled)
SELECT id, 'arista_eapi', false
FROM devices WHERE vendor::text = 'arista'
ON CONFLICT (device_id, method) DO NOTHING;

-- ArubaOS-CX REST: carry forward existing rest_collection_enabled flag
INSERT INTO device_api_methods (device_id, method, enabled)
SELECT id, 'aruba_cx_rest', rest_collection_enabled
FROM devices WHERE vendor::text = 'aruba_cx'
ON CONFLICT (device_id, method) DO NOTHING;
