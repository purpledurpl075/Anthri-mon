-- ============================================================
-- GOLDEN CONFIGS
-- A "golden" template of expected config lines per vendor/site.
-- Devices matching device_selector are scored against the
-- template on every config backup: score = % of (substituted)
-- template lines present in the device's running config.
-- ============================================================
CREATE TABLE golden_configs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    site_id         UUID        REFERENCES sites(id) ON DELETE SET NULL,
    name            TEXT        NOT NULL,
    description     TEXT,
    is_enabled      BOOLEAN     NOT NULL DEFAULT true,
    -- Same selector format as compliance_policies; NULL = all devices in tenant
    device_selector JSONB,
    template_text   TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_golden_configs_tenant  ON golden_configs(tenant_id);
CREATE INDEX idx_golden_configs_enabled ON golden_configs(tenant_id, is_enabled);
CREATE INDEX idx_golden_configs_site    ON golden_configs(site_id) WHERE site_id IS NOT NULL;

CREATE TRIGGER trg_golden_configs_updated_at
    BEFORE UPDATE ON golden_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- GOLDEN CONFIG RESULTS
-- One row per device + golden config check run.
-- ============================================================
CREATE TABLE golden_config_results (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id        UUID          NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    golden_config_id UUID          NOT NULL REFERENCES golden_configs(id) ON DELETE CASCADE,
    backup_id        UUID          REFERENCES config_backups(id) ON DELETE SET NULL,
    checked_at       TIMESTAMPTZ   NOT NULL,
    score            NUMERIC(5,2)  NOT NULL,
    matched_lines    INT           NOT NULL DEFAULT 0,
    total_lines      INT           NOT NULL DEFAULT 0,
    -- ["interface Vlan10 missing", ...]
    missing_lines    JSONB         NOT NULL DEFAULT '[]',
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_golden_config_results_device ON golden_config_results(device_id, golden_config_id, checked_at DESC);
CREATE INDEX idx_golden_config_results_golden ON golden_config_results(golden_config_id, checked_at DESC);
