"""Audit log browse + CSV export endpoints."""
from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import Text, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, require_role
from ..models.alert import AuditLog
from ..models.tenant import User
from ..schemas.audit import AuditLogRead
from ..schemas.common import PaginatedResponse

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/audit", tags=["audit"])


def _naive_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """audit_log.created_at is TIMESTAMP WITHOUT TIME ZONE (it stores naive UTC
    via Postgres NOW()).  asyncpg refuses to compare it against a tz-aware
    Python datetime, so we strip the tzinfo here, converting to UTC first if
    the inbound value carries a different offset."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _build_filters(q, *, tenant_id, action, resource_type, user_id,
                   since, until, search):
    q = q.where(AuditLog.tenant_id == tenant_id)
    if action:
        q = q.where(AuditLog.action == action)
    if resource_type:
        q = q.where(AuditLog.resource_type == resource_type)
    if user_id:
        q = q.where(AuditLog.user_id == user_id)
    if since:
        q = q.where(AuditLog.created_at >= _naive_utc(since))
    if until:
        q = q.where(AuditLog.created_at < _naive_utc(until))
    if search:
        pat = f"%{search}%"
        q = q.where(
            (AuditLog.action.ilike(pat))
            | (AuditLog.resource_type.ilike(pat))
            | (AuditLog.ip_address.cast(Text).ilike(pat))
        )
    return q


def _diff_changes(old: dict, new: dict, fields: list[str]) -> list[str]:
    """Return human-readable change strings for fields whose values differ."""
    out: list[str] = []
    for f in fields:
        ov = old.get(f) if old else None
        nv = new.get(f) if new else None
        if ov == nv:
            continue
        if ov is None:
            out.append(f"{f}: set to {nv!r}")
        elif nv is None:
            out.append(f"{f}: cleared (was {ov!r})")
        else:
            out.append(f"{f}: {ov} → {nv}")
    return out


def _summarize(r: AuditLog, resource_name: Optional[str]) -> tuple[str, list[str]]:
    """Build a one-line human-readable summary + a list of specific change strings."""
    rt   = r.resource_type or ""
    name = resource_name or ""
    old  = r.old_value if isinstance(r.old_value, dict) else {}
    new  = r.new_value if isinstance(r.new_value, dict) else {}
    label = f"{rt} '{name}'" if rt and name else (rt or name or "")
    changes: list[str] = []

    if r.action == "login":
        return (f"Logged in as '{name}'" if name else "Logged in"), []
    if r.action == "login_failed":
        return (f"Failed login attempt for '{name}'" if name else "Failed login attempt"), []
    if r.action == "logout":
        return (f"Logged out as '{name}'" if name else "Logged out"), []

    if r.action == "create":
        if rt == "credential":
            kind = new.get("type", "")
            return (f"Created credential '{name}'" + (f" ({kind})" if kind else "")), []
        if rt == "user":
            role = new.get("role", "")
            return (f"Created user '{name}'" + (f" (role: {role})" if role else "")), []
        if rt == "alert_rule":
            metric = new.get("metric", "")
            sev    = new.get("severity", "")
            extra  = ", ".join(filter(None, [metric, sev]))
            return (f"Created alert rule '{name}'" + (f" ({extra})" if extra else "")), []
        return (f"Created {label}" if label else "Created record"), []

    if r.action == "update":
        if rt == "credential":
            fields_changed = new.get("fields_changed") or []
            if fields_changed:
                changes = [f"changed: {f}" for f in fields_changed]
            return (f"Updated credential '{name}'"), changes
        if rt == "user":
            if new.get("action") == "password_reset":
                return (f"Reset password for user '{name or new.get('username','')}'"), []
            changes = _diff_changes(old, new, ["role", "is_active", "email", "full_name"])
            return (f"Updated user '{name}'"), changes
        if rt == "alert_rule":
            changes = _diff_changes(old, new, ["name", "metric", "severity", "threshold", "is_enabled"])
            return (f"Updated alert rule '{name}'"), changes
        return (f"Updated {label}" if label else "Updated record"), []

    if r.action == "delete":
        if rt and name:
            return (f"Deleted {rt} '{name}'"), []
        return (f"Deleted {label}" if label else "Deleted record"), []

    if r.action == "ack_alert":
        return (f"Acknowledged alert: {name}" if name else "Acknowledged alert"), []
    if r.action == "resolve_alert":
        return (f"Resolved alert: {name}" if name else "Resolved alert"), []
    if r.action == "config_push":
        return (f"Pushed config to {name}" if name else "Pushed config"), []
    if r.action == "config_backup":
        return (f"Backed up config from {name}" if name else "Backed up config"), []
    if r.action == "discovery_run":
        return ("Ran network discovery"), []

    # Fallback
    return (f"{r.action} {label}".strip()), []


async def _enrich(rows: list[AuditLog], db: AsyncSession) -> list[AuditLogRead]:
    """Add user_name + resource_name + summary + changes display fields."""
    from ..models.tenant import User as _User
    user_ids = {r.user_id for r in rows if r.user_id}
    user_names: dict = {}
    if user_ids:
        users = (await db.execute(
            select(_User.id, _User.username).where(_User.id.in_(user_ids))
        )).all()
        user_names = {u.id: u.username for u in users}

    out = []
    for r in rows:
        read = AuditLogRead.model_validate(r)
        read.user_name = user_names.get(r.user_id, "—") if r.user_id else "system"
        # resource_name is best-effort: most resources have a 'name' in old/new value
        nv = r.new_value or r.old_value or {}
        if isinstance(nv, dict):
            read.resource_name = nv.get("name") or nv.get("username") or nv.get("hostname")
        summary, changes = _summarize(r, read.resource_name)
        read.summary = summary
        read.changes = changes
        out.append(read)
    return out


@router.get("", response_model=PaginatedResponse[AuditLogRead],
            summary="List audit log entries")
async def list_audit(
    action:        Optional[str]        = Query(default=None),
    resource_type: Optional[str]        = Query(default=None),
    user_id:       Optional[uuid.UUID]  = Query(default=None),
    since:         Optional[datetime]   = Query(default=None),
    until:         Optional[datetime]   = Query(default=None),
    search:        Optional[str]        = Query(default=None),
    limit:         int = Query(default=100, ge=1, le=1000),
    offset:        int = Query(default=0,   ge=0),
    current_user:  User = Depends(require_role("admin", "superadmin")),
    db:            AsyncSession = Depends(get_db),
) -> PaginatedResponse[AuditLogRead]:
    base_q = _build_filters(
        select(AuditLog), tenant_id=current_user.tenant_id,
        action=action, resource_type=resource_type, user_id=user_id,
        since=since, until=until, search=search,
    )
    total = (await db.execute(select(func.count()).select_from(base_q.subquery()))).scalar_one()
    rows = (await db.execute(
        base_q.order_by(AuditLog.created_at.desc()).limit(limit).offset(offset)
    )).scalars().all()

    return PaginatedResponse(
        total=total, limit=limit, offset=offset,
        items=await _enrich(list(rows), db),
    )


@router.get("/export.csv", summary="Export filtered audit log as CSV")
async def export_audit_csv(
    action:        Optional[str]       = Query(default=None),
    resource_type: Optional[str]       = Query(default=None),
    user_id:       Optional[uuid.UUID] = Query(default=None),
    since:         Optional[datetime]  = Query(default=None),
    until:         Optional[datetime]  = Query(default=None),
    search:        Optional[str]       = Query(default=None),
    current_user:  User = Depends(require_role("admin", "superadmin")),
    db:            AsyncSession = Depends(get_db),
) -> Response:
    # Cap exports to 30 days unless an explicit since/until window is provided,
    # so a careless click doesn't dump the entire history.
    if since is None and until is None:
        since = datetime.now(timezone.utc) - timedelta(days=30)

    q = _build_filters(
        select(AuditLog), tenant_id=current_user.tenant_id,
        action=action, resource_type=resource_type, user_id=user_id,
        since=since, until=until, search=search,
    ).order_by(AuditLog.created_at.desc()).limit(50_000)

    rows = (await db.execute(q)).scalars().all()
    enriched = await _enrich(list(rows), db)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "timestamp_utc", "user", "action", "resource_type", "resource_id",
        "resource_name", "summary", "changes", "ip_address", "user_agent",
    ])
    for r in enriched:
        w.writerow([
            r.created_at.isoformat() if r.created_at else "",
            r.user_name or "",
            r.action,
            r.resource_type or "",
            str(r.resource_id) if r.resource_id else "",
            r.resource_name or "",
            r.summary or "",
            "; ".join(r.changes),
            r.ip_address or "",
            r.user_agent or "",
        ])

    fname = f"anthrimon-audit-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
