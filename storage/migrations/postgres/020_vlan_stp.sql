-- VLANs discovered from dot1qVlanStaticTable / vtpVlanTable.
-- One row per (device, VLAN ID) — refreshed every poll cycle.
CREATE TABLE vlans (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    vlan_id     INT  NOT NULL,
    name        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (device_id, vlan_id)
);
CREATE INDEX ON vlans (device_id);

-- Port-to-VLAN membership.  One row per (interface, VLAN).
--   tagged = false → interface is in access mode for this VLAN (untagged egress)
--   tagged = true  → interface carries this VLAN tagged (trunk member)
CREATE TABLE interface_vlans (
    interface_id UUID NOT NULL REFERENCES interfaces(id) ON DELETE CASCADE,
    vlan_id      INT  NOT NULL,
    tagged       BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (interface_id, vlan_id)
);
CREATE INDEX ON interface_vlans (interface_id);

-- Add STP port state to the interfaces table.
--   stp_state: disabled | blocking | listening | learning | forwarding
--   stp_role:  unknown | root | designated | alternate | backup  (802.1D/802.1w)
ALTER TABLE interfaces
    ADD COLUMN IF NOT EXISTS stp_state TEXT,
    ADD COLUMN IF NOT EXISTS stp_role  TEXT;
