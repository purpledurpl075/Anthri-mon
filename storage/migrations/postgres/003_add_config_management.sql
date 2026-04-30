-- 003_add_config_management.sql
-- Phase 3: device config backup + diff tracking, compliance policy engine,
-- and per-metric baseline learning for anomaly detection.

-- ============================================================
-- CONFIG BACKUPS
-- Full running-config snapshots collected via SSH/Netconf/API.
-- Text stored directly in PG for simplicity; move to object
-- storage (S3-compatible) if average config size exceeds ~500 KB.
-- ============================================================
CREATE TABLE config_backups (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    collected_at        TIMESTAMPTZ NOT NULL,
    config_text         TEXT        NOT NULL,
    -- SHA-256 hex digest — used to skip unchanged configs
    config_hash         TEXT        NOT NULL,
    -- "netconf", "ssh_show_run", "rest_api", "gnmi"
    collection_method   TEXT        NOT NULL,
    is_latest           BOOLEAN     NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_config_backups_device      ON config_backups(device_id, collected_at DESC);
CREATE INDEX idx_config_backups_hash        ON config_backups(config_hash);
-- At most one "latest" row per device
CREATE UNIQUE INDEX idx_config_backups_one_latest
    ON config_backups(device_id) WHERE is_latest = true;


-- ============================================================
-- CONFIG DIFFS
-- Unified diff between two consecutive backups.
-- Generated automatically when a new backup hash differs from
-- the previous one.
-- ============================================================
CREATE TABLE config_diffs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    prev_backup_id  UUID        REFERENCES config_backups(id) ON DELETE SET NULL,
    curr_backup_id  UUID        NOT NULL REFERENCES config_backups(id) ON DELETE CASCADE,
    -- Standard unified diff format (diff -u)
    diff_text       TEXT        NOT NULL,
    lines_added     INT         NOT NULL DEFAULT 0,
    lines_removed   INT         NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_config_diffs_device     ON config_diffs(device_id, created_at DESC);
CREATE INDEX idx_config_diffs_curr       ON config_diffs(curr_backup_id);


-- ============================================================
-- COMPLIANCE POLICIES
-- Each policy holds N rules that are evaluated against the
-- latest config backup for matching devices.
--
-- Rule object schema:
--   { "type": "regex_present",  "pattern": "ntp server 10.0.0.1",
--     "description": "NTP server must be configured",
--     "severity": "major" }
--   { "type": "regex_absent",   "pattern": "no service password-encryption",
--     "description": "Password encryption must be enabled" }
--   { "type": "jinja_eval",     "template": "...",
--     "description": "Custom Jinja2 expression returning true/false" }
-- ============================================================
CREATE TABLE compliance_policies (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID            NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name            TEXT            NOT NULL,
    description     TEXT,
    is_enabled      BOOLEAN         NOT NULL DEFAULT true,
    -- Same selector format as alert_rules; NULL = all devices in tenant
    device_selector JSONB,
    rules           JSONB           NOT NULL DEFAULT '[]',
    severity        alert_severity  NOT NULL DEFAULT 'warning',
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_compliance_policies_tenant  ON compliance_policies(tenant_id);
CREATE INDEX idx_compliance_policies_enabled ON compliance_policies(tenant_id, is_enabled);

CREATE TRIGGER trg_compliance_policies_updated_at
    BEFORE UPDATE ON compliance_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- COMPLIANCE RESULTS
-- One row per device + policy check run.
-- Keep the last N runs per device/policy for trend analysis.
-- ============================================================
CREATE TABLE compliance_results (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    policy_id   UUID        NOT NULL REFERENCES compliance_policies(id) ON DELETE CASCADE,
    backup_id   UUID        REFERENCES config_backups(id) ON DELETE SET NULL,
    checked_at  TIMESTAMPTZ NOT NULL,
    -- "pass", "fail", "error"
    status      TEXT        NOT NULL,
    -- [{rule_index: 0, status: "fail", description: "...", matched_text: null}]
    findings    JSONB       NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_compliance_results_device     ON compliance_results(device_id, checked_at DESC);
CREATE INDEX idx_compliance_results_policy     ON compliance_results(policy_id, checked_at DESC);
CREATE INDEX idx_compliance_results_status     ON compliance_results(status);
-- Dashboard "currently failing" query
CREATE INDEX idx_compliance_results_failing    ON compliance_results(device_id, policy_id, checked_at DESC)
    WHERE status = 'fail';


-- ============================================================
-- METRIC BASELINES
-- Per-device (or per-interface) rolling mean + stddev profiles
-- learned from historical metric data, bucketed by hour-of-week
-- (0–167) or hour-of-day (0–23).
-- Used by the Phase 3 anomaly detection engine (Z-score threshold).
-- ============================================================
CREATE TABLE metric_baselines (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    -- NULL = device-level metric (cpu, mem); non-NULL = interface metric
    interface_id    UUID        REFERENCES interfaces(id) ON DELETE CASCADE,
    metric          TEXT        NOT NULL,
    -- "hour_of_week" (0–167) or "hour_of_day" (0–23)
    bucket_type     TEXT        NOT NULL DEFAULT 'hour_of_week',
    bucket_index    INT         NOT NULL,
    mean            NUMERIC     NOT NULL,
    stddev          NUMERIC     NOT NULL DEFAULT 0,
    sample_count    INT         NOT NULL DEFAULT 0,
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_metric_baselines_device    ON metric_baselines(device_id);
CREATE INDEX idx_metric_baselines_interface ON metric_baselines(interface_id);

-- Functional unique index handles nullable interface_id on PG 14
CREATE UNIQUE INDEX idx_metric_baselines_unique ON metric_baselines (
    device_id,
    COALESCE(interface_id, '00000000-0000-0000-0000-000000000000'::UUID),
    metric,
    bucket_type,
    bucket_index
);
