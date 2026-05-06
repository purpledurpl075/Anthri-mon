from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models.alert import Alert, AlertRule, MaintenanceWindow
from . import notify
from .maintenance import device_in_maintenance, load_active_windows
from .evaluators import (
    Breach,
    eval_cpu, eval_mem, eval_device_down,
    eval_interface_down, eval_interface_flap,
    eval_uptime, eval_temperature, eval_interface_errors, eval_custom_oid,
    resolve_devices,
)

logger = structlog.get_logger(__name__)

EVAL_INTERVAL = 15  # seconds


def _selector_specificity(selector: Optional[dict]) -> int:
    """Higher = more specific. device_ids(3) > tags(2) > vendors(1) > all(0)."""
    if not selector:
        return 0
    if selector.get("device_ids"):
        return 3
    if selector.get("tags"):
        return 2
    if selector.get("vendors"):
        return 1
    return 0


def _device_matches_selector(device: dict, selector: Optional[dict]) -> bool:
    if not selector:
        return True
    if "device_ids" in selector:
        return device["id"] in (selector["device_ids"] or [])
    if "vendors" in selector:
        return device.get("vendor") in (selector["vendors"] or [])
    if "tags" in selector:
        dev_tags = device.get("tags") or []
        if isinstance(dev_tags, str):
            import json
            try: dev_tags = json.loads(dev_tags)
            except Exception: dev_tags = []
        return any(t in dev_tags for t in selector["tags"])
    return True


def _is_overridden(rule: AlertRule, device: dict, peer_rules: list[AlertRule]) -> bool:
    """Return True if another peer rule is more specific for this device+metric."""
    my_spec = _selector_specificity(rule.device_selector)
    for other in peer_rules:
        if other.id == rule.id or not other.is_enabled:
            continue
        if _selector_specificity(other.device_selector) > my_spec:
            if _device_matches_selector(device, other.device_selector):
                return True
    return False


def _fingerprint(rule_id: str, device_id: str, interface_id: Optional[str] = None) -> str:
    raw = f"{rule_id}:{device_id}:{interface_id or ''}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _build_title(rule: AlertRule, breach: Breach) -> str:
    base = breach.device_name
    if breach.interface_name:
        base += f" — {breach.interface_name}"
    metric_labels = {
        "cpu_util_pct":   f"CPU {breach.value:.1f}%" if breach.value is not None else "CPU high",
        "mem_util_pct":   f"Memory {breach.value:.1f}%" if breach.value is not None else "Memory high",
        "device_down":    "device unreachable",
        "interface_down": "interface down",
        "interface_flap": f"interface flapping ({int(breach.value or 0)} changes)",
    }
    return f"{base}: {metric_labels.get(rule.metric, rule.metric)}"


async def _safe_dispatch(alert: Alert, rule: AlertRule, db: AsyncSession,
                         *, resolved: bool = False) -> None:
    """Dispatch notifications without letting errors affect the DB transaction."""
    try:
        await notify.dispatch(alert, rule, db, resolved=resolved)
    except Exception as exc:
        logger.error("notify_dispatch_failed", alert_id=str(alert.id),
                     rule=rule.name, error=str(exc))


class AlertEngine:
    def __init__(self) -> None:
        self._breach_since: dict[str, datetime] = {}   # fp → breach start (duration gating)
        self._clear_since:  dict[str, datetime] = {}   # fp → clear start (flap suppression)

    async def run(self) -> None:
        logger.info("alert_engine_starting", interval_s=EVAL_INTERVAL)
        while True:
            try:
                await asyncio.sleep(EVAL_INTERVAL)
                async with AsyncSessionLocal() as db:
                    try:
                        await self._evaluate_all(db)
                        await db.commit()
                    except Exception as exc:
                        await db.rollback()
                        logger.error("alert_engine_eval_error", error=str(exc), exc_info=exc)
            except asyncio.CancelledError:
                logger.info("alert_engine_stopped")
                return
            except Exception as exc:
                logger.error("alert_engine_error", error=str(exc), exc_info=exc)

    async def _evaluate_all(self, db: AsyncSession) -> None:
        rules = (await db.execute(
            select(AlertRule).where(AlertRule.is_enabled == True)  # noqa: E712
        )).scalars().all()

        # Build per-metric override map so higher-specificity rules silence broader ones
        rules_by_metric: dict[str, list[AlertRule]] = {}
        for rule in rules:
            rules_by_metric.setdefault(rule.metric, []).append(rule)

        # Load active maintenance windows once per cycle for all tenants' rules
        tenant_ids = {str(r.tenant_id) for r in rules}
        active_windows: list = []
        for tid in tenant_ids:
            active_windows.extend(await load_active_windows(db, tid))

        for rule in rules:
            try:
                await self._evaluate_rule(db, rule, rules_by_metric.get(rule.metric, []), active_windows)
            except Exception as exc:
                await db.rollback()
                logger.error("rule_eval_error", rule_id=str(rule.id), error=str(exc))

        await self._purge_expired_windows(db)

    async def _purge_expired_windows(self, db: AsyncSession) -> None:
        """Delete one-time maintenance windows that have passed their end time."""
        now = datetime.now(timezone.utc)
        expired = (await db.execute(
            select(MaintenanceWindow).where(
                MaintenanceWindow.is_recurring == False,  # noqa: E712
                MaintenanceWindow.ends_at < now,
            )
        )).scalars().all()
        for w in expired:
            logger.info("maintenance_window_expired", id=str(w.id), name=w.name)
            await db.delete(w)

    async def _evaluate_rule(self, db: AsyncSession, rule: AlertRule,
                              peer_rules: list[AlertRule] = [],
                              active_windows: list = []) -> None:
        tenant_id = str(rule.tenant_id)
        devices = await resolve_devices(db, tenant_id, rule.device_selector)
        if not devices:
            return

        # ── Collect breaches ───────────────────────────────────────────────────
        breaches: list[Breach] = []
        for device in devices:
            # Skip if a more specific rule already handles this device+metric
            if _is_overridden(rule, device, peer_rules):
                continue

            # Check device-level alert exclusions
            exclusions = device.get("alert_exclusions") or {}
            if isinstance(exclusions, str):
                import json as _j
                try: exclusions = _j.loads(exclusions)
                except Exception: exclusions = {}
            excluded_metrics = exclusions.get("metrics", [])
            if rule.metric in excluded_metrics:
                continue

            # Skip if device is in any active maintenance window
            if device_in_maintenance(device, active_windows):
                continue

            pre_breach_count = len(breaches)

            if rule.metric == "cpu_util_pct":
                b = await eval_cpu(db, device, rule.condition, rule.threshold or 0)
                if b: breaches.append(b)
            elif rule.metric == "mem_util_pct":
                b = await eval_mem(db, device, rule.condition, rule.threshold or 0)
                if b: breaches.append(b)
            elif rule.metric == "device_down":
                b = await eval_device_down(db, device)
                if b: breaches.append(b)
            elif rule.metric == "interface_down":
                excluded_iface_ids = set(exclusions.get("interface_ids", []))
                new_breaches = await eval_interface_down(db, device)
                breaches.extend(b for b in new_breaches
                                 if b.interface_id not in excluded_iface_ids)
            elif rule.metric == "interface_flap":
                breaches.extend(await eval_interface_flap(
                    db, device,
                    threshold=rule.threshold or 3,
                    window_seconds=rule.duration_seconds or 300,
                ))
            elif rule.metric == "uptime":
                b = await eval_uptime(db, device, rule.condition or "lt", rule.threshold or 3600)
                if b: breaches.append(b)
            elif rule.metric == "temperature":
                b = await eval_temperature(db, device, rule.threshold or 60)
                if b: breaches.append(b)
            elif rule.metric == "interface_errors":
                breaches.extend(await eval_interface_errors(db, device, rule.threshold or 100))
            elif rule.metric == "custom_oid" and rule.custom_oid:
                b = await eval_custom_oid(db, device, rule.custom_oid,
                                           rule.condition or "gt", rule.threshold or 0)
                if b: breaches.append(b)

            # Extra conditions — ALL must also be true (AND logic)
            if len(breaches) > pre_breach_count and rule.extra_conditions:
                for cond in (rule.extra_conditions or []):
                    cond_metric = cond.get("metric", "")
                    cond_breach = None
                    if cond_metric == "cpu_util_pct":
                        cond_breach = await eval_cpu(db, device, cond.get("condition","gt"), cond.get("threshold",0))
                    elif cond_metric == "mem_util_pct":
                        cond_breach = await eval_mem(db, device, cond.get("condition","gt"), cond.get("threshold",0))
                    if not cond_breach:
                        breaches = breaches[:pre_breach_count]
                        break

        now = datetime.now(timezone.utc)

        # breaching_fps: condition is currently true (regardless of duration)
        # firing_fps:    condition passed duration gate → eligible to fire
        breaching_fps: set[str] = set()
        firing_fps:    set[str] = set()

        for breach in breaches:
            fp = _fingerprint(str(rule.id), breach.device_id, breach.interface_id)
            breaching_fps.add(fp)
            self._clear_since.pop(fp, None)  # still breaching → reset clear clock

            if rule.duration_seconds > 0 and rule.metric != "interface_flap":
                if fp not in self._breach_since:
                    self._breach_since[fp] = now
                    continue
                if (now - self._breach_since[fp]).total_seconds() < rule.duration_seconds:
                    continue
            else:
                self._breach_since.pop(fp, None)

            firing_fps.add(fp)

        # ── Correlated suppression: build set of devices whose parent is down ──
        suppressed_device_ids: set[str] = set()
        if rule.suppress_if_parent_down and rule.parent_device_id:
            parent_alert = (await db.execute(
                text("""
                    SELECT 1 FROM alerts
                    WHERE device_id = :pid
                      AND status IN ('open','acknowledged')
                      AND severity IN ('critical','major')
                    LIMIT 1
                """),
                {"pid": str(rule.parent_device_id)},
            )).first()
            if parent_alert:
                suppressed_device_ids = {d["id"] for d in devices}

        # ── Fire / suppress alerts ─────────────────────────────────────────────
        for breach in breaches:
            fp = _fingerprint(str(rule.id), breach.device_id, breach.interface_id)
            if fp not in firing_fps:
                continue

            if rule.metric == "device_down" and breach.device_id:
                await db.execute(
                    text("UPDATE devices SET status = 'unreachable'::device_status WHERE id = :did"),
                    {"did": breach.device_id},
                )

            existing = (await db.execute(
                select(Alert).where(Alert.fingerprint == fp, Alert.status.in_(["open", "acknowledged", "suppressed"]))
            )).scalar_one_or_none()

            if existing is None:
                suppressed = breach.device_id in suppressed_device_ids
                alert = Alert(
                    id=uuid.uuid4(),
                    tenant_id=rule.tenant_id,
                    rule_id=rule.id,
                    device_id=uuid.UUID(breach.device_id) if breach.device_id else None,
                    interface_id=uuid.UUID(breach.interface_id) if breach.interface_id else None,
                    severity=rule.severity,
                    status="suppressed" if suppressed else "open",
                    title=_build_title(rule, breach),
                    message=rule.description,
                    context={
                        "metric": rule.metric,
                        "value": breach.value,
                        "threshold": rule.threshold,
                        "condition": rule.condition,
                        **breach.extra,
                    },
                    triggered_at=now,
                    fingerprint=fp,
                    last_notified_at=now if not suppressed else None,
                )
                db.add(alert)
                if not suppressed:
                    logger.info("alert_fired", rule=rule.name, device=breach.device_name,
                                iface=breach.interface_name, severity=rule.severity)
                    await _safe_dispatch(alert, rule, db)
            elif existing.status == "suppressed" and breach.device_id not in suppressed_device_ids:
                # Parent recovered — unsuppress
                existing.status = "open"

        # ── Escalation: promote severity on long-open unacknowledged alerts ────
        if rule.escalation_severity and rule.escalation_seconds:
            open_alerts = (await db.execute(
                select(Alert).where(
                    Alert.rule_id == rule.id,
                    Alert.status == "open",
                    Alert.severity == rule.severity,
                )
            )).scalars().all()
            for alert in open_alerts:
                age = (now - alert.triggered_at).total_seconds()
                if age >= rule.escalation_seconds:
                    alert.severity = rule.escalation_severity
                    logger.info("alert_escalated", alert_id=str(alert.id),
                                to=rule.escalation_severity, rule=rule.name)

        # ── Auto-resolve with flap suppression ─────────────────────────────────
        open_alerts = (await db.execute(
            select(Alert).where(
                Alert.rule_id == rule.id,
                Alert.status.in_(["open", "acknowledged"]),
            )
        )).scalars().all()

        for alert in open_alerts:
            fp = alert.fingerprint or ""
            if fp in breaching_fps:
                # Still breaching — check re-notify interval
                if rule.renotify_seconds > 0 and alert.last_notified_at is not None:
                    elapsed = (now - alert.last_notified_at).total_seconds()
                    if elapsed >= rule.renotify_seconds:
                        alert.last_notified_at = now
                        await _safe_dispatch(alert, rule, db)
                continue

            # Acknowledged alerts are not auto-resolved — operator must clear them
            if alert.status == "acknowledged":
                continue

            # Condition cleared — start or check the stable clock
            if rule.stable_for_seconds > 0:
                if fp not in self._clear_since:
                    self._clear_since[fp] = now
                    continue  # wait for stability
                if (now - self._clear_since[fp]).total_seconds() < rule.stable_for_seconds:
                    continue  # not stable yet

            # Resolve
            alert.status = "resolved"
            alert.resolved_at = now
            self._breach_since.pop(fp, None)
            self._clear_since.pop(fp, None)

            if rule.metric == "device_down" and alert.device_id:
                await db.execute(
                    text("UPDATE devices SET status = 'unknown'::device_status WHERE id = :did AND status = 'unreachable'::device_status"),
                    {"did": str(alert.device_id)},
                )
            logger.info("alert_auto_resolved", alert_id=str(alert.id), rule=rule.name)
            if rule.notify_on_resolve:
                await _safe_dispatch(alert, rule, db, resolved=True)


_engine = AlertEngine()


async def start_alert_engine() -> asyncio.Task:
    return asyncio.create_task(_engine.run(), name="alert-engine")
