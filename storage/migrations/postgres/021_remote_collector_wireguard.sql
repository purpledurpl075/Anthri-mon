-- 021_remote_collector_wireguard.sql
-- Extend remote_collectors with WireGuard VPN fields, per-collector API key,
-- hostname tracking, and capabilities declaration.
--
-- Registration flow:
--   1. Admin creates collector → generates one-time registration_token (stored as token_hash)
--   2. Collector POSTs bootstrap request with token + wg_public_key
--   3. Hub assigns wg_ip, stores wg_public_key, generates api_key (stored as api_key_hash)
--   4. All subsequent requests use api_key over the WireGuard tunnel

-- ── WireGuard fields ──────────────────────────────────────────────────────────

ALTER TABLE remote_collectors
    -- Collector's WireGuard public key (Curve25519, base64)
    ADD COLUMN IF NOT EXISTS wg_public_key TEXT,

    -- Assigned /32 address in the 10.100.0.0/24 overlay (e.g. 10.100.0.2)
    ADD COLUMN IF NOT EXISTS wg_ip INET,

    -- Hashed API key for ongoing authentication through the tunnel.
    -- Separate from token_hash which is the one-time bootstrap token.
    ADD COLUMN IF NOT EXISTS api_key_hash TEXT,

    -- Collector's reported hostname (set during bootstrap)
    ADD COLUMN IF NOT EXISTS hostname TEXT,

    -- Which collection modules this binary supports
    ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '["snmp","flow","syslog"]',

    -- Timestamp of successful bootstrap (wg peer added)
    ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ,

    -- Explicit status for dashboard display
    -- Computed values: pending (not yet bootstrapped), online, offline
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

-- Only one collector may hold a given WireGuard IP
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_collectors_wg_ip
    ON remote_collectors(wg_ip) WHERE wg_ip IS NOT NULL;

-- Fast lookup by api_key_hash on every authenticated request
CREATE INDEX IF NOT EXISTS idx_remote_collectors_api_key
    ON remote_collectors(api_key_hash) WHERE api_key_hash IS NOT NULL;

-- ── WireGuard IP pool tracking ────────────────────────────────────────────────
-- Tracks which IPs in the 10.100.0.0/24 overlay have been assigned.
-- The hub owns 10.100.0.1; collectors are assigned .2 onwards.

CREATE TABLE IF NOT EXISTS wg_ip_pool (
    ip          INET        PRIMARY KEY,
    assigned_to UUID        REFERENCES remote_collectors(id) ON DELETE SET NULL,
    allocated   BOOLEAN     NOT NULL DEFAULT false,
    allocated_at TIMESTAMPTZ
);

-- Pre-populate the pool for the first 50 addresses (.2 through .51).
-- The pool can be extended by inserting more rows as needed.
INSERT INTO wg_ip_pool (ip)
SELECT ('10.100.0.' || generate_series(2, 51))::INET
ON CONFLICT DO NOTHING;

-- ── Bootstrap token expiry ────────────────────────────────────────────────────
-- Allow registration tokens to expire so unused tokens don't accumulate.

ALTER TABLE remote_collectors
    ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

-- ── Comment ───────────────────────────────────────────────────────────────────
COMMENT ON TABLE remote_collectors IS
    'Branch-site collector agents that connect back to the hub over WireGuard VPN. '
    'Bootstrap: one-time token over HTTPS. Ongoing: api_key over WireGuard tunnel.';

COMMENT ON TABLE wg_ip_pool IS
    'WireGuard overlay IP allocation pool (10.100.0.0/24). Hub = 10.100.0.1.';

COMMENT ON COLUMN remote_collectors.token_hash IS
    'SHA-256 of the one-time bootstrap registration token.';

COMMENT ON COLUMN remote_collectors.api_key_hash IS
    'SHA-256 of the per-collector API key used for all ongoing requests through the tunnel.';

COMMENT ON COLUMN remote_collectors.wg_ip IS
    'Assigned /32 address in the 10.100.0.0/24 WireGuard overlay.';
