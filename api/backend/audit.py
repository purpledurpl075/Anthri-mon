"""Audit log helper — one-call structured insert from anywhere in the app.

Usage:
    from ..audit import audit
    await audit(db, action="update", resource_type="credential",
                resource_id=cred.id, old_value=before, new_value=after,
                user=current_user, request=request)

Failures are swallowed (logged but never raised) so a broken audit insert
cannot break the originating action.  Inserts are flushed but NOT committed —
the caller's transaction commits them.
"""
from __future__ import annotations

import uuid
from typing import Any, Optional

import structlog
from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from .models.alert import AuditLog
from .models.tenant import User

logger = structlog.get_logger(__name__)


def _client_ip(request: Optional[Request]) -> Optional[str]:
    if not request:
        return None
    # Honour X-Forwarded-For if present (we're behind nginx).
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


def _user_agent(request: Optional[Request]) -> Optional[str]:
    if not request:
        return None
    return request.headers.get("user-agent")


async def audit(
    db: AsyncSession,
    *,
    action: str,
    resource_type: Optional[str] = None,
    resource_id: Optional[uuid.UUID] = None,
    old_value: Optional[dict[str, Any]] = None,
    new_value: Optional[dict[str, Any]] = None,
    user: Optional[User] = None,
    tenant_id: Optional[uuid.UUID] = None,
    site_id: Optional[uuid.UUID] = None,
    request: Optional[Request] = None,
) -> None:
    """Insert a single audit_log row.  Never raises.

    `action` must be one of: create, update, delete, login, logout,
    login_failed, ack_alert, resolve_alert, config_push, config_backup,
    discovery_run.
    """
    entry = AuditLog(
        tenant_id     = tenant_id or (user.tenant_id if user else None),
        user_id       = user.id if user else None,
        action        = action,
        resource_type = resource_type,
        resource_id   = resource_id,
        old_value     = old_value,
        new_value     = new_value,
        ip_address    = _client_ip(request),
        user_agent    = _user_agent(request),
        site_id       = site_id,
    )
    # Wrap the insert in a SAVEPOINT so a failure rolls back only the audit
    # row, not the caller's surrounding transaction.  Without this, a flush
    # error here would poison the session and the caller's commit() would
    # raise PendingRollbackError (which is how this design was originally
    # discovered to be wrong).
    sp = await db.begin_nested()
    try:
        db.add(entry)
        await db.flush()
        await sp.commit()
    except Exception as exc:
        await sp.rollback()
        logger.error("audit_write_failed", action=action,
                     resource_type=resource_type, error=str(exc))
