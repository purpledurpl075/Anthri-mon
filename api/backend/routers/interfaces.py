from __future__ import annotations

import asyncio
import time
import uuid

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db, require_role
from ..models.interface import Interface
from ..models.tenant import User
from ..schemas.interface import InterfaceRead, InterfaceUpdate

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/interfaces", tags=["interfaces"])

_VM_URL = "http://localhost:8428"


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


@router.get("/{interface_id}/utilisation", summary="Interface metrics from VictoriaMetrics")
async def get_interface_utilisation(
    interface_id: uuid.UUID,
    hours: float = Query(default=0.5, ge=0.1, le=48.0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    iface = await _get_interface_for_tenant(interface_id, current_user.tenant_id, db)
    device_id = str(iface.device_id)
    if_index = str(iface.if_index)

    now   = int(time.time())
    start = now - int(hours * 3600)

    if hours <= 1:
        step = 60
    elif hours <= 6:
        step = 300
    elif hours <= 24:
        step = 900
    else:
        step = 3600

    def q(metric: str, multiplier: str = "") -> str:
        base = f'rate({metric}{{device_id="{device_id}",if_index="{if_index}"}}[{step}s])'
        return base + multiplier

    queries = {
        "in_bps":       q("anthrimon_if_in_octets_total",  " * 8"),
        "out_bps":      q("anthrimon_if_out_octets_total", " * 8"),
        "in_errors":    q("anthrimon_if_in_errors_total"),
        "out_errors":   q("anthrimon_if_out_errors_total"),
        "in_discards":  q("anthrimon_if_in_discards_total"),
        "out_discards": q("anthrimon_if_out_discards_total"),
    }

    async def fetch_series(client: httpx.AsyncClient, key: str, query: str) -> tuple[str, list]:
        try:
            resp = await client.get(
                f"{_VM_URL}/api/v1/query_range",
                params={"query": query, "start": start, "end": now, "step": step},
            )
            resp.raise_for_status()
            results = resp.json().get("data", {}).get("result", [])
            series = [
                [int(v[0]), float(v[1])]
                for v in (results[0].get("values", []) if results else [])
            ]
            return key, series
        except Exception:
            return key, []

    result: dict[str, list] = {k: [] for k in queries}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            fetched = await asyncio.gather(*[
                fetch_series(client, k, qry) for k, qry in queries.items()
            ])
            result = dict(fetched)
    except Exception:
        pass

    return {
        "if_name":   iface.name,
        "speed_bps": iface.speed_bps,
        **result,
    }


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
