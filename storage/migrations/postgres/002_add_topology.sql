-- 002_add_topology.sql
-- Phase 2: BGP sessions, OSPF/IS-IS neighbors, LLDP/CDP neighbor tables,
-- and the computed topology link graph used by the topology map.

-- ============================================================
-- ENUMERATIONS
-- ============================================================

CREATE TYPE bgp_session_state AS ENUM (
    'idle', 'connect', 'active',
    'opensent', 'openconfirm', 'established',
    'unknown'
);

CREATE TYPE ospf_neighbor_state AS ENUM (
    'down', 'attempt', 'init', 'two_way',
    'exstart', 'exchange', 'loading', 'full',
    'unknown'
);

CREATE TYPE isis_adj_state AS ENUM (
    'down', 'initializing', 'up', 'failed', 'unknown'
);

CREATE TYPE topology_link_type AS ENUM (
    'lldp', 'cdp', 'bgp', 'ospf', 'isis', 'static', 'inferred'
);


-- ============================================================
-- BGP SESSIONS
-- One row per BGP peer per device per VRF.
-- Prefix counts and uptime updated by the gNMI/SNMP poller.
-- ============================================================
CREATE TABLE bgp_sessions (
    id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           UUID                NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    vrf                 TEXT                NOT NULL DEFAULT 'default',
    peer_ip             INET                NOT NULL,
    peer_asn            BIGINT,
    local_asn           BIGINT              NOT NULL,
    peer_description    TEXT,
    -- ["ipv4_unicast", "ipv6_unicast", "vpnv4_unicast", "l2vpn_evpn"]
    address_families    JSONB               NOT NULL DEFAULT '[]',
    session_state       bgp_session_state   NOT NULL DEFAULT 'unknown',
    prefixes_received   INT,
    prefixes_advertised INT,
    uptime_seconds      BIGINT,
    last_state_change   TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, vrf, peer_ip)
);

CREATE INDEX idx_bgp_sessions_device   ON bgp_sessions(device_id);
CREATE INDEX idx_bgp_sessions_state    ON bgp_sessions(session_state);
CREATE INDEX idx_bgp_sessions_peer_asn ON bgp_sessions(peer_asn);
-- Quick "all non-established sessions" query for alerting
CREATE INDEX idx_bgp_sessions_not_up   ON bgp_sessions(device_id)
    WHERE session_state != 'established';

CREATE TRIGGER trg_bgp_sessions_updated_at
    BEFORE UPDATE ON bgp_sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- OSPF NEIGHBORS
-- ============================================================
CREATE TABLE ospf_neighbors (
    id                  UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           UUID                    NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    vrf                 TEXT                    NOT NULL DEFAULT 'default',
    neighbor_router_id  INET                    NOT NULL,
    neighbor_ip         INET,
    interface_name      TEXT,
    area                TEXT,                   -- dotted-decimal "0.0.0.0", "0.0.0.1"
    state               ospf_neighbor_state     NOT NULL DEFAULT 'unknown',
    priority            INT,
    uptime_seconds      BIGINT,
    last_state_change   TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, vrf, neighbor_router_id, interface_name)
);

CREATE INDEX idx_ospf_neighbors_device ON ospf_neighbors(device_id);
CREATE INDEX idx_ospf_neighbors_state  ON ospf_neighbors(state);
CREATE INDEX idx_ospf_neighbors_not_full ON ospf_neighbors(device_id)
    WHERE state != 'full';

CREATE TRIGGER trg_ospf_neighbors_updated_at
    BEFORE UPDATE ON ospf_neighbors
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- IS-IS NEIGHBORS
-- ============================================================
CREATE TABLE isis_neighbors (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           UUID            NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    instance            TEXT            NOT NULL DEFAULT 'default',
    -- ISO system-id e.g. "0100.1001.0001"
    sys_id              TEXT            NOT NULL,
    hostname            TEXT,
    interface_name      TEXT,
    -- "level-1", "level-2", "level-1-2"
    circuit_type        TEXT,
    adjacency_state     isis_adj_state  NOT NULL DEFAULT 'unknown',
    ipv4_address        INET,
    ipv6_address        INET,
    uptime_seconds      BIGINT,
    last_state_change   TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, instance, sys_id, interface_name)
);

CREATE INDEX idx_isis_neighbors_device  ON isis_neighbors(device_id);
CREATE INDEX idx_isis_neighbors_state   ON isis_neighbors(adjacency_state);

CREATE TRIGGER trg_isis_neighbors_updated_at
    BEFORE UPDATE ON isis_neighbors
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- LLDP NEIGHBORS
-- IEEE 802.1AB — supported by all 7 target vendors.
-- ============================================================
CREATE TABLE lldp_neighbors (
    id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id                   UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    local_port_name             TEXT        NOT NULL,
    remote_chassis_id_subtype   TEXT,       -- "macAddress", "networkAddress", "local"
    remote_chassis_id           TEXT,
    remote_port_id_subtype      TEXT,       -- "interfaceName", "macAddress", "local"
    remote_port_id              TEXT,
    remote_port_desc            TEXT,
    remote_system_name          TEXT,
    remote_mgmt_ip              INET,
    -- ["bridge", "router", "wlanAccessPoint", "telephone", "docsisCableDevice"]
    remote_system_capabilities  JSONB       NOT NULL DEFAULT '[]',
    ttl                         INT,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, local_port_name, remote_chassis_id)
);

CREATE INDEX idx_lldp_neighbors_device      ON lldp_neighbors(device_id);
CREATE INDEX idx_lldp_neighbors_remote_sys  ON lldp_neighbors(remote_system_name);
CREATE INDEX idx_lldp_neighbors_remote_mgmt ON lldp_neighbors(remote_mgmt_ip);

CREATE TRIGGER trg_lldp_neighbors_updated_at
    BEFORE UPDATE ON lldp_neighbors
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- CDP NEIGHBORS
-- Cisco-proprietary; present on IOS, IOS-XE, IOS-XR, NX-OS.
-- ============================================================
CREATE TABLE cdp_neighbors (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    local_port_name     TEXT        NOT NULL,
    remote_device_id    TEXT,       -- CDP device ID (usually hostname)
    remote_port_id      TEXT,
    remote_mgmt_ip      INET,
    remote_platform     TEXT,       -- "cisco ASR9001"
    -- ["router", "trans-bridge", "source-route-bridge", "switch", "host", "igmp", "repeater"]
    remote_capabilities JSONB       NOT NULL DEFAULT '[]',
    native_vlan         INT,
    duplex              TEXT,       -- "full", "half"
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, local_port_name, remote_device_id)
);

CREATE INDEX idx_cdp_neighbors_device ON cdp_neighbors(device_id);

CREATE TRIGGER trg_cdp_neighbors_updated_at
    BEFORE UPDATE ON cdp_neighbors
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TOPOLOGY LINKS
-- Computed graph edges derived from LLDP/CDP/BGP/routing data.
-- The topology engine rebuilds these; never write here directly
-- from the API — only the topology-engine process owns this table.
--
-- Bidirectional deduplication: always store with the lower UUID
-- as source. The unique index enforces this constraint.
-- ============================================================
CREATE TABLE topology_links (
    id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID                NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    source_device_id    UUID                NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    source_interface_id UUID                REFERENCES interfaces(id) ON DELETE SET NULL,
    dest_device_id      UUID                NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    dest_interface_id   UUID                REFERENCES interfaces(id) ON DELETE SET NULL,
    link_type           topology_link_type  NOT NULL,
    -- protocol-specific metadata: {"area": "0.0.0.0", "metric": 100}
    metadata            JSONB               NOT NULL DEFAULT '{}',
    discovered_at       TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    -- Source device UUID must be the lexicographically lower of the two
    CHECK (source_device_id::text < dest_device_id::text)
);

CREATE INDEX idx_topology_links_tenant ON topology_links(tenant_id);
CREATE INDEX idx_topology_links_source ON topology_links(source_device_id);
CREATE INDEX idx_topology_links_dest   ON topology_links(dest_device_id);
CREATE INDEX idx_topology_links_type   ON topology_links(link_type);

-- Deduplicate: one link per pair per interface-pair per protocol
CREATE UNIQUE INDEX idx_topology_links_unique ON topology_links (
    source_device_id,
    dest_device_id,
    link_type,
    COALESCE(source_interface_id, '00000000-0000-0000-0000-000000000000'::UUID),
    COALESCE(dest_interface_id,   '00000000-0000-0000-0000-000000000000'::UUID)
);

CREATE TRIGGER trg_topology_links_updated_at
    BEFORE UPDATE ON topology_links
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
