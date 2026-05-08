CREATE TABLE route_entries (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id      UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    destination    TEXT        NOT NULL,  -- "10.0.2.0/24"
    next_hop       TEXT        NOT NULL DEFAULT '',  -- "" for connected/local routes
    protocol       TEXT        NOT NULL,  -- "connected" | "static" | "ospf" | "other"
    metric         INT,
    interface_name TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, destination, next_hop)
);

CREATE INDEX idx_route_entries_device   ON route_entries(device_id);
CREATE INDEX idx_route_entries_protocol ON route_entries(device_id, protocol);
