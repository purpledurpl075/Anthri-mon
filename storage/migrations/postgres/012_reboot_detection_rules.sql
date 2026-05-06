-- Reboot and interface-flap detection rules.
-- These fill gaps left by device_down (which only fires after the SNMP stale
-- threshold, so fast reboots < 90s go undetected).

-- "Device rebooted" fires the moment device_health_latest shows uptime < 300s.
-- It self-resolves once uptime climbs above the threshold.
-- duration_seconds = 0 so it fires on the very first health poll after reboot.
INSERT INTO alert_rules (
    tenant_id, name, description,
    metric, condition, threshold,
    duration_seconds, severity, is_enabled, notify_on_resolve,
    device_selector, channel_ids, maintenance_window_ids
)
SELECT
    '00000000-0000-0000-0000-000000000001',
    'Device rebooted',
    'Device uptime is under 5 minutes — indicates a recent reboot or power cycle.',
    'uptime', 'lt', 300,
    0, 'warning', true, true,
    NULL, '[]', '[]'
WHERE NOT EXISTS (
    SELECT 1 FROM alert_rules
    WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
      AND name = 'Device rebooted'
);

-- "Core device rebooted" — same but critical severity for core-tagged devices.
INSERT INTO alert_rules (
    tenant_id, name, description,
    metric, condition, threshold,
    duration_seconds, severity, is_enabled, notify_on_resolve,
    device_selector, channel_ids, maintenance_window_ids
)
SELECT
    '00000000-0000-0000-0000-000000000001',
    'Core device rebooted',
    'Core device uptime under 5 minutes — warrants immediate attention.',
    'uptime', 'lt', 300,
    0, 'critical', true, true,
    '{"tags": ["core"]}', '[]', '[]'
WHERE NOT EXISTS (
    SELECT 1 FROM alert_rules
    WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
      AND name = 'Core device rebooted'
);
