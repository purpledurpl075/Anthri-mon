-- 004_add_orchestration.sql
-- Phase 4: change management workflow, automated remediation,
-- zero-touch device provisioning templates.

-- ============================================================
-- ENUMERATIONS
-- ============================================================

CREATE TYPE change_status AS ENUM (
    'draft',
    'pending_approval',
    'approved',
    'rejected',
    'executing',
    'completed',
    'failed',
    'rolled_back',
    'cancelled'
);

CREATE TYPE change_action_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed',
    'skipped',
    'rolled_back'
);


-- ============================================================
-- CHANGE REQUESTS
-- Top-level change record. One CR groups ordered steps
-- (change_actions) across one or more devices.
-- ============================================================
CREATE TABLE change_requests (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID            NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    title               TEXT            NOT NULL,
    description         TEXT,
    status              change_status   NOT NULL DEFAULT 'draft',
    requested_by        UUID            NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approved_by         UUID            REFERENCES users(id) ON DELETE SET NULL,
    executed_by         UUID            REFERENCES users(id) ON DELETE SET NULL,
    approval_notes      TEXT,
    rejection_reason    TEXT,
    -- Optional pre-scheduled execution time
    scheduled_at        TIMESTAMPTZ,
    executed_at         TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    -- Human-readable rollback procedure or reference to a rollback CR
    rollback_plan       TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_change_requests_tenant       ON change_requests(tenant_id);
CREATE INDEX idx_change_requests_status       ON change_requests(status);
CREATE INDEX idx_change_requests_requested_by ON change_requests(requested_by);
CREATE INDEX idx_change_requests_scheduled    ON change_requests(scheduled_at)
    WHERE status = 'approved' AND scheduled_at IS NOT NULL;

CREATE TRIGGER trg_change_requests_updated_at
    BEFORE UPDATE ON change_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- CHANGE ACTIONS
-- Ordered atomic steps within a change request.
-- The orchestration engine executes these in step_order sequence,
-- stopping on first failure unless the CR is marked ignore_errors.
--
-- action_type values and their payload schemas:
--   config_push          : {"config_text": "...", "method": "netconf|ssh|api"}
--   interface_shutdown   : {"interface": "GigabitEthernet0/0/0"}
--   interface_no_shutdown: {"interface": "GigabitEthernet0/0/0"}
--   bgp_soft_reset       : {"peer_ip": "10.0.0.1", "direction": "in|out|both"}
--   command_run          : {"commands": ["show run", "show bgp sum"]}
--   netconf_edit         : {"xml_payload": "<...>"}
--   wait_seconds         : {"seconds": 30}   (pause between steps)
-- ============================================================
CREATE TABLE change_actions (
    id                  UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id   UUID                    NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
    device_id           UUID                    NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    step_order          INT                     NOT NULL DEFAULT 0,
    action_type         TEXT                    NOT NULL,
    payload             JSONB                   NOT NULL DEFAULT '{}',
    status              change_action_status    NOT NULL DEFAULT 'pending',
    -- Raw device output captured during execution
    output              TEXT,
    error_message       TEXT,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ             NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_change_actions_change_request ON change_actions(change_request_id, step_order);
CREATE INDEX idx_change_actions_device         ON change_actions(device_id);
CREATE INDEX idx_change_actions_status         ON change_actions(status);


-- ============================================================
-- REMEDIATION RULES
-- Automatic corrective actions triggered when an alert rule fires.
-- The alerting engine matches open alerts to these rules and either
-- fires automatically or creates a pending change request.
-- ============================================================
CREATE TABLE remediation_rules (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name                TEXT        NOT NULL,
    description         TEXT,
    is_enabled          BOOLEAN     NOT NULL DEFAULT true,
    -- Which alert rule triggers this remediation
    trigger_rule_id     UUID        REFERENCES alert_rules(id) ON DELETE SET NULL,
    -- Minimum seconds between remediations for the same device+alert to prevent loops
    cooldown_seconds    INT         NOT NULL DEFAULT 3600,
    -- If true, creates a pending change request rather than auto-executing
    requires_approval   BOOLEAN     NOT NULL DEFAULT true,
    action_type         TEXT        NOT NULL,
    action_payload      JSONB       NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_remediation_rules_tenant  ON remediation_rules(tenant_id);
CREATE INDEX idx_remediation_rules_trigger ON remediation_rules(trigger_rule_id);

CREATE TRIGGER trg_remediation_rules_updated_at
    BEFORE UPDATE ON remediation_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- DEVICE TEMPLATES
-- Jinja2 config templates for zero-touch provisioning.
-- The provisioning engine renders the template with supplied
-- variables and pushes the result via Netconf/SSH.
--
-- variables_schema is a JSON Schema object describing required
-- and optional template variables (used by the UI form builder).
-- ============================================================
CREATE TABLE device_templates (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name                TEXT        NOT NULL,
    description         TEXT,
    vendor              vendor_type NOT NULL,
    device_type         device_type NOT NULL,
    config_template     TEXT        NOT NULL,   -- Jinja2 template body
    variables_schema    JSONB       NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_device_templates_tenant ON device_templates(tenant_id);
CREATE INDEX idx_device_templates_vendor ON device_templates(vendor, device_type);

CREATE TRIGGER trg_device_templates_updated_at
    BEFORE UPDATE ON device_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- PROVISIONING JOBS
-- Tracks each zero-touch provisioning attempt: template rendered,
-- pushed, verified. Links back to the device once it registers.
-- ============================================================
CREATE TABLE provisioning_jobs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    template_id         UUID        NOT NULL REFERENCES device_templates(id) ON DELETE RESTRICT,
    -- Populated once the device registers back to the API
    device_id           UUID        REFERENCES devices(id) ON DELETE SET NULL,
    -- Variable values rendered into the template
    variables           JSONB       NOT NULL DEFAULT '{}',
    -- "pending", "rendering", "pushing", "verifying", "completed", "failed"
    status              TEXT        NOT NULL DEFAULT 'pending',
    rendered_config     TEXT,
    output              TEXT,
    error_message       TEXT,
    created_by          UUID        REFERENCES users(id) ON DELETE SET NULL,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_provisioning_jobs_tenant   ON provisioning_jobs(tenant_id);
CREATE INDEX idx_provisioning_jobs_template ON provisioning_jobs(template_id);
CREATE INDEX idx_provisioning_jobs_device   ON provisioning_jobs(device_id);
CREATE INDEX idx_provisioning_jobs_status   ON provisioning_jobs(status);

CREATE TRIGGER trg_provisioning_jobs_updated_at
    BEFORE UPDATE ON provisioning_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
