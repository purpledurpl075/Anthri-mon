-- 026_metric_baselines.sql
--
-- Extends the pre-existing metric_baselines table (owned by postgres, empty)
-- to support both:
--   a) time-of-week bucketed numeric baselines (original design)
--   b) rolling-window boolean state baselines (interface_down suppression)
--
-- Also adds override flags and grants access to the anthrimon app user.

-- Add columns needed for boolean/state metrics and percentiles.
ALTER TABLE metric_baselines
    ADD COLUMN IF NOT EXISTS label         TEXT,
    ADD COLUMN IF NOT EXISTS window_days   INT              NOT NULL DEFAULT 14,
    ADD COLUMN IF NOT EXISTS normal_up_pct DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS p5            DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS p95           DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS force_alert   BOOLEAN          NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS force_suppress BOOLEAN         NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS computed_at   TIMESTAMPTZ;

-- Rename metric → metric_type for consistency with the rest of the codebase.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'metric_baselines' AND column_name = 'metric'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'metric_baselines' AND column_name = 'metric_type'
    ) THEN
        ALTER TABLE metric_baselines RENAME COLUMN metric TO metric_type;
    END IF;
END $$;

-- Rename last_updated → computed_at (keep computed_at if already added above).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'metric_baselines' AND column_name = 'last_updated'
    ) THEN
        -- Copy into computed_at then drop last_updated.
        UPDATE metric_baselines SET computed_at = last_updated WHERE computed_at IS NULL;
        ALTER TABLE metric_baselines DROP COLUMN IF EXISTS last_updated;
    END IF;
END $$;

-- Additional index for label-based lookups (BGP peers, syslog).
CREATE INDEX IF NOT EXISTS idx_metric_baselines_label
    ON metric_baselines (metric_type, label)
    WHERE label IS NOT NULL;

-- Grant full access to the app user.
GRANT SELECT, INSERT, UPDATE, DELETE ON metric_baselines TO anthrimon;
