-- Requires superuser: sudo -u postgres psql -d anthrimon < storage/migrations/postgres/016_aruba_ap_vendor.sql
ALTER TYPE vendor_type ADD VALUE IF NOT EXISTS 'aruba_ap';
