from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional
from dataclasses import dataclass, field

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class Breach:
    """Represents a single metric breach for one device/interface."""
    device_id: str
    device_name: str
    interface_id: Optional[str] = None
    interface_name: Optional[str] = None
    value: Optional[float] = None       # current metric value
    extra: dict = field(default_factory=dict)


# ── Device selector ────────────────────────────────────────────────────────────

async def resolve_devices(db: AsyncSession, tenant_id: str, selector: Optional[dict]) -> list[dict]:
    """Return rows of {id, hostname, vendor, tags, polling_interval_s} matching the selector."""
    base = """
        SELECT id::text, hostname, vendor::text, tags, polling_interval_s,
               host(mgmt_ip) AS mgmt_ip, alert_exclusions
        FROM devices
        WHERE tenant_id = :tid AND is_active = true
    """
    params: dict = {"tid": tenant_id}

    if not selector:
        rows = (await db.execute(text(base), params)).mappings().all()
        return [dict(r) for r in rows]

    clauses, idx = [], 0

    if "device_ids" in selector and selector["device_ids"]:
        ids = selector["device_ids"]
        placeholders = ", ".join(f":did{i}" for i in range(len(ids)))
        clauses.append(f"id::text IN ({placeholders})")
        for i, did in enumerate(ids):
            params[f"did{i}"] = did

    if "vendors" in selector and selector["vendors"]:
        vs = selector["vendors"]
        placeholders = ", ".join(f":v{i}" for i in range(len(vs)))
        clauses.append(f"vendor::text IN ({placeholders})")
        for i, v in enumerate(vs):
            params[f"v{i}"] = v

    if "tags" in selector and selector["tags"]:
        # Use individual ? checks — asyncpg can't infer element type for ?| with a list param.
        tag_conds = []
        for tag in selector["tags"]:
            pname = f"tag_{len(params)}"
            tag_conds.append(f"tags ? :{pname}")
            params[pname] = tag
        clauses.append("(" + " OR ".join(tag_conds) + ")")

    where = " AND (" + " OR ".join(clauses) + ")" if clauses else ""
    rows = (await db.execute(text(base + where), params)).mappings().all()
    return [dict(r) for r in rows]


# ── Metric evaluators ──────────────────────────────────────────────────────────

async def eval_cpu(db: AsyncSession, device: dict, condition: str, threshold: float) -> Optional[Breach]:
    row = (await db.execute(
        text("SELECT cpu_util_pct FROM device_health_latest WHERE device_id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row or row["cpu_util_pct"] is None:
        return None
    val = float(row["cpu_util_pct"])
    if _check(val, condition, threshold):
        return Breach(device["id"], device["hostname"], value=val)
    return None


async def eval_mem(db: AsyncSession, device: dict, condition: str, threshold: float) -> Optional[Breach]:
    row = (await db.execute(
        text("SELECT mem_used_bytes, mem_total_bytes FROM device_health_latest WHERE device_id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row or not row["mem_total_bytes"]:
        return None
    pct = float(row["mem_used_bytes"] or 0) / float(row["mem_total_bytes"]) * 100
    if _check(pct, condition, threshold):
        return Breach(device["id"], device["hostname"], value=round(pct, 1))
    return None


async def eval_device_down(db: AsyncSession, device: dict) -> Optional[Breach]:
    """Fire if the device status is not 'up' or last_polled is stale.

    Stale threshold = 2.5× the device's own poll interval (minimum 90s).
    This prevents false positives on devices with longer poll intervals.
    """
    row = (await db.execute(
        text("SELECT status, last_polled FROM devices WHERE id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row:
        return None
    status = row["status"]
    last_polled = row["last_polled"]
    poll_interval = int(device.get("polling_interval_s") or 15)
    stale_seconds = max(90, int(poll_interval * 2.5))
    stale = (
        last_polled is None or
        (datetime.now(timezone.utc) - last_polled).total_seconds() > stale_seconds
    )
    if status != "up" or stale:
        return Breach(device["id"], device["hostname"], extra={"status": status, "stale": stale})
    return None


async def eval_interface_down(db: AsyncSession, device: dict) -> list[Breach]:
    """Return one breach per interface that is admin-up but oper-down."""
    rows = (await db.execute(
        text("""
            SELECT id::text, name, oper_status, admin_status
            FROM interfaces
            WHERE device_id = :did
              AND admin_status = 'up'
              AND oper_status = 'down'
        """),
        {"did": device["id"]},
    )).mappings().all()
    return [
        Breach(device["id"], device["hostname"], interface_id=r["id"], interface_name=r["name"])
        for r in rows
    ]


async def eval_uptime(db: AsyncSession, device: dict, condition: str, threshold: float) -> Optional[Breach]:
    """Alert when uptime is below threshold seconds (device recently rebooted)."""
    row = (await db.execute(
        text("SELECT uptime_seconds FROM device_health_latest WHERE device_id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row or row["uptime_seconds"] is None:
        return None
    val = float(row["uptime_seconds"])
    if _check(val, condition, threshold):
        hours = round(val / 3600, 1)
        return Breach(device["id"], device["hostname"], value=val,
                      extra={"uptime_hours": hours})
    return None


async def eval_temperature(db: AsyncSession, device: dict, threshold: float) -> Optional[Breach]:
    """Alert when any temperature sensor exceeds threshold °C."""
    row = (await db.execute(
        text("SELECT temperatures FROM device_health_latest WHERE device_id = :did"),
        {"did": device["id"]},
    )).mappings().first()
    if not row or not row["temperatures"]:
        return None
    temps = row["temperatures"]
    if isinstance(temps, str):
        import json
        try: temps = json.loads(temps)
        except Exception: return None
    hottest = max((t.get("celsius", 0) for t in temps), default=0)
    if hottest > threshold:
        return Breach(device["id"], device["hostname"], value=hottest,
                      extra={"threshold": threshold})
    return None


async def eval_interface_errors(db: AsyncSession, device: dict, threshold: float) -> list[Breach]:
    """Alert on interfaces with high error counts (in+out combined)."""
    rows = (await db.execute(
        text("""
            SELECT id::text, name,
                   COALESCE(in_errors, 0) + COALESCE(out_errors, 0) AS total_errors
            FROM interfaces
            WHERE device_id = :did
              AND admin_status = 'up'
              AND COALESCE(in_errors, 0) + COALESCE(out_errors, 0) > :thresh
        """),
        {"did": device["id"], "thresh": int(threshold)},
    )).mappings().all()
    return [
        Breach(device["id"], device["hostname"],
               interface_id=r["id"], interface_name=r["name"],
               value=float(r["total_errors"]))
        for r in rows
    ]


async def eval_custom_oid(db: AsyncSession, device: dict, oid: str,
                           condition: str, threshold: float) -> Optional[Breach]:
    """Query an arbitrary SNMP OID and compare its value to the threshold."""
    # Fetch the device's primary SNMP credential
    cred_row = (await db.execute(
        text("""
            SELECT c.type::text, c.data::text
            FROM device_credentials dc
            JOIN credentials c ON c.id = dc.credential_id
            WHERE dc.device_id = :did
              AND c.type IN ('snmp_v2c','snmp_v3')
            ORDER BY dc.priority ASC
            LIMIT 1
        """),
        {"did": device["id"]},
    )).mappings().first()
    if not cred_row:
        return None

    import json as _json
    cred_data = _json.loads(cred_row["data"])
    cred_type = cred_row["type"]

    try:
        if cred_type == "snmp_v2c":
            from pysnmp.hlapi.v3arch.asyncio import (
                CommunityData, ContextData, ObjectIdentity, ObjectType,
                SnmpEngine, UdpTransportTarget, get_cmd,
            )
            engine = SnmpEngine()
            transport = await UdpTransportTarget.create(
                (device["mgmt_ip"] if "mgmt_ip" in device else device["id"], 161),
                timeout=5, retries=0,
            )
            it = get_cmd(engine, CommunityData(cred_data.get("community", "public"), mpModel=1),
                         transport, ContextData(), ObjectType(ObjectIdentity(oid)))
        else:
            from pysnmp.hlapi.v3arch.asyncio import (
                ContextData, ObjectIdentity, ObjectType, SnmpEngine,
                UdpTransportTarget, UsmUserData, get_cmd,
            )
            import pysnmp.hlapi.v3arch.asyncio as hlapi
            _AUTH = {"md5": "usmHMACMD5AuthProtocol", "sha": "usmHMACSHAAuthProtocol",
                     "sha256": "usmHMAC192SHA256AuthProtocol", "sha512": "usmHMAC384SHA512AuthProtocol"}
            _PRIV = {"des": "usmDESPrivProtocol", "aes": "usmAesCfb128Protocol",
                     "aes192": "usmAesCfb192Protocol", "aes256": "usmAesCfb256Protocol"}
            auth_proto = getattr(hlapi, _AUTH.get(cred_data.get("auth_protocol","sha256").lower(), "usmHMAC192SHA256AuthProtocol"))
            priv_proto = getattr(hlapi, _PRIV.get(cred_data.get("priv_protocol","aes").lower(), "usmAesCfb128Protocol"))
            engine = SnmpEngine()
            transport = await UdpTransportTarget.create(
                (device.get("mgmt_ip", device["id"]), 161), timeout=5, retries=0,
            )
            it = get_cmd(engine,
                         UsmUserData(cred_data["username"],
                                     authKey=cred_data.get("auth_key",""),
                                     privKey=cred_data.get("priv_key",""),
                                     authProtocol=auth_proto, privProtocol=priv_proto),
                         transport, ContextData(), ObjectType(ObjectIdentity(oid)))

        err_ind, err_status, _, vbs = await it
        if err_ind or err_status or not vbs:
            return None
        raw = str(vbs[0][1])
        try:
            val = float(raw)
        except ValueError:
            return None
        if _check(val, condition, threshold):
            return Breach(device["id"], device["hostname"], value=val,
                          extra={"oid": oid, "raw": raw})
    except Exception:
        pass
    return None


async def eval_interface_flap(db: AsyncSession, device: dict, threshold: float, window_seconds: int) -> list[Breach]:
    """Return one breach per interface with > threshold state changes in the last window_seconds."""
    rows = (await db.execute(
        text("""
            SELECT i.id::text, i.name, COUNT(*) AS changes
            FROM interface_status_log l
            JOIN interfaces i ON i.id = l.interface_id
            WHERE i.device_id = :did
              AND l.recorded_at >= NOW() - INTERVAL '1 second' * :window
            GROUP BY i.id, i.name
            HAVING COUNT(*) > :thresh
        """),
        {"did": device["id"], "window": window_seconds, "thresh": int(threshold)},
    )).mappings().all()
    return [
        Breach(device["id"], device["hostname"],
               interface_id=r["id"], interface_name=r["name"],
               value=float(r["changes"]))
        for r in rows
    ]


async def eval_ospf_state(db: AsyncSession, device: dict) -> Optional[Breach]:
    """Fire if any OSPF neighbour is not in full state.

    States that trigger: down, attempt, init, two_way, exstart, exchange, loading.
    'unknown' is ignored (no data yet). 'full' is the only healthy state.
    """
    row = (await db.execute(
        text("""
            SELECT neighbor_router_id::text, neighbor_ip::text, state
            FROM ospf_neighbors
            WHERE device_id = :did
              AND state NOT IN ('full', 'unknown')
            ORDER BY
                CASE state
                    WHEN 'down'     THEN 1
                    WHEN 'init'     THEN 2
                    WHEN 'attempt'  THEN 3
                    WHEN 'exstart'  THEN 4
                    WHEN 'exchange' THEN 5
                    WHEN 'loading'  THEN 6
                    WHEN 'two_way'  THEN 7
                    ELSE 8
                END
            LIMIT 1
        """),
        {"did": device["id"]},
    )).mappings().first()
    if not row:
        return None
    neighbour = row["neighbor_router_id"] or row["neighbor_ip"] or "unknown"
    return Breach(
        device["id"], device["hostname"],
        extra={"neighbour": neighbour, "ospf_state": row["state"]},
    )


# ── Helpers ────────────────────────────────────────────────────────────────────

def _check(value: float, condition: str, threshold: float) -> bool:
    if condition == "gt":
        return value > threshold
    if condition == "lt":
        return value < threshold
    if condition == "gte":
        return value >= threshold
    if condition == "lte":
        return value <= threshold
    return False
