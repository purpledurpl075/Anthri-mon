-- Fix OSPF duplicate rows caused by NULL interface_name bypassing the unique constraint.
-- PostgreSQL NULL != NULL, so (device_id, vrf, router_id, NULL) never conflicts.

-- 1. Keep only the most recent row per (device_id, vrf, neighbor_router_id).
DELETE FROM ospf_neighbors o1
USING ospf_neighbors o2
WHERE o1.device_id          = o2.device_id
  AND o1.vrf                = o2.vrf
  AND o1.neighbor_router_id = o2.neighbor_router_id
  AND o1.updated_at         < o2.updated_at;

-- 2. Set interface_name to '' where NULL so the constraint works.
UPDATE ospf_neighbors SET interface_name = '' WHERE interface_name IS NULL;

-- 3. Make interface_name NOT NULL with empty string default.
ALTER TABLE ospf_neighbors
    ALTER COLUMN interface_name SET NOT NULL,
    ALTER COLUMN interface_name SET DEFAULT '';
