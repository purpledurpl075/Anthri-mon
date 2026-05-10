from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alerting.maintenance import is_window_active
from ..dependencies import get_current_user, get_db, require_role
from ..models.alert import MaintenanceWindow
from ..models.tenant import User
from ..schemas.maintenance import MaintenanceWindowCreate, MaintenanceWindowRead, MaintenanceWindowUpdate

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/maintenance-windows", tags=["maintenance"])


def _to_read(w: MaintenanceWindow) -> MaintenanceWindowRead:
    r = MaintenanceWindowRead.model_validate(w)
    r.is_active = is_window_active(w, datetime.now(timezone.utc))
    return r


@router.get("", response_model=list[MaintenanceWindowRead])
async def list_windows(
    device_id: Optional[uuid.UUID] = Query(default=None),
    active_only: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MaintenanceWindowRead]:
    q = select(MaintenanceWindow).where(MaintenanceWindow.tenant_id == current_user.tenant_id)
    rows = (await db.execute(q.order_by(MaintenanceWindow.starts_at.desc()))).scalars().all()

    results = [_to_read(w) for w in rows]

    if device_id:
        did = str(device_id)
        results = [
            r for r in results
            if _selector_matches_device(r.device_selector, did)
        ]

    if active_only:
        results = [r for r in results if r.is_active]

    return results


@router.post("", response_model=MaintenanceWindowRead, status_code=status.HTTP_201_CREATED)
async def create_window(
    body: MaintenanceWindowCreate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> MaintenanceWindowRead:
    w = MaintenanceWindow(
        tenant_id=current_user.tenant_id,
        created_by=current_user.id,
        **body.model_dump(),
    )
    db.add(w)
    await db.commit()
    await db.refresh(w)
    logger.info("maintenance_window_created", id=str(w.id), name=w.name)
    return _to_read(w)


@router.get("/{window_id}", response_model=MaintenanceWindowRead)
async def get_window(
    window_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MaintenanceWindowRead:
    return _to_read(await _get(window_id, current_user.tenant_id, db))


@router.patch("/{window_id}", response_model=MaintenanceWindowRead)
async def update_window(
    window_id: uuid.UUID,
    body: MaintenanceWindowUpdate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> MaintenanceWindowRead:
    w = await _get(window_id, current_user.tenant_id, db)
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(w, field, value)
    await db.commit()
    await db.refresh(w)
    return _to_read(w)


@router.delete("/{window_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def delete_window(
    window_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> None:
    w = await _get(window_id, current_user.tenant_id, db)
    await db.delete(w)
    await db.commit()
    logger.info("maintenance_window_deleted", id=str(window_id))


async def _get(window_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> MaintenanceWindow:
    w = (await db.execute(
        select(MaintenanceWindow).where(
            MaintenanceWindow.id == window_id,
            MaintenanceWindow.tenant_id == tenant_id,
        )
    )).scalar_one_or_none()
    if w is None:
        raise HTTPException(status_code=404, detail="Maintenance window not found")
    return w


def _selector_matches_device(selector: Optional[dict], device_id: str) -> bool:
    if selector is None:
        return True  # no selector = all devices
    if "device_ids" in selector:
        return device_id in (selector["device_ids"] or [])
    return True  # tag/vendor selectors shown globally, filtered by engine
