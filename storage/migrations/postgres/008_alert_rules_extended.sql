-- 008_alert_rules_extended.sql
-- Extends alert_rules with enterprise-grade alerting fields:
--   escalation, flap suppression, correlated suppression,
--   baseline deviation, multi-condition AND logic, policy linkage.

-- Link rules back to the policy that created them
ALTER TABLE alert_rules
    ADD COLUMN policy_id UUID REFERENCES alert_policies(id) ON DELETE SET NULL;

-- Escalation: if alert stays open+unacked for escalation_seconds, promote severity
ALTER TABLE alert_rules
    ADD COLUMN escalation_severity  alert_severity,
    ADD COLUMN escalation_seconds   INTEGER;

-- Flap suppression: don't auto-resolve until condition has been clear for N seconds.
-- Prevents re-fire storms on toggling interfaces.
ALTER TABLE alert_rules
    ADD COLUMN stable_for_seconds   INTEGER NOT NULL DEFAULT 0;

-- Correlated suppression: silence this alert when upstream device is unreachable
ALTER TABLE alert_rules
    ADD COLUMN suppress_if_parent_down  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN parent_device_id         UUID REFERENCES devices(id) ON DELETE SET NULL;

-- Baseline deviation: alert when metric is X% above 7-day rolling average
ALTER TABLE alert_rules
    ADD COLUMN baseline_enabled         BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN baseline_deviation_pct   NUMERIC(5,2);

-- Multi-condition AND: all extra conditions must also be true to fire
-- Format: [{"metric": "mem_util_pct", "condition": "gt", "threshold": 85}]
ALTER TABLE alert_rules
    ADD COLUMN extra_conditions JSONB NOT NULL DEFAULT '[]';

-- Send a "cleared" notification when alert auto-resolves
ALTER TABLE alert_rules
    ADD COLUMN notify_on_resolve BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX idx_alert_rules_policy ON alert_rules(policy_id) WHERE policy_id IS NOT NULL;
