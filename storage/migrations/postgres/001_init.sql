-- 001_init.sql
-- Phase 1 foundation: tenants, users, auth, sites, collectors, credentials,
-- devices, interfaces, health, alerting, audit.
-- All future migrations build on top of this schema.

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), crypt()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive text (emails, hostnames)

-- ============================================================
-- ENUMERATIONS
-- ============================================================

CREATE TYPE vendor_type AS ENUM (
    'cisco_ios',
    'cisco_iosxe',
    'cisco_iosxr',
    'cisco_nxos',
    'juniper',
    'arista',
    'aruba_cx',
    'fortios',
    'unknown'
);

CREATE TYPE device_type AS ENUM (
    'router',
    'switch',
    'firewall',
    'load_balancer',
    'wireless_controller',
    'unknown'
);

CREATE TYPE device_status AS ENUM (
    'up',
    'down',
    'unreachable',
    'maintenance',
    'unknown'
);

CREATE TYPE collection_method AS ENUM (
    'snmp',
    'gnmi',
    'both',
    'api'
);

CREATE TYPE snmp_version AS ENUM ('v1', 'v2c', 'v3');

CREATE TYPE credential_type AS ENUM (
    'snmp_v2c',
    'snmp_v3',
    'gnmi_tls',
    'ssh',
    'api_token',
    'netconf'
);

-- Mirrors SNMP ifOperStatus / ifAdminStatus values exactly
CREATE TYPE if_status AS ENUM (
    'up',
    'down',
    'testing',
    'unknown',
    'dormant',
    'not_present',
    'lower_layer_down'
);

CREATE TYPE alert_severity AS ENUM ('critical', 'major', 'minor', 'warning', 'info');

CREATE TYPE alert_status AS ENUM (
    'open',
    'acknowledged',
    'resolved',
    'suppressed',
    'expired'
);

CREATE TYPE notification_type AS ENUM (
    'email',
    'slack',
    'webhook',
    'pagerduty',
    'teams'
);

CREATE TYPE user_role AS ENUM ('superadmin', 'admin', 'operator', 'readonly');

CREATE TYPE audit_action AS ENUM (
    'create',
    'update',
    'delete',
    'login',
    'logout',
    'login_failed',
    'ack_alert',
    'resolve_alert',
    'config_push',
    'config_backup',
    'discovery_run'
);


-- ============================================================
-- SHARED TRIGGER: set updated_at on every UPDATE
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- TENANTS
-- Multi-tenancy scaffold present from day one so data is always
-- scoped correctly. Phase 1 runs as a single default tenant.
-- ============================================================
CREATE TABLE tenants (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    slug        CITEXT      NOT NULL UNIQUE,
    is_active   BOOLEAN     NOT NULL DEFAULT true,
    -- Arbitrary per-tenant settings (UI theme, default timezone, etc.)
    settings    JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Single-instance deployments use this tenant. Phase 3 adds more.
INSERT INTO tenants (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default', 'default');


-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    username        CITEXT      NOT NULL,
    email           CITEXT      NOT NULL,
    -- bcrypt hash; Keycloak replaces this in Phase 3
    password_hash   TEXT        NOT NULL,
    full_name       TEXT,
    role            user_role   NOT NULL DEFAULT 'readonly',
    is_active       BOOLEAN     NOT NULL DEFAULT true,
    last_login      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, username),
    UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email  ON users(email);

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- API TOKENS
-- Used for collector and dashboard auth before Keycloak (Phase 3).
-- ============================================================
CREATE TABLE api_tokens (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    token_hash  TEXT        NOT NULL UNIQUE,    -- SHA-256 hex of the raw token
    -- scopes: ["read:devices", "write:alerts", "collector"] etc.
    scopes      JSONB       NOT NULL DEFAULT '[]',
    last_used   TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ,                    -- NULL = never
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_tokens_tenant ON api_tokens(tenant_id);
CREATE INDEX idx_api_tokens_user   ON api_tokens(user_id);


-- ============================================================
-- SITES
-- Physical or logical groupings of devices (DC, branch, campus).
-- Remote collectors are anchored to a site.
-- ============================================================
CREATE TABLE sites (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name        TEXT        NOT NULL,
    description TEXT,
    location    TEXT,                   -- "London DC1", "New York HQ"
    latitude    NUMERIC(9,6),
    longitude   NUMERIC(9,6),
    tags        JSONB       NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_sites_tenant ON sites(tenant_id);

CREATE TRIGGER trg_sites_updated_at
    BEFORE UPDATE ON sites
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- REMOTE COLLECTORS
-- Separate binary deployed at branch sites. Registers back to
-- the central API using a one-time token.
-- ============================================================
CREATE TABLE remote_collectors (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    site_id     UUID        REFERENCES sites(id) ON DELETE SET NULL,
    name        TEXT        NOT NULL,
    -- bcrypt of the registration token issued at install time
    token_hash  TEXT        NOT NULL UNIQUE,
    ip_address  INET,
    version     TEXT,
    last_seen   TIMESTAMPTZ,
    is_active   BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_remote_collectors_tenant ON remote_collectors(tenant_id);
CREATE INDEX idx_remote_collectors_site   ON remote_collectors(site_id);

CREATE TRIGGER trg_remote_collectors_updated_at
    BEFORE UPDATE ON remote_collectors
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- CREDENTIALS
-- Stored encrypted by the application layer (AES-256-GCM).
-- One credential set can be shared across many devices.
--
-- data field schema per type:
--   snmp_v2c : { "community": "public" }
--   snmp_v3  : { "username": "...", "auth_protocol": "SHA|MD5",
--                "auth_key": "...", "priv_protocol": "AES|DES",
--                "priv_key": "..." }
--   gnmi_tls : { "ca_cert": "...", "client_cert": "...",
--                "client_key": "...", "skip_verify": false }
--   ssh      : { "username": "...", "password": "...",
--                "private_key": "..." }
--   netconf  : { "username": "...", "password": "...",
--                "port": 830 }
-- ============================================================
CREATE TABLE credentials (
    id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID            NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name        TEXT            NOT NULL,
    type        credential_type NOT NULL,
    data        JSONB           NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_credentials_tenant ON credentials(tenant_id);
CREATE INDEX idx_credentials_type   ON credentials(tenant_id, type);

CREATE TRIGGER trg_credentials_updated_at
    BEFORE UPDATE ON credentials
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- DEVICES
-- Central inventory for all monitored network devices.
-- ============================================================
CREATE TABLE devices (
    id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID                NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    site_id             UUID                REFERENCES sites(id) ON DELETE SET NULL,
    -- NULL collector_id = collected by the central server
    collector_id        UUID                REFERENCES remote_collectors(id) ON DELETE SET NULL,
    hostname            TEXT                NOT NULL,
    fqdn                TEXT,
    mgmt_ip             INET                NOT NULL,
    vendor              vendor_type         NOT NULL DEFAULT 'unknown',
    device_type         device_type         NOT NULL DEFAULT 'unknown',
    platform            TEXT,               -- "ASR9001", "QFX5100-48S", "DCS-7280CR3"
    os_version          TEXT,
    serial_number       TEXT,
    sys_description     TEXT,               -- SNMP sysDescr raw value
    sys_object_id       TEXT,               -- SNMP sysObjectID (.1.3.6.1.4.1.9.1....)
    collection_method   collection_method   NOT NULL DEFAULT 'snmp',
    snmp_version        snmp_version        NOT NULL DEFAULT 'v2c',
    snmp_port           INT                 NOT NULL DEFAULT 161,
    gnmi_port           INT                 NOT NULL DEFAULT 57400,
    gnmi_tls            BOOLEAN             NOT NULL DEFAULT true,
    -- How often to poll this device (seconds). Overrides global default.
    polling_interval_s  INT                 NOT NULL DEFAULT 300,
    status              device_status       NOT NULL DEFAULT 'unknown',
    last_seen           TIMESTAMPTZ,
    last_polled         TIMESTAMPTZ,
    is_active           BOOLEAN             NOT NULL DEFAULT true,
    tags                JSONB               NOT NULL DEFAULT '[]',
    notes               TEXT,
    created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, mgmt_ip)
);

CREATE INDEX idx_devices_tenant    ON devices(tenant_id);
CREATE INDEX idx_devices_site      ON devices(site_id);
CREATE INDEX idx_devices_vendor    ON devices(vendor);
CREATE INDEX idx_devices_status    ON devices(status);
CREATE INDEX idx_devices_mgmt_ip   ON devices(mgmt_ip);
CREATE INDEX idx_devices_active    ON devices(tenant_id, is_active);
CREATE INDEX idx_devices_tags      ON devices USING GIN(tags);

CREATE TRIGGER trg_devices_updated_at
    BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Junction: ordered credential sets to try per device.
-- The collector tries priority 0 first, then 1, etc.
CREATE TABLE device_credentials (
    device_id       UUID    NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    credential_id   UUID    NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    priority        INT     NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, credential_id)
);

CREATE INDEX idx_device_credentials_device ON device_credentials(device_id, priority);


-- ============================================================
-- INTERFACES
-- One row per interface per device. Populated by SNMP ifTable/ifXTable.
-- ============================================================
CREATE TABLE interfaces (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    if_index        INT         NOT NULL,           -- SNMP ifIndex
    name            TEXT        NOT NULL,            -- ifName  e.g. "GigabitEthernet0/0/0"
    description     TEXT,                            -- ifAlias (operator description)
    -- IANA ifType string e.g. "ethernetCsmacd", "softwareLoopback"
    if_type         TEXT,
    speed_bps       BIGINT,                          -- ifHighSpeed * 1,000,000
    mtu             INT,
    mac_address     MACADDR,
    admin_status    if_status   NOT NULL DEFAULT 'unknown',
    oper_status     if_status   NOT NULL DEFAULT 'unknown',
    last_change     TIMESTAMPTZ,                     -- converted from SNMP timeticks
    -- [{address: "10.0.0.1", prefix_len: 24, version: 4}, ...]
    ip_addresses    JSONB       NOT NULL DEFAULT '[]',
    vrf             TEXT,                            -- VRF name if applicable
    -- Operator-set: marks uplinks for topology weight calculations
    is_uplink       BOOLEAN,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, if_index)
);

CREATE INDEX idx_interfaces_device      ON interfaces(device_id);
CREATE INDEX idx_interfaces_name        ON interfaces(device_id, name);
CREATE INDEX idx_interfaces_oper_status ON interfaces(oper_status);
CREATE INDEX idx_interfaces_ip          ON interfaces USING GIN(ip_addresses);

CREATE TRIGGER trg_interfaces_updated_at
    BEFORE UPDATE ON interfaces
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Interface status change log — drives flap detection.
-- The alerting engine reads this to fire "flap" alerts within 30 s.
CREATE TABLE interface_status_log (
    id              BIGSERIAL   PRIMARY KEY,
    interface_id    UUID        NOT NULL REFERENCES interfaces(id) ON DELETE CASCADE,
    device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    prev_status     if_status,
    new_status      if_status   NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_iface_status_log_iface  ON interface_status_log(interface_id, recorded_at DESC);
CREATE INDEX idx_iface_status_log_device ON interface_status_log(device_id, recorded_at DESC);
-- Fast flap query: recent state changes in a window
CREATE INDEX idx_iface_status_log_recent ON interface_status_log(recorded_at DESC);


-- ============================================================
-- DEVICE HEALTH (latest snapshot)
-- The authoritative history lives in VictoriaMetrics. This row
-- holds the most recent poll so the dashboard never hits VM
-- for simple status cards.
-- ============================================================
CREATE TABLE device_health_latest (
    device_id       UUID        PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    collected_at    TIMESTAMPTZ NOT NULL,
    cpu_util_pct    NUMERIC(5,2),          -- 0.00 – 100.00
    mem_used_bytes  BIGINT,
    mem_total_bytes BIGINT,
    -- [{"sensor": "Inlet", "celsius": 28.5}, {"sensor": "CPU", "celsius": 61.0}]
    temperatures    JSONB       NOT NULL DEFAULT '[]',
    uptime_seconds  BIGINT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_device_health_collected ON device_health_latest(collected_at DESC);


-- ============================================================
-- NOTIFICATION CHANNELS
-- Destinations for alert messages.
--
-- config field schema per type (app encrypts sensitive values):
--   email    : { "smtp_host": "...", "smtp_port": 587, "tls": true,
--                "from": "...", "to": ["ops@corp.com"] }
--   slack    : { "webhook_url": "https://hooks.slack.com/..." }
--   webhook  : { "url": "...", "method": "POST", "headers": {}, "verify_tls": true }
--   pagerduty: { "integration_key": "..." }
--   teams    : { "webhook_url": "..." }
-- ============================================================
CREATE TABLE notification_channels (
    id          UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID                NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name        TEXT                NOT NULL,
    type        notification_type   NOT NULL,
    config      JSONB               NOT NULL DEFAULT '{}',
    is_enabled  BOOLEAN             NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_notification_channels_tenant ON notification_channels(tenant_id);

CREATE TRIGGER trg_notification_channels_updated_at
    BEFORE UPDATE ON notification_channels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- MAINTENANCE WINDOWS
-- Suppress alerts for matching devices during scheduled windows.
-- alert_rules.maintenance_window_ids references rows here.
-- ============================================================
CREATE TABLE maintenance_windows (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name                TEXT        NOT NULL,
    description         TEXT,
    -- Same selector format as alert_rules: {"tags": [...], "site_id": "..."}
    -- NULL = all devices in tenant
    device_selector     JSONB,
    starts_at           TIMESTAMPTZ NOT NULL,
    ends_at             TIMESTAMPTZ NOT NULL,
    is_recurring        BOOLEAN     NOT NULL DEFAULT false,
    -- Standard cron expression if recurring: "0 2 * * 6" = Saturdays 02:00
    recurrence_cron     TEXT,
    created_by          UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (ends_at > starts_at)
);

CREATE INDEX idx_maintenance_windows_tenant ON maintenance_windows(tenant_id);
CREATE INDEX idx_maintenance_windows_time   ON maintenance_windows(starts_at, ends_at);

CREATE TRIGGER trg_maintenance_windows_updated_at
    BEFORE UPDATE ON maintenance_windows
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ALERT RULES
-- Threshold and state-change rules evaluated by the alerting engine.
--
-- device_selector examples:
--   null                           → all devices in tenant
--   {"tags": ["core", "edge"]}     → devices with any of these tags
--   {"vendor": "cisco_iosxr"}      → vendor filter
--   {"site_id": "<uuid>"}          → site filter
--   {"device_ids": ["<uuid>", ...]}→ explicit list
--
-- metric values (non-exhaustive):
--   cpu_util_pct, mem_util_pct, device_reachability,
--   interface_oper_status, interface_error_rate_pct,
--   interface_util_pct_in, interface_util_pct_out,
--   bgp_session_state, ospf_neighbor_state, isis_adj_state
--
-- condition values: gt, lt, gte, lte, eq, ne, flap
-- ============================================================
CREATE TABLE alert_rules (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID            NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name                TEXT            NOT NULL,
    description         TEXT,
    is_enabled          BOOLEAN         NOT NULL DEFAULT true,
    device_selector     JSONB,
    metric              TEXT            NOT NULL,
    condition           TEXT            NOT NULL,
    threshold           NUMERIC,
    -- Condition must hold for this many seconds before firing (0 = immediate)
    duration_seconds    INT             NOT NULL DEFAULT 0,
    -- Re-alert every N seconds while still open (0 = never re-alert)
    renotify_seconds    INT             NOT NULL DEFAULT 3600,
    severity            alert_severity  NOT NULL DEFAULT 'warning',
    -- Array of notification_channel UUIDs
    channel_ids         JSONB           NOT NULL DEFAULT '[]',
    -- Array of maintenance_window UUIDs that suppress this rule
    maintenance_window_ids JSONB        NOT NULL DEFAULT '[]',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_alert_rules_tenant  ON alert_rules(tenant_id);
CREATE INDEX idx_alert_rules_enabled ON alert_rules(tenant_id, is_enabled);
CREATE INDEX idx_alert_rules_metric  ON alert_rules(metric);

CREATE TRIGGER trg_alert_rules_updated_at
    BEFORE UPDATE ON alert_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ALERTS
-- One row per alert instance. Open alerts are the live NOC view.
-- ============================================================
CREATE TABLE alerts (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID            NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    rule_id             UUID            REFERENCES alert_rules(id) ON DELETE SET NULL,
    device_id           UUID            REFERENCES devices(id) ON DELETE CASCADE,
    interface_id        UUID            REFERENCES interfaces(id) ON DELETE SET NULL,
    severity            alert_severity  NOT NULL,
    status              alert_status    NOT NULL DEFAULT 'open',
    title               TEXT            NOT NULL,
    message             TEXT,
    -- Metric values and environmental context at trigger time
    context             JSONB           NOT NULL DEFAULT '{}',
    triggered_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    acknowledged_at     TIMESTAMPTZ,
    acknowledged_by     UUID            REFERENCES users(id) ON DELETE SET NULL,
    resolved_at         TIMESTAMPTZ,
    resolved_by         UUID            REFERENCES users(id) ON DELETE SET NULL,
    -- Phase 3: filled by correlation engine
    correlation_id      UUID,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_tenant       ON alerts(tenant_id);
CREATE INDEX idx_alerts_device       ON alerts(device_id);
CREATE INDEX idx_alerts_status       ON alerts(status);
CREATE INDEX idx_alerts_severity     ON alerts(severity);
CREATE INDEX idx_alerts_triggered_at ON alerts(triggered_at DESC);
-- Hot path for the NOC "open alerts" view
CREATE INDEX idx_alerts_open         ON alerts(tenant_id, severity, triggered_at DESC)
    WHERE status = 'open';

CREATE TRIGGER trg_alerts_updated_at
    BEFORE UPDATE ON alerts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- AUDIT LOG
-- Immutable append-only log of every user and system action.
-- Use BIGSERIAL (not UUID) for fast sequential inserts.
-- Partition by month in production when it grows large.
-- ============================================================
CREATE TABLE audit_log (
    id              BIGSERIAL       PRIMARY KEY,
    tenant_id       UUID            REFERENCES tenants(id) ON DELETE SET NULL,
    user_id         UUID            REFERENCES users(id) ON DELETE SET NULL,
    action          audit_action    NOT NULL,
    resource_type   TEXT,           -- "device", "interface", "alert", "user", ...
    resource_id     UUID,
    old_value       JSONB,
    new_value       JSONB,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_tenant     ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_log_user       ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_log_resource   ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC);
