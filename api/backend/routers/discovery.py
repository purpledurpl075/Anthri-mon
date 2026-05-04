from __future__ import annotations

import asyncio
import ipaddress
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db, require_role
from ..models.tenant import User
from ..schemas.discovery import DiscoveredDevice, SweepJob, SweepRequest

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["discovery"])

# ── In-memory job store (Phase 1 — no Redis needed) ───────────────────────────
_jobs: dict[uuid.UUID, SweepJob] = {}
_jobs_lock = asyncio.Lock()

# ── Vendor detection (mirrors the Go collector's OID prefix table) ─────────────
_VENDOR_PREFIXES: list[tuple[str, str]] = [
    ("1.3.6.1.4.1.2636.",   "juniper"),
    ("1.3.6.1.4.1.30065.",  "arista"),
    ("1.3.6.1.4.1.12356.",  "fortios"),
    ("1.3.6.1.4.1.47196.",  "aruba_cx"),
    # HP ProCurve OIDs — not a supported vendor; falls through to 'unknown'
    ("1.3.6.1.4.1.9.12.",   "cisco_nxos"),
    ("1.3.6.1.4.1.9.6.",    "cisco_iosxe"),
    ("1.3.6.1.4.1.9.1.",    "cisco_ios"),
    ("1.3.6.1.4.1.9.",      "cisco_ios"),
]

_SYSDESCR_OVERRIDES: list[tuple[str, str, str]] = [
    # (vendor_from_oid, pattern, corrected_vendor)
    ("cisco_ios",  r"NX-OS",      "cisco_nxos"),
    ("cisco_ios",  r"IOS-XR",     "cisco_iosxr"),
]


def _detect_vendor(sys_object_id: str, sys_descr: str) -> str:
    vendor = "unknown"
    for prefix, v in _VENDOR_PREFIXES:
        if sys_object_id.startswith(prefix):
            vendor = v
            break
    for oid_vendor, pattern, corrected in _SYSDESCR_OVERRIDES:
        if vendor == oid_vendor and re.search(pattern, sys_descr, re.IGNORECASE):
            vendor = corrected
            break
    return vendor


# ── SNMP probe (single IP) ─────────────────────────────────────────────────────

_SYS_DESCR      = "1.3.6.1.2.1.1.1.0"
_SYS_OBJECT_ID  = "1.3.6.1.2.1.1.2.0"
_SYS_NAME       = "1.3.6.1.2.1.1.5.0"


async def _probe_v2c(ip: str, community: str, port: int, timeout: int) -> Optional[DiscoveredDevice]:
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData, ContextData, ObjectIdentity, ObjectType,
        SnmpEngine, UdpTransportTarget, get_cmd,
    )
    engine = SnmpEngine()
    try:
        transport = await UdpTransportTarget.create(
            (ip, port), timeout=timeout, retries=0
        )
        iterator = get_cmd(
            engine,
            CommunityData(community, mpModel=1),
            transport,
            ContextData(),
            ObjectType(ObjectIdentity(_SYS_DESCR)),
            ObjectType(ObjectIdentity(_SYS_OBJECT_ID)),
            ObjectType(ObjectIdentity(_SYS_NAME)),
        )
        err_indication, err_status, _, var_binds = await iterator
        if err_indication or err_status:
            return None
        values = {str(vb[0]): str(vb[1]) for vb in var_binds}
        sys_descr = values.get(_SYS_DESCR, "")
        sys_oid   = values.get(_SYS_OBJECT_ID, "")
        sys_name  = values.get(_SYS_NAME, ip)
        return DiscoveredDevice(
            ip=ip,
            hostname=sys_name,
            vendor=_detect_vendor(sys_oid, sys_descr),
            sys_descr=sys_descr,
            sys_object_id=sys_oid,
            already_in_db=False,
        )
    except Exception:
        return None


_AUTH_PROTO_MAP = {
    "md5":    "usmHMACMD5AuthProtocol",
    "sha":    "usmHMACSHAAuthProtocol",
    "sha256": "usmHMAC192SHA256AuthProtocol",
    "sha512": "usmHMAC384SHA512AuthProtocol",
}
_PRIV_PROTO_MAP = {
    "des":    "usmDESPrivProtocol",
    "aes":    "usmAesCfb128Protocol",
    "aes192": "usmAesCfb192Protocol",
    "aes256": "usmAesCfb256Protocol",
}


async def _probe_v3(ip: str, cred_data: dict, port: int, timeout: int) -> Optional[DiscoveredDevice]:
    from pysnmp.hlapi.v3arch.asyncio import (
        ContextData, ObjectIdentity, ObjectType, SnmpEngine,
        UdpTransportTarget, UsmUserData, get_cmd,
    )
    import pysnmp.hlapi.v3arch.asyncio as hlapi

    auth_proto_name = _AUTH_PROTO_MAP.get(cred_data.get("auth_protocol", "sha").lower(), "usmHMACSHAAuthProtocol")
    priv_proto_name = _PRIV_PROTO_MAP.get(cred_data.get("priv_protocol", "aes").lower(), "usmAesCfb128Protocol")
    auth_proto = getattr(hlapi, auth_proto_name)
    priv_proto = getattr(hlapi, priv_proto_name)

    engine = SnmpEngine()
    try:
        transport = await UdpTransportTarget.create(
            (ip, port), timeout=timeout, retries=0
        )
        iterator = get_cmd(
            engine,
            UsmUserData(
                cred_data["username"],
                authKey=cred_data.get("auth_key", ""),
                privKey=cred_data.get("priv_key", ""),
                authProtocol=auth_proto,
                privProtocol=priv_proto,
            ),
            transport,
            ContextData(),
            ObjectType(ObjectIdentity(_SYS_DESCR)),
            ObjectType(ObjectIdentity(_SYS_OBJECT_ID)),
            ObjectType(ObjectIdentity(_SYS_NAME)),
        )
        err_indication, err_status, _, var_binds = await iterator
        if err_indication or err_status:
            return None
        values = {str(vb[0]): str(vb[1]) for vb in var_binds}
        sys_descr = values.get(_SYS_DESCR, "")
        sys_oid   = values.get(_SYS_OBJECT_ID, "")
        sys_name  = values.get(_SYS_NAME, ip)
        return DiscoveredDevice(
            ip=ip,
            hostname=sys_name,
            vendor=_detect_vendor(sys_oid, sys_descr),
            sys_descr=sys_descr,
            sys_object_id=sys_oid,
            already_in_db=False,
        )
    except Exception:
        return None


# ── Background sweep task ──────────────────────────────────────────────────────

async def _run_sweep(job_id: uuid.UUID, req: SweepRequest, tenant_id: uuid.UUID, cred_data: dict, cred_type: str) -> None:
    from ..database import AsyncSessionLocal

    network = ipaddress.ip_network(req.cidr, strict=False)
    hosts = list(network.hosts())

    async with _jobs_lock:
        _jobs[job_id].total = len(hosts)
        _jobs[job_id].status = "running"

    # Fetch existing device IPs for this tenant so we can flag duplicates.
    existing_ips: dict[str, uuid.UUID] = {}
    async with AsyncSessionLocal() as db:
        rows = await db.execute(
            text("SELECT id, mgmt_ip::text FROM devices WHERE tenant_id = :tid"),
            {"tid": str(tenant_id)},
        )
        for row in rows:
            existing_ips[row[1]] = row[0]

    sem = asyncio.Semaphore(req.max_concurrent)

    async def probe_one(ip_obj: ipaddress.IPv4Address) -> None:
        ip = str(ip_obj)
        async with sem:
            if cred_type == "snmp_v2c":
                result = await _probe_v2c(ip, cred_data.get("community", "public"), req.port, req.timeout_s)
            else:
                result = await _probe_v3(ip, cred_data, req.port, req.timeout_s)

        async with _jobs_lock:
            _jobs[job_id].scanned += 1
            if result:
                if ip in existing_ips:
                    result.already_in_db = True
                    result.device_id = existing_ips[ip]
                _jobs[job_id].found.append(result)

    await asyncio.gather(*[probe_one(h) for h in hosts])

    async with _jobs_lock:
        _jobs[job_id].status = "done"
        _jobs[job_id].finished_at = datetime.now(timezone.utc)

    logger.info("sweep_complete", job_id=str(job_id), cidr=req.cidr,
                found=len(_jobs[job_id].found), scanned=len(hosts))


# ── Endpoints ──────────────────────────────────────────────────────────────────


@router.post("/discovery/sweep", response_model=SweepJob, status_code=status.HTTP_202_ACCEPTED,
             summary="Start a background SNMP sweep of a CIDR range")
async def start_sweep(
    req: SweepRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> SweepJob:
    # Validate CIDR.
    try:
        network = ipaddress.ip_network(req.cidr, strict=False)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid CIDR notation")

    if network.num_addresses > 1024:
        raise HTTPException(status_code=400, detail="CIDR too large — max /22 (1022 hosts) per sweep")

    # Load credential.
    from ..models.credential import Credential
    result = await db.execute(
        select(Credential).where(
            Credential.id == req.credential_id,
            Credential.tenant_id == current_user.tenant_id,
        )
    )
    cred = result.scalar_one_or_none()
    if cred is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    if cred.type not in ("snmp_v2c", "snmp_v3"):
        raise HTTPException(status_code=400, detail="Credential must be snmp_v2c or snmp_v3")

    job_id = uuid.uuid4()
    job = SweepJob(
        job_id=job_id,
        status="pending",
        cidr=req.cidr,
        total=0,
        scanned=0,
        started_at=datetime.now(timezone.utc),
    )
    async with _jobs_lock:
        _jobs[job_id] = job

    background_tasks.add_task(
        _run_sweep, job_id, req, current_user.tenant_id, cred.data, cred.type
    )

    logger.info("sweep_started", job_id=str(job_id), cidr=req.cidr, user=str(current_user.id))
    return job


@router.get("/discovery/sweep/{job_id}", response_model=SweepJob, summary="Poll sweep job status")
async def get_sweep(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
) -> SweepJob:
    async with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Sweep job not found")
    return job
