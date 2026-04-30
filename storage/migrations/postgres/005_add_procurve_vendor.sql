-- 005_add_procurve_vendor.sql
-- Extend vendor_type enum with the HP ProCurve / legacy ArubaOS switching
-- platform. ALTER TYPE ... ADD VALUE cannot run inside a transaction block,
-- so this migration must be applied outside BEGIN/COMMIT.
--
-- Apply with:
--   psql -d anthrimon -f 005_add_procurve_vendor.sql

ALTER TYPE vendor_type ADD VALUE IF NOT EXISTS 'procurve';
