"""Collector health monitor.

Runs as a background task. Every minute it:
  1. Marks collectors online/offline based on last_seen age
  2. Fires an alert when a collector transitions to offline
  3. Auto-resolves the alert when the collector comes back online
"""
from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models.alert import Alert
from ..models.site import RemoteCollector

logger = structlog.get_logger(__name__)

ONLINE_THRESHOLD_S  = 120   # last_seen within 2 min → online
OFFLINE_ALERT_S     = 300   # offline for 5 min → fire alert
CHECK_INTERVAL_S    = 60


def _fp(collector_id: str) -> str:
    return hashlib.sha256(f"collector_offline:{collector_id}".encode()).hexdigest()[:32]


async def _check(db: AsyncSession) -> None:
    now = datetime.now(timezone.utc)

    collectors = (await db.execute(
        select(RemoteCollector).where(RemoteCollector.is_active == True)  # noqa: E712
    )).scalars().all()

    for c in collectors:
        if not c.last_seen:
            continue  # never sent a heartbeat — still pending

        age = (now - c.last_seen.replace(tzinfo=timezone.utc)).total_seconds()
        new_status = "online" if age < ONLINE_THRESHOLD_S else "offline"

        if c.status != new_status:
            c.status = new_status
            logger.info("collector_status_changed", collector=c.name, status=new_status, age_s=int(age))

        fp = _fp(str(c.id))

        if new_status == "offline" and age >= OFFLINE_ALERT_S:
            # Check if an open alert already exists for this collector
            existing = (await db.execute(
                select(Alert).where(
                    Alert.fingerprint == fp,
                    Alert.status.in_(["open", "acknowledged"]),
                )
            )).scalar_one_or_none()

            if existing is None:
                alert = Alert(
                    id=uuid.uuid4(),
                    tenant_id=c.tenant_id,
                    rule_id=None,
                    device_id=None,
                    severity="major",
                    status="open",
                    title=f"Remote collector '{c.name}' is offline (last seen {int(age // 60)}m ago)",
                    message=f"Collector at {c.wg_ip or 'unknown'} has not sent a heartbeat for over {int(age // 60)} minutes.",
                    context={
                        "metric":         "collector_offline",
                        "collector_id":   str(c.id),
                        "collector_name": c.name,
                        "wg_ip":          str(c.wg_ip) if c.wg_ip else None,
                        "last_seen":      c.last_seen.isoformat(),
                        "age_seconds":    int(age),
                    },
                    triggered_at=now,
                    fingerprint=fp,
                    last_notified_at=now,
                )
                db.add(alert)
                logger.warning("collector_offline_alert_fired", collector=c.name, age_s=int(age))

        elif new_status == "online":
            # Auto-resolve any open offline alert
            existing = (await db.execute(
                select(Alert).where(
                    Alert.fingerprint == fp,
                    Alert.status.in_(["open", "acknowledged"]),
                )
            )).scalar_one_or_none()

            if existing:
                existing.status     = "resolved"
                existing.resolved_at = now
                logger.info("collector_offline_alert_resolved", collector=c.name)

    await db.commit()


async def run_collector_monitor() -> None:
    logger.info("collector_monitor_started", interval_s=CHECK_INTERVAL_S)
    while True:
        try:
            await asyncio.sleep(CHECK_INTERVAL_S)
            async with AsyncSessionLocal() as db:
                await _check(db)
        except asyncio.CancelledError:
            logger.info("collector_monitor_stopped")
            return
        except Exception:
            logger.exception("collector_monitor_error")


def start_collector_monitor() -> asyncio.Task:
    return asyncio.create_task(run_collector_monitor(), name="collector-monitor")
