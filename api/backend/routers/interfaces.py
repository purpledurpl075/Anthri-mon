from __future__ import annotations

import uuid

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db, require_role
from ..models.interface import Interface
from ..models.tenant import User
from ..schemas.interface import InterfaceRead, InterfaceUpdate

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/interfaces", tags=["interfaces"])


@router.get("/{interface_id}", response_model=InterfaceRead, summary="Get a single interface")
async def get_interface(
    interface_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InterfaceRead:
    iface = await _get_interface_for_tenant(interface_id, current_user.tenant_id, db)
    return InterfaceRead.model_validate(iface)


@router.patch("/{interface_id}", response_model=InterfaceRead, summary="Update operator-editable interface fields")
async def update_interface(
    interface_id: uuid.UUID,
    body: InterfaceUpdate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> InterfaceRead:
    iface = await _get_interface_for_tenant(interface_id, current_user.tenant_id, db)

    for field, value in body.model_dump(exclude_none=True).items():
        setattr(iface, field, value)

    await db.commit()
    await db.refresh(iface)
    logger.info("interface_updated", interface_id=str(interface_id))
    return InterfaceRead.model_validate(iface)


async def _get_interface_for_tenant(
    interface_id: uuid.UUID,
    tenant_id: uuid.UUID,
    db: AsyncSession,
) -> Interface:
    """Fetch an interface, enforcing tenant isolation via the device relationship."""
    from ..models.device import Device
    result = await db.execute(
        select(Interface)
        .join(Device, Interface.device_id == Device.id)
        .where(Interface.id == interface_id, Device.tenant_id == tenant_id)
    )
    iface = result.scalar_one_or_none()
    if iface is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interface not found")
    return iface
