from __future__ import annotations

import asyncio
import time as _time
from datetime import datetime, timezone

import httpx
import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy import cast, func, select, text, String
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.alert import Alert
from ..models.device import Device
from ..models.interface import Interface
from ..models.tenant import User

_VM_URL = "http://localhost:8428"

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

    # ── Device counts by type ────────────────────────────────────────────────
    type_rows = await db.execute(
        select(Device.device_type, func.count().label("n"))
        .where(Device.tenant_id == tid, Device.is_active == True)  # noqa: E712
        .group_by(Device.device_type)
    )
    devices_by_type: dict[str, int] = {
        (row.device_type or "unknown"): row.n for row in type_rows
    }

    # ── Poll health ───────────────────────────────────────────────────────────
    polled_recently_result = await db.execute(
        select(func.count()).where(
            Device.tenant_id == tid,
            Device.is_active == True,  # noqa: E712
            text("devices.last_polled > NOW() - INTERVAL '2 minutes'"),
        )
    )
    polled_recently = polled_recently_result.scalar_one() or 0

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

    # ── Interfaces down (oper down, admin up) ────────────────────────────────
    ifaces_down_result = await db.execute(
        select(func.count())
        .select_from(Interface)
        .join(Device, Interface.device_id == Device.id)
        .where(
            Device.tenant_id == tid,
            Device.is_active == True,  # noqa: E712
            text("interfaces.oper_status = 'down'::if_status"),
            text("interfaces.admin_status = 'up'::if_status"),
        )
    )
    interfaces_down = ifaces_down_result.scalar_one() or 0

    # ── Last poll time ────────────────────────────────────────────────────────
    last_poll_result = await db.execute(
        select(func.max(Device.last_polled)).where(Device.tenant_id == tid)
    )
    last_polled_at: datetime | None = last_poll_result.scalar_one_or_none()

    # ── Problem devices (down / unreachable / stale, up to 8) ────────────────
    problem_result = await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.mgmt_ip,
               Device.vendor, Device.device_type, Device.status, Device.last_seen)
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
            "id":          str(row.id),
            "hostname":    row.fqdn or row.hostname,
            "mgmt_ip":     str(row.mgmt_ip),
            "vendor":      row.vendor,
            "device_type": row.device_type,
            "status":      row.status,
            "last_seen":   row.last_seen.isoformat() if row.last_seen else None,
        }
        for row in problem_result
    ]

    # ── Recent open alerts (by severity, then time; up to 8) ─────────────────
    recent_alerts_result = await db.execute(
        select(Alert.id, Alert.title, Alert.severity, Alert.triggered_at, Alert.device_id)
        .where(Alert.tenant_id == tid, text("alerts.status = 'open'::alert_status"))
        .order_by(
            text("CASE severity WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'minor' THEN 3 WHEN 'warning' THEN 4 ELSE 5 END"),
            Alert.triggered_at.desc(),
        )
        .limit(8)
    )
    recent_alerts = [
        {
            "id":           str(row.id),
            "title":        row.title,
            "severity":     row.severity,
            "triggered_at": row.triggered_at.isoformat() if row.triggered_at else None,
            "device_id":    str(row.device_id) if row.device_id else None,
        }
        for row in recent_alerts_result
    ]

    # ── Alert trend (hourly triggered counts, last 24 h) ─────────────────────
    trend_rows = await db.execute(
        select(
            func.date_trunc("hour", Alert.triggered_at).label("hour"),
            func.count(Alert.id).label("n"),
        )
        .where(
            Alert.tenant_id == tid,
            text("alerts.triggered_at > NOW() - INTERVAL '24 hours'"),
        )
        .group_by(text("1"))
        .order_by(text("1"))
    )
    alert_trend: list[list] = [
        [int(row.hour.timestamp() * 1000), row.n] for row in trend_rows
    ]

    # ── Recently resolved alerts (last hour, up to 8) ────────────────────────
    resolved_result = await db.execute(
        select(Alert.id, Alert.title, Alert.severity, Alert.resolved_at, Alert.device_id)
        .where(
            Alert.tenant_id == tid,
            text("alerts.status = 'resolved'::alert_status"),
            text("alerts.resolved_at > NOW() - INTERVAL '1 hour'"),
        )
        .order_by(Alert.resolved_at.desc())
        .limit(8)
    )
    recently_resolved = [
        {
            "id":          str(row.id),
            "title":       row.title,
            "severity":    row.severity,
            "resolved_at": row.resolved_at.isoformat() if row.resolved_at else None,
            "device_id":   str(row.device_id) if row.device_id else None,
        }
        for row in resolved_result
    ]

    # ── Top alerting devices (up to 5) ───────────────────────────────────────
    top_alerting_result = await db.execute(
        select(
            cast(Alert.device_id, String).label("device_id"),
            Device.hostname,
            Device.fqdn,
            Device.device_type,
            func.count(Alert.id).label("alert_count"),
        )
        .join(Device, Alert.device_id == Device.id)
        .where(Alert.tenant_id == tid, text("alerts.status = 'open'::alert_status"),
               Alert.device_id.is_not(None))
        .group_by(Alert.device_id, Device.hostname, Device.fqdn, Device.device_type)
        .order_by(func.count(Alert.id).desc())
        .limit(5)
    )
    top_alerting_devices = [
        {
            "device_id":   row.device_id,
            "hostname":    row.fqdn or row.hostname,
            "device_type": row.device_type,
            "count":       row.alert_count,
        }
        for row in top_alerting_result
    ]

    return {
        "devices": {
            "total":       devices_total,
            "up":          devices_up,
            "down":        devices_down,
            "unreachable": devices_unreachable,
            "unknown":     devices_unknown,
            "by_type":     devices_by_type,
        },
        "alerts": {
            "open":        alerts_open,
            "critical":    alerts_critical,
            "major":       alerts_major,
            "by_severity": alert_counts,
        },
        "interfaces_down":      interfaces_down,
        "poll_health": {
            "polled_recently": polled_recently,
            "total_active":    devices_total,
        },
        "last_polled_at":       last_polled_at.isoformat() if last_polled_at else None,
        "problem_devices":      problem_devices,
        "recent_alerts":        recent_alerts,
        "top_alerting_devices": top_alerting_devices,
        "alert_trend":          alert_trend,
        "recently_resolved":    recently_resolved,
        "generated_at":         datetime.now(timezone.utc).isoformat(),
    }


@router.get("/overview/top-bandwidth", summary="Top interfaces and devices by current bandwidth")
async def top_bandwidth(
    limit: int = Query(default=8, ge=1, le=20),
    window_minutes: int = Query(default=30, ge=1, le=360),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tid = current_user.tenant_id

    # Load all interfaces for this tenant's active devices
    iface_rows = (await db.execute(
        select(Interface.id, Interface.device_id, Interface.if_index,
               Interface.name, Interface.speed_bps)
        .join(Device, Interface.device_id == Device.id)
        .where(Device.tenant_id == tid, Device.is_active == True)  # noqa: E712
    )).all()

    if not iface_rows:
        return {"top_interfaces": [], "top_devices": []}

    dev_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.device_type)
        .where(Device.tenant_id == tid, Device.is_active == True)  # noqa: E712
    )).all()
    device_info = {
        str(r.id): {"hostname": r.fqdn or r.hostname, "device_type": r.device_type or "unknown"}
        for r in dev_rows
    }

    device_ids_re = "|".join({str(r.device_id) for r in iface_rows})
    key_to_iface  = {(str(r.device_id), str(r.if_index)): r for r in iface_rows}

    now = int(_time.time())
    if window_minutes <= 5:
        step, topk_win = 15, "2m"
    elif window_minutes <= 30:
        step, topk_win = 60, "5m"
    else:
        step, topk_win = 300, "10m"
    start = now - window_minutes * 60

    # ── Step 1: instant topk to find the busiest interfaces ──────────────────
    topk_q = (
        f'topk({limit * 2},'
        f' rate(anthrimon_if_in_octets_total{{device_id=~"{device_ids_re}"}}[{topk_win}]) * 8'
        f' + rate(anthrimon_if_out_octets_total{{device_id=~"{device_ids_re}"}}[{topk_win}]) * 8)'
    )
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            topk_resp = await client.get(f"{_VM_URL}/api/v1/query", params={"query": topk_q})
        topk_results = topk_resp.json().get("data", {}).get("result", [])
    except Exception:
        logger.exception("top_bandwidth_topk_failed")
        return {"top_interfaces": [], "top_devices": []}

    candidates: list[tuple[str, str, float, object]] = []
    for series in topk_results:
        did = series["metric"].get("device_id", "")
        idx = series["metric"].get("if_index", "")
        val = float(series["value"][1]) if series.get("value") else 0.0
        iface = key_to_iface.get((did, idx))
        if iface:
            candidates.append((did, idx, val, iface))

    candidates.sort(key=lambda x: x[2], reverse=True)
    candidates = candidates[:limit]

    if not candidates:
        return {"top_interfaces": [], "top_devices": []}

    # ── Step 2: fetch range for each top interface (in + out) ────────────────
    async def fetch_range(did: str, idx: str, metric: str) -> list:
        q = f'rate({metric}{{device_id="{did}",if_index="{idx}"}}[{topk_win}]) * 8'
        try:
            async with httpx.AsyncClient(timeout=8) as c:
                resp = await c.get(
                    f"{_VM_URL}/api/v1/query_range",
                    params={"query": q, "start": start, "end": now, "step": step},
                )
            results = resp.json().get("data", {}).get("result", [])
            return [[int(v[0]), float(v[1])]
                    for v in (results[0].get("values", []) if results else [])]
        except Exception:
            return []

    all_series = await asyncio.gather(*[
        coro
        for did, idx, _, _ in candidates
        for coro in (
            fetch_range(did, idx, "anthrimon_if_in_octets_total"),
            fetch_range(did, idx, "anthrimon_if_out_octets_total"),
        )
    ])

    # ── Build response ────────────────────────────────────────────────────────
    top_interfaces = []
    device_totals: dict[str, dict] = {}

    for i, (did, idx, _, iface) in enumerate(candidates):
        in_series  = all_series[i * 2]
        out_series = all_series[i * 2 + 1]
        cur_in  = in_series[-1][1]  if in_series  else 0.0
        cur_out = out_series[-1][1] if out_series else 0.0
        speed   = iface.speed_bps
        util    = round((cur_in + cur_out) / speed * 100, 1) if speed else None

        dev = device_info.get(did, {"hostname": did[:8], "device_type": "unknown"})
        top_interfaces.append({
            "device_id":       did,
            "device_name":     dev["hostname"],
            "device_type":     dev["device_type"],
            "iface_id":        str(iface.id),
            "iface_name":      iface.name,
            "speed_bps":       speed,
            "current_in_bps":  cur_in,
            "current_out_bps": cur_out,
            "util_pct":        util,
            "in_series":       in_series,
            "out_series":      out_series,
        })

        if did not in device_totals:
            device_totals[did] = {
                "device_id":   did,
                "device_name": dev["hostname"],
                "device_type": dev["device_type"],
                "total_bps":   0.0,
            }
        device_totals[did]["total_bps"] += cur_in + cur_out

    top_devices = sorted(device_totals.values(), key=lambda x: x["total_bps"], reverse=True)[:5]

    return {"top_interfaces": top_interfaces, "top_devices": top_devices}
