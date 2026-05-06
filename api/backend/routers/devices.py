from __future__ import annotations

import uuid
from typing import List, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..dependencies import get_current_user, get_db, require_role
from ..models.alert import Alert
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device
from ..models.health import DeviceHealthLatest
from ..models.interface import Interface
from ..models.tenant import User
from ..schemas.alert import AlertRead
from ..schemas.common import PaginatedResponse
from ..schemas.device import DeviceCreate, DeviceListRead, DeviceRead, DeviceUpdate
from ..schemas.interface import InterfaceRead

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/devices", tags=["devices"])

_VENDOR_DEVICE_TYPE: dict[str, str] = {
    "arista":       "switch",
    "aruba_cx":     "switch",
    "procurve":     "switch",
    "cisco_nxos":   "switch",
    "cisco_ios":    "router",
    "cisco_iosxe":  "router",
    "cisco_iosxr":  "router",
    "juniper":      "router",
    "fortios":      "firewall",
}


# ── List ───────────────────────────────────────────────────────────────────────

@router.get("", response_model=PaginatedResponse[DeviceListRead], summary="List devices")
async def list_devices(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    vendor: Optional[str] = Query(default=None),
    site_id: Optional[uuid.UUID] = Query(default=None),
    is_active: bool = Query(default=True),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[DeviceListRead]:
    q = select(Device).where(Device.tenant_id == current_user.tenant_id)

    if is_active is not None:
        q = q.where(Device.is_active == is_active)
    if status_filter:
        q = q.where(Device.status == status_filter)
    if vendor:
        q = q.where(Device.vendor == vendor)
    if site_id:
        q = q.where(Device.site_id == site_id)

    total_result = await db.execute(select(func.count()).select_from(q.subquery()))
    total = total_result.scalar_one()

    result = await db.execute(q.order_by(Device.hostname).limit(limit).offset(offset))
    devices = result.scalars().all()

    return PaginatedResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=[DeviceListRead.model_validate(d) for d in devices],
    )


# ── Create ─────────────────────────────────────────────────────────────────────

@router.post("", response_model=DeviceRead, status_code=status.HTTP_201_CREATED, summary="Add a device")
async def create_device(
    body: DeviceCreate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> DeviceRead:
    fields = body.model_dump(exclude_none=True, exclude={"mgmt_ip"})
    if "device_type" not in fields and "vendor" in fields:
        fields.setdefault("device_type", _VENDOR_DEVICE_TYPE.get(fields["vendor"], "unknown"))
    device = Device(
        tenant_id=current_user.tenant_id,
        **fields,
        mgmt_ip=str(body.mgmt_ip),
    )
    db.add(device)
    await db.commit()
    await db.refresh(device)
    logger.info("device_created", device_id=str(device.id), hostname=device.hostname)
    return DeviceRead.model_validate(device)


# ── Get one ────────────────────────────────────────────────────────────────────

@router.get("/{device_id}", response_model=DeviceRead, summary="Get device details")
async def get_device(
    device_id: uuid.UUID,
    include_health: bool = Query(default=False, alias="include_health"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeviceRead:
    q = select(Device).where(Device.id == device_id, Device.tenant_id == current_user.tenant_id)

    if include_health:
        q = q.options(selectinload(Device.health), selectinload(Device.site))

    result = await db.execute(q)
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    return DeviceRead.model_validate(device)


# ── Update ─────────────────────────────────────────────────────────────────────

@router.patch("/{device_id}", response_model=DeviceRead, summary="Update device fields")
async def update_device(
    device_id: uuid.UUID,
    body: DeviceUpdate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> DeviceRead:
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == current_user.tenant_id)
    )
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    updates = body.model_dump(exclude_none=True)
    if "mgmt_ip" in updates:
        updates["mgmt_ip"] = str(updates["mgmt_ip"])

    for field, value in updates.items():
        setattr(device, field, value)

    await db.commit()
    await db.refresh(device)
    logger.info("device_updated", device_id=str(device_id), fields=list(updates.keys()))
    return DeviceRead.model_validate(device)


# ── Delete ─────────────────────────────────────────────────────────────────────

@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, summary="Remove a device")
async def delete_device(
    device_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == current_user.tenant_id)
    )
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    await db.delete(device)
    await db.commit()
    logger.info("device_deleted", device_id=str(device_id))


# ── Sub-resources ──────────────────────────────────────────────────────────────

@router.get("/{device_id}/interfaces", response_model=List[InterfaceRead], summary="List interfaces for a device")
async def list_device_interfaces(
    device_id: uuid.UUID,
    oper_status: Optional[str] = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[InterfaceRead]:
    await _assert_device_visible(device_id, current_user, db)

    q = select(Interface).where(Interface.device_id == device_id)
    if oper_status:
        q = q.where(Interface.oper_status == oper_status)

    result = await db.execute(q.order_by(Interface.if_index))
    return [InterfaceRead.model_validate(i) for i in result.scalars().all()]


@router.get("/{device_id}/health", summary="Latest health metrics for a device")
async def get_device_health(
    device_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _assert_device_visible(device_id, current_user, db)

    result = await db.execute(
        select(DeviceHealthLatest).where(DeviceHealthLatest.device_id == device_id)
    )
    health = result.scalar_one_or_none()
    if health is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No health data yet for this device")

    return {
        "device_id": str(health.device_id),
        "collected_at": health.collected_at,
        "cpu_util_pct": health.cpu_util_pct,
        "mem_used_bytes": health.mem_used_bytes,
        "mem_total_bytes": health.mem_total_bytes,
        "mem_util_pct": round(health.mem_used_bytes / health.mem_total_bytes * 100, 2)
            if health.mem_used_bytes and health.mem_total_bytes else None,
        "temperatures": health.temperatures,
        "uptime_seconds": health.uptime_seconds,
    }


@router.get("/{device_id}/alerts", response_model=List[AlertRead], summary="Active alerts for a device")
async def get_device_alerts(
    device_id: uuid.UUID,
    alert_status: Optional[str] = Query(default="open", alias="status"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[AlertRead]:
    await _assert_device_visible(device_id, current_user, db)

    q = select(Alert).where(Alert.device_id == device_id, Alert.tenant_id == current_user.tenant_id)
    if alert_status:
        q = q.where(Alert.status == alert_status)

    result = await db.execute(q.order_by(Alert.triggered_at.desc()))
    return [AlertRead.model_validate(a) for a in result.scalars().all()]


# ── Alert exclusions ───────────────────────────────────────────────────────────

class _AlertExclusionsBody(BaseModel):
    metrics: list[str] = []
    interface_ids: list[str] = []


@router.put("/{device_id}/alert-exclusions", summary="Set alert exclusions for a device")
async def set_alert_exclusions(
    device_id: uuid.UUID,
    body: _AlertExclusionsBody,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    device = await _assert_device_visible(device_id, current_user, db)
    device.alert_exclusions = {"metrics": body.metrics, "interface_ids": body.interface_ids}
    await db.commit()
    return device.alert_exclusions


# ── Credential linking ─────────────────────────────────────────────────────────

class _CredentialLinkBody(BaseModel):
    credential_id: uuid.UUID
    priority: int = 0


@router.get("/{device_id}/credentials", summary="List credentials assigned to a device")
async def list_device_credentials(
    device_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await _assert_device_visible(device_id, current_user, db)
    rows = (await db.execute(
        select(DeviceCredential, Credential)
        .join(Credential, Credential.id == DeviceCredential.credential_id)
        .where(DeviceCredential.device_id == device_id)
        .order_by(DeviceCredential.priority)
    )).all()
    return [
        {"credential_id": str(dc.credential_id), "name": c.name,
         "type": c.type, "priority": dc.priority}
        for dc, c in rows
    ]


@router.post("/{device_id}/credentials", status_code=status.HTTP_204_NO_CONTENT,
             response_model=None, summary="Attach a credential to a device")
async def link_device_credential(
    device_id: uuid.UUID,
    body: _CredentialLinkBody,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> None:
    await _assert_device_visible(device_id, current_user, db)

    if (await db.execute(
        select(Credential).where(
            Credential.id == body.credential_id,
            Credential.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Credential not found")

    link = DeviceCredential(
        device_id=device_id,
        credential_id=body.credential_id,
        priority=body.priority,
    )
    db.add(link)
    try:
        await db.commit()
    except Exception:
        await db.rollback()


@router.delete("/{device_id}/credentials/{credential_id}",
               status_code=status.HTTP_204_NO_CONTENT, response_model=None,
               summary="Remove a credential from a device")
async def unlink_device_credential(
    device_id: uuid.UUID,
    credential_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> None:
    await _assert_device_visible(device_id, current_user, db)
    link = (await db.execute(
        select(DeviceCredential).where(
            DeviceCredential.device_id == device_id,
            DeviceCredential.credential_id == credential_id,
        )
    )).scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail="Credential not assigned to this device")
    await db.delete(link)
    await db.commit()


# ── SNMP diagnostic ────────────────────────────────────────────────────────────

_DIAG_OIDS = {
    "sysDescr":    "1.3.6.1.2.1.1.1.0",
    "sysUpTime":   "1.3.6.1.2.1.1.3.0",
    "sysName":     "1.3.6.1.2.1.1.5.0",
    "sysLocation": "1.3.6.1.2.1.1.6.0",
    "sysContact":  "1.3.6.1.2.1.1.4.0",
}


@router.post("/{device_id}/snmp-diag", summary="Run a live SNMP diagnostic against a device")
async def snmp_diag(
    device_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    import asyncio, time, json as _json

    device = await _assert_device_visible(device_id, current_user, db)

    cred_row = (await db.execute(
        select(DeviceCredential, Credential)
        .join(Credential, Credential.id == DeviceCredential.credential_id)
        .where(
            DeviceCredential.device_id == device_id,
            Credential.type.in_(["snmp_v2c", "snmp_v3"]),
        )
        .order_by(DeviceCredential.priority)
    )).first()

    if cred_row is None:
        raise HTTPException(status_code=400, detail="No SNMP credential assigned to this device")

    dc, cred = cred_row
    cred_data = cred.data if isinstance(cred.data, dict) else _json.loads(cred.data)
    host = str(device.mgmt_ip).split("/")[0]

    try:
        from pysnmp.hlapi.v3arch.asyncio import (
            CommunityData, ContextData, ObjectIdentity, ObjectType,
            SnmpEngine, UdpTransportTarget, UsmUserData, get_cmd,
        )
        import pysnmp.hlapi.v3arch.asyncio as hlapi

        engine = SnmpEngine()
        transport = await UdpTransportTarget.create((host, device.snmp_port or 161), timeout=5, retries=1)
        obj_types = [ObjectType(ObjectIdentity(oid)) for oid in _DIAG_OIDS.values()]

        if cred.type == "snmp_v2c":
            auth = CommunityData(cred_data.get("community", "public"), mpModel=1)
        else:
            _AUTH = {"md5": "usmHMACMD5AuthProtocol", "sha": "usmHMACSHAAuthProtocol",
                     "sha256": "usmHMAC192SHA256AuthProtocol", "sha512": "usmHMAC384SHA512AuthProtocol"}
            _PRIV = {"des": "usmDESPrivProtocol", "aes": "usmAesCfb128Protocol",
                     "aes192": "usmAesCfb192Protocol", "aes256": "usmAesCfb256Protocol"}
            auth = UsmUserData(
                cred_data["username"],
                authKey=cred_data.get("auth_key", ""),
                privKey=cred_data.get("priv_key", ""),
                authProtocol=getattr(hlapi, _AUTH.get(cred_data.get("auth_protocol", "sha256").lower(), "usmHMAC192SHA256AuthProtocol")),
                privProtocol=getattr(hlapi, _PRIV.get(cred_data.get("priv_protocol", "aes").lower(), "usmAesCfb128Protocol")),
            )

        t0 = time.monotonic()
        err_ind, err_status, _, vbs = await get_cmd(engine, auth, transport, ContextData(), *obj_types)
        elapsed_ms = round((time.monotonic() - t0) * 1000)

        if err_ind:
            return {"success": False, "credential_name": cred.name, "credential_type": cred.type,
                    "error": str(err_ind), "results": [], "response_ms": elapsed_ms}
        if err_status:
            return {"success": False, "credential_name": cred.name, "credential_type": cred.type,
                    "error": f"{err_status.prettyPrint()} at index {int(err_status) - 1}",
                    "results": [], "response_ms": elapsed_ms}

        results = []
        label_by_oid = {v: k for k, v in _DIAG_OIDS.items()}
        for vb in vbs:
            oid_str = str(vb[0])
            # Strip instance suffix for label lookup
            base = ".".join(oid_str.split(".")[:11])
            label = label_by_oid.get(oid_str) or label_by_oid.get(base) or oid_str
            results.append({"oid": label, "value": str(vb[1])})

        return {"success": True, "credential_name": cred.name, "credential_type": cred.type,
                "response_ms": elapsed_ms, "results": results, "error": None}

    except Exception as exc:
        return {"success": False, "credential_name": cred.name, "credential_type": cred.type,
                "error": str(exc), "results": [], "response_ms": None}


# ── Internal helper ────────────────────────────────────────────────────────────

async def _assert_device_visible(device_id: uuid.UUID, user: User, db: AsyncSession) -> Device:
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == user.tenant_id)
    )
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    return device
