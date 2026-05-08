-- Additional standalone alert rules to complement the existing ones.
-- All scoped to the default tenant.

-- UCG-Fiber memory is at 94% — alert on high memory for Ubiquiti devices
INSERT INTO alert_rules (tenant_id, name, description, metric, condition, threshold, duration_seconds, severity, is_enabled, notify_on_resolve, device_selector, channel_ids, maintenance_window_ids)
SELECT '00000000-0000-0000-0000-000000000001', 'Memory critical (gateway)', 'UCG-Fiber / gateway memory exceeding 95% — may cause instability.',
       'mem_util_pct', 'gt', 95, 180, 'critical', true, true,
       '{"vendors": ["ubiquiti"]}', '[]', '[]'
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND name = 'Memory critical (gateway)');

-- Temperature alert for all devices (uses ENTITY-SENSOR-MIB / vendor-specific)
INSERT INTO alert_rules (tenant_id, name, description, metric, condition, threshold, duration_seconds, severity, is_enabled, notify_on_resolve, device_selector, channel_ids, maintenance_window_ids)
SELECT '00000000-0000-0000-0000-000000000001', 'Temperature high', 'Any temperature sensor exceeds 65°C.',
       'temperature', 'gt', 65, 120, 'warning', true, true,
       NULL, '[]', '[]'
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND name = 'Temperature high');

-- Interface error accumulation
INSERT INTO alert_rules (tenant_id, name, description, metric, condition, threshold, duration_seconds, severity, is_enabled, notify_on_resolve, device_selector, channel_ids, maintenance_window_ids)
SELECT '00000000-0000-0000-0000-000000000001', 'Interface errors accumulating', 'Interface in+out error count exceeds 500 — check cabling or SFP.',
       'interface_errors', 'gt', 500, 300, 'warning', true, false,
       NULL, '[]', '[]'
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND name = 'Interface errors accumulating');

-- Interface flap on non-core devices
INSERT INTO alert_rules (tenant_id, name, description, metric, condition, threshold, duration_seconds, severity, is_enabled, notify_on_resolve, device_selector, channel_ids, maintenance_window_ids)
SELECT '00000000-0000-0000-0000-000000000001', 'Interface flapping', 'Interface state has changed more than 3 times in 5 minutes.',
       'interface_flap', 'gt', 3, 300, 'warning', true, true,
       NULL, '[]', '[]'
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND name = 'Interface flapping');
