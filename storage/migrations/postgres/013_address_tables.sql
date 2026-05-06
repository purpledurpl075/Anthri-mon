-- ARP table: IP → MAC → interface, populated from ipNetToMediaTable (RFC 1213).
CREATE TABLE arp_entries (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ip_address      INET        NOT NULL,
    mac_address     MACADDR     NOT NULL,
    interface_name  TEXT,
    entry_type      TEXT        NOT NULL DEFAULT 'dynamic', -- dynamic | static | other
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, ip_address)
);

CREATE INDEX idx_arp_entries_device  ON arp_entries(device_id);
CREATE INDEX idx_arp_entries_mac     ON arp_entries(mac_address);
CREATE INDEX idx_arp_entries_ip      ON arp_entries(ip_address);

-- MAC forwarding table: MAC → port, populated from dot1dTpFdbTable (BRIDGE-MIB).
CREATE TABLE mac_entries (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    mac_address     MACADDR     NOT NULL,
    port_name       TEXT,
    vlan_id         INT,
    entry_type      TEXT        NOT NULL DEFAULT 'learned', -- learned | self | static | other
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, mac_address)
);

CREATE INDEX idx_mac_entries_device  ON mac_entries(device_id);
CREATE INDEX idx_mac_entries_mac     ON mac_entries(mac_address);
