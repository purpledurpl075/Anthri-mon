-- The Python model has always declared audit_log.action as String(30), but the
-- original schema created it as the audit_action ENUM.  No inserts ever
-- happened before 2026-06-05, so the mismatch was dormant — surfaced the
-- moment we started writing audit rows.  Convert to TEXT so the model and
-- the column agree.  The audit_action enum stays defined for compatibility
-- with any out-of-band SQL that references it.

ALTER TABLE audit_log
    ALTER COLUMN action TYPE TEXT USING action::text;
