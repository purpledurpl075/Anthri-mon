-- 010_device_sysinfo_fields.sql
-- Add sys_location and sys_contact to devices (populated from SNMP MIB-II system group).
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS sys_location TEXT,
    ADD COLUMN IF NOT EXISTS sys_contact  TEXT;
