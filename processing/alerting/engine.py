from __future__ import annotations

"""
Alert evaluation engine.

Each evaluation cycle:
  1. Load enabled alert rules from DB.
  2. Run built-in checks (interface down, device unreachable).
  3. Run rule-based threshold checks (CPU, memory, temperature).
  4. For each firing condition:
       - If no open alert with the same fingerprint exists → create alert + notify.
  5. For each open alert whose condition is no longer true → auto-resolve.
  6. Handle re-notification for long-running open alerts.
"""

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any

import asyncpg
import structlog

from .config import Settings
from .notifier import send_alert_notification, send_resolve_notification

logger = structlog.get_logger(__name__)

# Built-in fingerprint prefixes (no DB rule_id required).
FP_IFACE_DOWN    = "iface_down"
FP_DEVICE_DOWN   = "device_down"
FP_DEVICE_UNREACH = "device_unreach"


# ── Data classes ──────────────────────────────────────────────────────────────

class FiringAlert:
    """Represents a condition that should be open/stay open."""
    __slots__ = (
        "tenant_id", "device_id", "interface_id", "rule_id",
        "severity", "title", "message", "context", "fingerprint",
    )

    def __init__(
        self,
        tenant_id: str,
        device_id: str,
        severity: str,
        title: str,
        message: str,
        context: dict,
        fingerprint: str,
        interface_id: str | None = None,
        rule_id: str | None = None,
    ) -> None:
        self.tenant_id    = tenant_id
        self.device_id    = device_id
        self.interface_id = interface_id
        self.rule_id      = rule_id
        self.severity     = severity
        self.title        = title
        self.message      = message
        self.context      = context
        self.fingerprint  = fingerprint


# ── Engine ─────────────────────────────────────────────────────────────────────

class AlertEngine:
    def __init__(self, pool: asyncpg.Pool, cfg: Settings) -> None:
        self.pool = pool
        self.cfg  = cfg

    async def run_once(self) -> None:
        """Single evaluation cycle."""
        try:
            firing = await self._collect_firing()
            await self._reconcile(firing)
        except Exception as exc:
            logger.error("eval_cycle_failed", error=str(exc), exc_info=exc)

    # ── Collect all currently-firing conditions ──────────────────────────────

    async def _collect_firing(self) -> list[FiringAlert]:
        firing: list[FiringAlert] = []
        firing.extend(await self._check_interface_down())
        firing.extend(await self._check_device_unreachable())
        firing.extend(await self._check_rules())
        return firing

    async def _check_interface_down(self) -> list[FiringAlert]:
        """Interfaces that are admin-up but oper-down."""
        rows = await self.pool.fetch("""
            SELECT
                i.id          AS iface_id,
                i.name        AS iface_name,
                i.oper_status,
                d.id          AS device_id,
                d.tenant_id,
                COALESCE(d.fqdn, d.hostname) AS hostname,
                d.vendor
            FROM interfaces i
            JOIN devices d ON i.device_id = d.id
            WHERE d.is_active = true
              AND i.admin_status = 'up'
              AND i.oper_status  = 'down'
              AND (
                -- Only alert on ports that have evidence of ever being used:
                -- has a description, has IP addresses, or has been seen 'up' in history
                (i.description IS NOT NULL AND i.description != '')
                OR jsonb_array_length(COALESCE(i.ip_addresses, '[]')) > 0
                OR EXISTS (
                    SELECT 1 FROM interface_status_log l
                    WHERE l.interface_id = i.id AND l.new_status = 'up'
                )
              )
        """)

        result = []
        for r in rows:
            status = r["oper_status"]
            title  = f"Interface {r['iface_name']} {status} on {r['hostname']}"
            msg    = (
                f"Interface {r['iface_name']} on {r['hostname']} ({r['vendor']}) "
                f"is administratively up but operationally {status}."
            )
            result.append(FiringAlert(
                tenant_id    = str(r["tenant_id"]),
                device_id    = str(r["device_id"]),
                interface_id = str(r["iface_id"]),
                severity     = "major",
                title        = title,
                message      = msg,
                context      = {"oper_status": status, "iface_name": r["iface_name"]},
                fingerprint  = f"{FP_IFACE_DOWN}:{r['iface_id']}",
            ))
        return result

    async def _check_device_unreachable(self) -> list[FiringAlert]:
        """Devices not polled in > 3× their polling interval."""
        rows = await self.pool.fetch("""
            SELECT
                id, tenant_id,
                COALESCE(fqdn, hostname) AS hostname,
                vendor, status,
                polling_interval_s,
                last_polled
            FROM devices
            WHERE is_active = true
              AND last_polled IS NOT NULL
              AND EXTRACT(EPOCH FROM (NOW() - last_polled)) > polling_interval_s * 3
        """)

        result = []
        for r in rows:
            age = int((datetime.now(timezone.utc) - r["last_polled"].replace(tzinfo=timezone.utc)).total_seconds())
            title = f"Device {r['hostname']} not responding"
            msg   = (
                f"No SNMP response from {r['hostname']} ({r['vendor']}) for {age}s "
                f"(expected every {r['polling_interval_s']}s)."
            )
            result.append(FiringAlert(
                tenant_id = str(r["tenant_id"]),
                device_id = str(r["id"]),
                severity  = "critical",
                title     = title,
                message   = msg,
                context   = {"last_polled_age_s": age, "polling_interval_s": r["polling_interval_s"]},
                fingerprint = f"{FP_DEVICE_UNREACH}:{r['id']}",
            ))
        return result

    async def _check_rules(self) -> list[FiringAlert]:
        """Evaluate DB-defined threshold rules."""
        rules = await self.pool.fetch("""
            SELECT id, tenant_id, name, metric, condition, threshold, severity, channel_ids
            FROM alert_rules
            WHERE is_enabled = true
        """)

        result = []
        for rule in rules:
            try:
                hits = await self._eval_rule(rule)
                result.extend(hits)
            except Exception as exc:
                logger.warning("rule_eval_failed", rule_id=str(rule["id"]), error=str(exc))
        return result

    async def _eval_rule(self, rule: asyncpg.Record) -> list[FiringAlert]:
        metric    = rule["metric"]
        condition = rule["condition"].strip()
        threshold = float(rule["threshold"]) if rule["threshold"] is not None else None
        severity  = rule["severity"]
        rule_id   = str(rule["id"])
        tenant_id = str(rule["tenant_id"])

        if metric == "cpu_util_pct":
            return await self._threshold_health(
                tenant_id, rule_id, severity, metric, condition, threshold,
                col="cpu_util_pct",
                title_tmpl="CPU high on {hostname} ({value:.1f}%)",
                msg_tmpl="CPU utilisation on {hostname} is {value:.1f}% (threshold: {threshold}%).",
                fp_prefix="cpu",
            )
        if metric == "mem_util_pct":
            return await self._threshold_health(
                tenant_id, rule_id, severity, metric, condition, threshold,
                col=None,  # computed from mem_used/mem_total
                title_tmpl="Memory high on {hostname} ({value:.1f}%)",
                msg_tmpl="Memory utilisation on {hostname} is {value:.1f}% (threshold: {threshold}%).",
                fp_prefix="mem",
            )
        if metric == "temperature":
            return await self._threshold_temp(tenant_id, rule_id, severity, condition, threshold)

        logger.debug("unsupported_metric", metric=metric, rule_id=rule_id)
        return []

    async def _threshold_health(
        self,
        tenant_id: str,
        rule_id: str,
        severity: str,
        metric: str,
        condition: str,
        threshold: float | None,
        col: str | None,
        title_tmpl: str,
        msg_tmpl: str,
        fp_prefix: str,
    ) -> list[FiringAlert]:
        if threshold is None:
            return []

        rows = await self.pool.fetch("""
            SELECT
                d.id AS device_id,
                COALESCE(d.fqdn, d.hostname) AS hostname,
                h.cpu_util_pct,
                h.mem_used_bytes,
                h.mem_total_bytes
            FROM device_health_latest h
            JOIN devices d ON h.device_id = d.id
            WHERE d.tenant_id = $1 AND d.is_active = true
        """, uuid.UUID(tenant_id))

        result = []
        for r in rows:
            if metric == "cpu_util_pct":
                value = float(r["cpu_util_pct"]) if r["cpu_util_pct"] is not None else None
            else:
                used  = r["mem_used_bytes"]
                total = r["mem_total_bytes"]
                value = (float(used) / float(total) * 100) if used and total else None

            if value is None:
                continue
            if not _compare(value, condition, threshold):
                continue

            ctx = {"metric": metric, "value": round(value, 2), "threshold": threshold}
            hostname = r["hostname"]
            result.append(FiringAlert(
                tenant_id   = tenant_id,
                device_id   = str(r["device_id"]),
                rule_id     = rule_id,
                severity    = severity,
                title       = title_tmpl.format(hostname=hostname, value=value),
                message     = msg_tmpl.format(hostname=hostname, value=value, threshold=threshold),
                context     = ctx,
                fingerprint = f"{fp_prefix}:{r['device_id']}:{rule_id}",
            ))
        return result

    async def _threshold_temp(
        self,
        tenant_id: str,
        rule_id: str,
        severity: str,
        condition: str,
        threshold: float | None,
    ) -> list[FiringAlert]:
        if threshold is None:
            return []

        rows = await self.pool.fetch("""
            SELECT d.id AS device_id, COALESCE(d.fqdn, d.hostname) AS hostname, h.temperatures
            FROM device_health_latest h
            JOIN devices d ON h.device_id = d.id
            WHERE d.tenant_id = $1 AND d.is_active = true
              AND h.temperatures IS NOT NULL
        """, uuid.UUID(tenant_id))

        result = []
        for r in rows:
            temps = r["temperatures"]
            if not temps:
                continue
            if isinstance(temps, str):
                temps = json.loads(temps)
            for sensor in temps:
                celsius = sensor.get("celsius")
                if celsius is None:
                    continue
                if not _compare(float(celsius), condition, threshold):
                    continue
                name = sensor.get("sensor", "unknown")
                title = f"Temperature alert on {r['hostname']} ({name}: {celsius}°C)"
                msg   = f"Sensor '{name}' on {r['hostname']} is {celsius}°C (threshold: {threshold}°C)."
                result.append(FiringAlert(
                    tenant_id   = tenant_id,
                    device_id   = str(r["device_id"]),
                    rule_id     = rule_id,
                    severity    = severity,
                    title       = title,
                    message     = msg,
                    context     = {"sensor": name, "celsius": celsius, "threshold": threshold},
                    fingerprint = f"temp:{r['device_id']}:{name}:{rule_id}",
                ))
        return result

    # ── Reconcile firing vs DB open alerts ────────────────────────────────────

    async def _reconcile(self, firing: list[FiringAlert]) -> None:
        firing_fps = {a.fingerprint: a for a in firing}

        # Load all open alerts so we can compare fingerprints.
        open_alerts = await self.pool.fetch("""
            SELECT id, tenant_id, fingerprint, rule_id, device_id, interface_id,
                   severity, title, triggered_at, last_notified_at
            FROM alerts
            WHERE status = 'open'
        """)
        open_fps = {r["fingerprint"]: r for r in open_alerts if r["fingerprint"]}

        now = datetime.now(timezone.utc)

        # ── Fire new alerts ────────────────────────────────────────────────────
        for fp, alert in firing_fps.items():
            if fp in open_fps:
                # Already open — check if re-notification is due.
                existing = open_fps[fp]
                await self._maybe_renotify(existing, alert, now)
                continue

            alert_id = await self._create_alert(alert, now)
            channels = await self._load_channels(alert.tenant_id, alert.rule_id)
            await send_alert_notification(
                self.cfg.notifications,
                alert.title,
                alert.message,
                alert.severity,
                alert.context,
                channels,
            )
            logger.info(
                "alert_fired",
                alert_id=str(alert_id),
                fingerprint=fp,
                severity=alert.severity,
                title=alert.title,
            )

        # ── Auto-resolve alerts that are no longer firing ─────────────────────
        for fp, existing in open_fps.items():
            if fp not in firing_fps:
                await self._resolve_alert(existing["id"], now)
                channels = await self._load_channels(
                    str(existing["tenant_id"]), str(existing["rule_id"]) if existing["rule_id"] else None
                )
                await send_resolve_notification(
                    self.cfg.notifications, existing["title"], channels
                )
                logger.info("alert_resolved", alert_id=str(existing["id"]), title=existing["title"])

    async def _create_alert(self, alert: FiringAlert, now: datetime) -> uuid.UUID:
        alert_id = uuid.uuid4()
        await self.pool.execute("""
            INSERT INTO alerts (
                id, tenant_id, rule_id, device_id, interface_id,
                severity, status, title, message, context,
                fingerprint, triggered_at, last_notified_at, created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6::alert_severity, 'open'::alert_status, $7, $8, $9,
                $10, $11, $11, $11, $11
            )
        """,
            alert_id,
            uuid.UUID(alert.tenant_id),
            uuid.UUID(alert.rule_id) if alert.rule_id else None,
            uuid.UUID(alert.device_id),
            uuid.UUID(alert.interface_id) if alert.interface_id else None,
            alert.severity,
            alert.title,
            alert.message,
            json.dumps(alert.context),
            alert.fingerprint,
            now,
        )
        return alert_id

    async def _resolve_alert(self, alert_id: uuid.UUID, now: datetime) -> None:
        await self.pool.execute("""
            UPDATE alerts
            SET status = 'resolved'::alert_status, resolved_at = $1, updated_at = $1
            WHERE id = $2
        """, now, alert_id)

    async def _maybe_renotify(
        self, existing: asyncpg.Record, alert: FiringAlert, now: datetime
    ) -> None:
        """Re-send notification for long-running open alerts if rule requests it."""
        if not existing["last_notified_at"]:
            return
        rule_id = existing["rule_id"]
        if not rule_id:
            return
        rule = await self.pool.fetchrow(
            "SELECT renotify_seconds FROM alert_rules WHERE id = $1", rule_id
        )
        if not rule or not rule["renotify_seconds"]:
            return
        elapsed = (now - existing["last_notified_at"].replace(tzinfo=timezone.utc)).total_seconds()
        if elapsed < rule["renotify_seconds"]:
            return

        channels = await self._load_channels(alert.tenant_id, str(rule_id))
        await send_alert_notification(
            self.cfg.notifications, alert.title, alert.message,
            alert.severity, alert.context, channels,
        )
        await self.pool.execute(
            "UPDATE alerts SET last_notified_at = $1, updated_at = $1 WHERE id = $2",
            now, existing["id"],
        )

    async def _load_channels(
        self, tenant_id: str, rule_id: str | None
    ) -> list[dict]:
        if not rule_id:
            return []
        rule = await self.pool.fetchrow(
            "SELECT channel_ids FROM alert_rules WHERE id = $1", uuid.UUID(rule_id)
        )
        if not rule or not rule["channel_ids"]:
            return []
        ids = rule["channel_ids"]
        if isinstance(ids, str):
            ids = json.loads(ids)
        if not ids:
            return []
        rows = await self.pool.fetch("""
            SELECT id, name, type, config FROM notification_channels
            WHERE id = ANY($1::uuid[]) AND is_enabled = true
        """, [uuid.UUID(i) for i in ids])
        return [dict(r) for r in rows]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _compare(value: float, condition: str, threshold: float) -> bool:
    if condition == ">":   return value > threshold
    if condition == ">=":  return value >= threshold
    if condition == "<":   return value < threshold
    if condition == "<=":  return value <= threshold
    if condition == "==":  return value == threshold
    if condition == "!=":  return value != threshold
    return False
