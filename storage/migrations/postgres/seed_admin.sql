-- Default admin user seed (run once after migrations)
-- Username: admin  Password: admin
-- Change the password immediately after first login.
INSERT INTO users (tenant_id, username, email, password_hash, role)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'admin',
    'admin@local',
    '$2b$12$z0C6pOdqRfULaH6IFrcdLuuMtnGQmTsuS3iMxaS.nB22c9sN0Zdb6',
    'superadmin'
)
ON CONFLICT DO NOTHING;
