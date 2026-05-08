-- Requires superuser (postgres) — run as:
-- sudo -u postgres psql -d anthrimon -f storage/migrations/postgres/015_ubiquiti_vendor.sql
ALTER TYPE vendor_type ADD VALUE IF NOT EXISTS 'ubiquiti';
