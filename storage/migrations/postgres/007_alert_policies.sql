-- 007_alert_policies.sql
-- Alert policy templates: named bundles of rules applied to a device selector.
-- Built-in templates (is_builtin=true) are seeded at API startup.
-- User-created policies (is_builtin=false) are fully editable.

CREATE TABLE alert_policies (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name            TEXT        NOT NULL,
    description     TEXT,
    is_enabled      BOOLEAN     NOT NULL DEFAULT true,
    is_builtin      BOOLEAN     NOT NULL DEFAULT false,
    device_selector JSONB,                     -- null = all devices
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_alert_policies_tenant    ON alert_policies(tenant_id);
CREATE INDEX idx_alert_policies_enabled   ON alert_policies(tenant_id, is_enabled);

CREATE TRIGGER trg_alert_policies_updated_at
    BEFORE UPDATE ON alert_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
