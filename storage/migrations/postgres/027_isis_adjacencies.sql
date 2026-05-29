-- 027_isis_adjacencies.sql
-- IS-IS area and route tables. isis_neighbors already exists from 002_add_topology.sql.

-- ============================================================
-- IS-IS AREAS
-- One row per area address configured on the device.
-- Sourced from isisSysAreaAddrTable (RFC 4444).
-- ============================================================
CREATE TABLE isis_areas (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    instance    TEXT        NOT NULL DEFAULT 'default',
    area_addr   TEXT        NOT NULL,   -- ISO area address e.g. "49.0001"
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, instance, area_addr)
);

CREATE INDEX idx_isis_areas_device ON isis_areas(device_id);

CREATE TRIGGER trg_isis_areas_updated_at
    BEFORE UPDATE ON isis_areas
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- IS-IS ROUTES
-- IS-IS learned routes from isisIPReachabilityTable (RFC 4444).
-- One row per destination prefix per level per device.
-- ============================================================
CREATE TABLE isis_routes (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    instance        TEXT        NOT NULL DEFAULT 'default',
    destination     TEXT        NOT NULL,   -- CIDR e.g. "10.0.0.0/24"
    level           TEXT        NOT NULL DEFAULT 'level-2',  -- level-1 | level-2
    metric          INT,
    next_hop        TEXT,
    interface_name  TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, instance, destination, level)
);

CREATE INDEX idx_isis_routes_device ON isis_routes(device_id);

CREATE TRIGGER trg_isis_routes_updated_at
    BEFORE UPDATE ON isis_routes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
