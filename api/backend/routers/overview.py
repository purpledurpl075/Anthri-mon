from __future__ import annotations

from datetime import datetime, timezone

import structlog
from fastapi import APIRouter, Depends
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.alert import Alert
from ..models.device import Device
from ..models.tenant import User

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["overview"])


@router.get("/overview", summary="Dashboard summary stats")
async def overview(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tid = current_user.tenant_id

    # ── Device counts by status ───────────────────────────────────────────────
    status_rows = await db.execute(
        select(Device.status, func.count().label("n"))
        .where(Device.tenant_id == tid, Device.is_active == True)  # noqa: E712
        .group_by(Device.status)
    )
    status_counts: dict[str, int] = {row.status: row.n for row in status_rows}

    devices_total       = sum(status_counts.values())
    devices_up          = status_counts.get("up", 0)
    devices_down        = status_counts.get("down", 0)
    devices_unreachable = status_counts.get("unreachable", 0)
    devices_unknown     = status_counts.get("unknown", 0)

    # ── Alert counts by severity (open only) ─────────────────────────────────
    alert_rows = await db.execute(
        select(Alert.severity, func.count().label("n"))
        .where(Alert.tenant_id == tid, text("alerts.status = 'open'::alert_status"))
        .group_by(Alert.severity)
    )
    alert_counts: dict[str, int] = {row.severity: row.n for row in alert_rows}
    alerts_open     = sum(alert_counts.values())
    alerts_critical = alert_counts.get("critical", 0)
    alerts_major    = alert_counts.get("major", 0)

    # ── Last poll time ────────────────────────────────────────────────────────
    last_poll_result = await db.execute(
        select(func.max(Device.last_polled)).where(Device.tenant_id == tid)
    )
    last_polled_at: datetime | None = last_poll_result.scalar_one_or_none()

    # ── Devices that are down, unreachable, or have a stale poll (up to 8) ────
    problem_result = await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.mgmt_ip, Device.vendor, Device.status, Device.last_seen, Device.platform)
        .where(
            Device.tenant_id == tid,
            Device.is_active == True,  # noqa: E712
            text("""
                devices.status IN ('down'::device_status, 'unreachable'::device_status)
                OR devices.last_polled IS NULL
                OR devices.last_polled < NOW() - INTERVAL '90 seconds'
            """),
        )
        .order_by(Device.last_seen.asc().nullsfirst())
        .limit(8)
    )
    problem_devices = [
        {
            "id": str(row.id),
            "hostname": row.fqdn or row.hostname,
            "label": row.hostname,
            "mgmt_ip": str(row.mgmt_ip),
            "vendor": row.vendor,
            "status": row.status,
            "last_seen": row.last_seen.isoformat() if row.last_seen else None,
        }
        for row in problem_result
    ]

    # ── Recent open alerts (up to 8) ─────────────────────────────────────────
    recent_alerts_result = await db.execute(
        select(Alert.id, Alert.title, Alert.severity, Alert.status, Alert.triggered_at, Alert.device_id)
        .where(Alert.tenant_id == tid, text("alerts.status = 'open'::alert_status"))
        .order_by(Alert.triggered_at.desc())
        .limit(8)
    )
    recent_alerts = [
        {
            "id": str(row.id),
            "title": row.title,
            "severity": row.severity,
            "triggered_at": row.triggered_at.isoformat() if row.triggered_at else None,
            "device_id": str(row.device_id) if row.device_id else None,
        }
        for row in recent_alerts_result
    ]

    return {
        "devices": {
            "total":       devices_total,
            "up":          devices_up,
            "down":        devices_down,
            "unreachable": devices_unreachable,
            "unknown":     devices_unknown,
        },
        "alerts": {
            "open":     alerts_open,
            "critical": alerts_critical,
            "major":    alerts_major,
            "by_severity": alert_counts,
        },
        "last_polled_at":  last_polled_at.isoformat() if last_polled_at else None,
        "problem_devices": problem_devices,
        "recent_alerts":   recent_alerts,
        "generated_at":    datetime.now(timezone.utc).isoformat(),
    }
