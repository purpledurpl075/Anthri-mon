-- Add SNMP engine ID to devices table.
-- The engine ID is a device property (derived from hardware), not a credential secret.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_engine_id TEXT;
