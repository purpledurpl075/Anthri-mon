from __future__ import annotations

import ipaddress
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.device import Device
from ..models.interface import Interface
from ..models.tenant import User

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/flow", tags=["flow"])

_CH_URL = "http://localhost:8123"

PROTO_NAMES: dict[int, str] = {
    1: "ICMP", 2: "IGMP", 6: "TCP", 17: "UDP", 41: "IPv6",
    47: "GRE", 50: "ESP", 51: "AH", 58: "ICMPv6", 89: "OSPF",
    103: "PIM", 112: "VRRP", 132: "SCTP",
}


# ── ClickHouse helper ─────────────────────────────────────────────────────────

async def _ch(query: str) -> list[dict]:
    """Execute a ClickHouse query via HTTP and return rows as dicts."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                _CH_URL,
                content=query + " FORMAT JSON",
                headers={"Content-Type": "text/plain"},
            )
        resp.raise_for_status()
        return resp.json().get("data", [])
    except Exception as exc:
        logger.error("clickhouse_query_failed", error=str(exc), query=query[:200])
        raise HTTPException(status_code=503, detail="Flow data unavailable") from exc


# ── Tenant device helpers ─────────────────────────────────────────────────────

async def _tenant_device_ids(tenant_id, db: AsyncSession) -> list[str]:
    """Return all active device UUIDs for this tenant as strings."""
    rows = (await db.execute(
        select(Device.id).where(Device.tenant_id == tenant_id, Device.is_active == True)  # noqa: E712
    )).scalars().all()
    return [str(r) for r in rows]


async def _assert_device_in_tenant(device_id: str, tenant_id, db: AsyncSession) -> Device:
    dev = (await db.execute(
        select(Device).where(Device.id == device_id, Device.tenant_id == tenant_id, Device.is_active == True)  # noqa: E712
    )).scalar_one_or_none()
    if dev is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return dev


def _device_filter(device_ids: list[str], alias: str = "") -> str:
    """Build a ClickHouse WHERE clause fragment for device ID filtering."""
    col = f"{alias}.collector_device_id" if alias else "collector_device_id"
    ids = ", ".join(f"toUUID('{d}')" for d in device_ids)
    return f"{col} IN ({ids})"


def _quote_ip(ip: str) -> str:
    """Validate and return a quoted IP string safe for ClickHouse queries."""
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid IP address: {ip}")
    return f"toIPv4('{ip}')"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/summary", summary="Flow totals for the selected window")
async def flow_summary(
    device_id:      Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60, ge=1, le=10080),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> dict:
    if device_id:
        await _assert_device_in_tenant(device_id, current_user.tenant_id, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(current_user.tenant_id, db)

    if not device_ids:
        return {"bytes_total": 0, "packets_total": 0, "flows_total": 0,
                "unique_src_ips": 0, "unique_dst_ips": 0, "active_exporters": 0}

    rows = await _ch(f"""
        SELECT
            sum(bytes_total)   AS bytes_total,
            sum(packets_total) AS packets_total,
            sum(flow_count)    AS flows_total,
            uniq(src_ip)            AS unique_src_ips,
            uniq(dst_ip)            AS unique_dst_ips,
            uniq(collector_device_id) AS active_exporters
        FROM flow_agg_1min
        WHERE {_device_filter(device_ids)}
          AND minute >= now() - INTERVAL {minutes} MINUTE
    """)
    if not rows:
        return {"bytes_total": 0, "packets_total": 0, "flows_total": 0,
                "unique_src_ips": 0, "unique_dst_ips": 0, "active_exporters": 0}
    r = rows[0]
    return {
        "bytes_total":      int(r.get("bytes_total", 0)),
        "packets_total":    int(r.get("packets_total", 0)),
        "flows_total":      int(r.get("flows_total", 0)),
        "unique_src_ips":   int(r.get("unique_src_ips", 0)),
        "unique_dst_ips":   int(r.get("unique_dst_ips", 0)),
        "active_exporters": int(r.get("active_exporters", 0)),
    }


@router.get("/top-talkers", summary="Top src/dst IP pairs by bytes")
async def top_talkers(
    device_id:      Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60,  ge=1, le=10080),
    limit:          int           = Query(default=20,  ge=1, le=100),
    protocol:       Optional[int] = Query(default=None, description="IANA protocol number"),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, current_user.tenant_id, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(current_user.tenant_id, db)

    if not device_ids:
        return []

    proto_clause = f"AND ip_protocol = {protocol}" if protocol is not None else ""

    rows = await _ch(f"""
        SELECT
            IPv4NumToString(src_ip)  AS src_ip,
            IPv4NumToString(dst_ip)  AS dst_ip,
            ip_protocol,
            sum(bytes_total)    AS bytes_total,
            sum(packets_total)  AS packets_total,
            sum(flow_count)     AS flow_count
        FROM flow_agg_1min
        WHERE {_device_filter(device_ids)}
          AND minute >= now() - INTERVAL {minutes} MINUTE
          {proto_clause}
        GROUP BY src_ip, dst_ip, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    return [
        {
            "src_ip":       r["src_ip"],
            "dst_ip":       r["dst_ip"],
            "protocol":     int(r["ip_protocol"]),
            "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":   int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/top-ports", summary="Top destination ports by bytes")
async def top_ports(
    device_id:      Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60,  ge=1, le=10080),
    limit:          int           = Query(default=20,  ge=1, le=100),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, current_user.tenant_id, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(current_user.tenant_id, db)

    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            dst_port,
            ip_protocol,
            sum(bytes)    AS bytes_total,
            sum(packets)  AS packets_total,
            count()       AS flow_count
        FROM flow_records
        WHERE {_device_filter(device_ids)}
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
          AND dst_port > 0
          AND ip_protocol IN (6, 17)
        GROUP BY dst_port, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    return [
        {
            "dst_port":     int(r["dst_port"]),
            "protocol":     int(r["ip_protocol"]),
            "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":   int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/protocol-breakdown", summary="Bytes per protocol over time")
async def protocol_breakdown(
    device_id:      Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60, ge=5, le=10080),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, current_user.tenant_id, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(current_user.tenant_id, db)

    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            toUnixTimestamp(bucket) * 1000  AS ts_ms,
            ip_protocol,
            sum(bytes_total)           AS bytes_total,
            sum(packets_total)         AS packets_total
        FROM flow_agg_proto_5min
        WHERE {_device_filter(device_ids)}
          AND bucket >= now() - INTERVAL {minutes} MINUTE
        GROUP BY bucket, ip_protocol
        ORDER BY bucket ASC, bytes_total DESC
    """)

    return [
        {
            "ts_ms":        int(r["ts_ms"]),
            "protocol":     int(r["ip_protocol"]),
            "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
        }
        for r in rows
    ]


@router.get("/interface-breakdown", summary="Per-interface flow bytes for a device")
async def interface_breakdown(
    device_id:      str           = Query(...),
    hours:          int           = Query(default=24, ge=1, le=720),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device_in_tenant(device_id, current_user.tenant_id, db)

    rows = await _ch(f"""
        SELECT
            input_if_index,
            output_if_index,
            sum(bytes_total)   AS bytes_total,
            sum(packets_total) AS packets_total,
            sum(flow_count)    AS flow_count
        FROM flow_agg_iface_1hr
        WHERE collector_device_id = toUUID('{device_id}')
          AND hour >= now() - INTERVAL {hours} HOUR
        GROUP BY input_if_index, output_if_index
        ORDER BY bytes_total DESC
        LIMIT 50
    """)

    # Enrich with interface names from PostgreSQL
    iface_rows = (await db.execute(
        select(Interface.if_index, Interface.name)
        .where(Interface.device_id == device_id)
    )).all()
    iface_name: dict[int, str] = {r.if_index: r.name for r in iface_rows}

    return [
        {
            "input_if_index":  int(r["input_if_index"]),
            "input_if_name":   iface_name.get(int(r["input_if_index"]), ""),
            "output_if_index": int(r["output_if_index"]),
            "output_if_name":  iface_name.get(int(r["output_if_index"]), ""),
            "bytes_total":     int(r["bytes_total"]),
            "packets_total":   int(r["packets_total"]),
            "flow_count":      int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/top-devices", summary="Devices ranked by total flow bytes")
async def top_devices(
    minutes:        int  = Query(default=60, ge=1, le=10080),
    limit:          int  = Query(default=10, ge=1, le=50),
    current_user:   User = Depends(get_current_user),
    db:             AsyncSession = Depends(get_db),
) -> list[dict]:
    device_ids = await _tenant_device_ids(current_user.tenant_id, db)
    if not device_ids:
        return []

    rows = await _ch(f"""
        SELECT
            toString(collector_device_id)  AS device_uuid,
            sum(bytes_total)          AS bytes_total,
            sum(packets_total)        AS packets_total,
            sum(flow_count)           AS flow_count
        FROM flow_agg_1min
        WHERE {_device_filter(device_ids)}
          AND minute >= now() - INTERVAL {minutes} MINUTE
        GROUP BY collector_device_id
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    # Enrich with device names from PostgreSQL
    dev_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.fqdn, Device.device_type)
        .where(Device.tenant_id == current_user.tenant_id, Device.is_active == True)  # noqa: E712
    )).all()
    dev_info = {str(r.id): {"hostname": r.fqdn or r.hostname, "device_type": r.device_type} for r in dev_rows}

    return [
        {
            "device_id":    r["device_uuid"],
            "device_name":  dev_info.get(r["device_uuid"], {}).get("hostname", r["device_uuid"][:8]),
            "device_type":  dev_info.get(r["device_uuid"], {}).get("device_type", "unknown"),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":   int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/search", summary="Search raw flow records")
async def search_flows(
    device_id:      Optional[str] = Query(default=None),
    src_ip:         Optional[str] = Query(default=None),
    dst_ip:         Optional[str] = Query(default=None),
    protocol:       Optional[int] = Query(default=None),
    src_port:       Optional[int] = Query(default=None),
    dst_port:       Optional[int] = Query(default=None),
    minutes:        int           = Query(default=10, ge=1, le=1440),
    limit:          int           = Query(default=200, ge=1, le=1000),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, current_user.tenant_id, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(current_user.tenant_id, db)

    if not device_ids:
        return []

    clauses = [
        _device_filter(device_ids),
        f"flow_start >= now() - INTERVAL {minutes} MINUTE",
    ]
    if src_ip:    clauses.append(f"src_ip = {_quote_ip(src_ip)}")
    if dst_ip:    clauses.append(f"dst_ip = {_quote_ip(dst_ip)}")
    if protocol is not None: clauses.append(f"ip_protocol = {protocol}")
    if src_port is not None: clauses.append(f"src_port = {src_port}")
    if dst_port is not None: clauses.append(f"dst_port = {dst_port}")

    where = " AND ".join(clauses)

    rows = await _ch(f"""
        SELECT
            toString(collector_device_id)    AS device_uuid,
            IPv4NumToString(exporter_ip)     AS exporter_ip,
            flow_type,
            toUnixTimestamp(flow_start) * 1000 AS flow_start_ms,
            toUnixTimestamp(flow_end)   * 1000 AS flow_end_ms,
            IPv4NumToString(src_ip)          AS src_ip,
            IPv4NumToString(dst_ip)          AS dst_ip,
            src_port,
            dst_port,
            ip_protocol,
            tcp_flags,
            bytes,
            packets,
            input_if_index,
            output_if_index,
            src_asn,
            dst_asn,
            sampling_rate
        FROM flow_records
        WHERE {where}
        ORDER BY flow_start DESC
        LIMIT {limit}
    """)

    return [
        {
            "device_id":      r["device_uuid"],
            "exporter_ip":    r["exporter_ip"],
            "flow_type":      r["flow_type"],
            "flow_start_ms":  int(r["flow_start_ms"]),
            "flow_end_ms":    int(r["flow_end_ms"]),
            "src_ip":         r["src_ip"],
            "dst_ip":         r["dst_ip"],
            "src_port":       int(r["src_port"]),
            "dst_port":       int(r["dst_port"]),
            "protocol":       int(r["ip_protocol"]),
            "protocol_name":  PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "tcp_flags":      int(r["tcp_flags"]),
            "bytes":          int(r["bytes"]),
            "packets":        int(r["packets"]),
            "input_if_index":  int(r["input_if_index"]),
            "output_if_index": int(r["output_if_index"]),
            "src_asn":        int(r["src_asn"]),
            "dst_asn":        int(r["dst_asn"]),
            "sampling_rate":  int(r["sampling_rate"]),
        }
        for r in rows
    ]


@router.get("/timeseries", summary="Bytes/packets time series for a device or pair")
async def flow_timeseries(
    device_id:      Optional[str] = Query(default=None),
    src_ip:         Optional[str] = Query(default=None),
    dst_ip:         Optional[str] = Query(default=None),
    minutes:        int           = Query(default=60, ge=5, le=10080),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    if device_id:
        await _assert_device_in_tenant(device_id, current_user.tenant_id, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(current_user.tenant_id, db)

    if not device_ids:
        return []

    clauses = [
        _device_filter(device_ids),
        f"minute >= now() - INTERVAL {minutes} MINUTE",
    ]
    if src_ip: clauses.append(f"src_ip = {_quote_ip(src_ip)}")
    if dst_ip: clauses.append(f"dst_ip = {_quote_ip(dst_ip)}")
    where = " AND ".join(clauses)

    rows = await _ch(f"""
        SELECT
            toUnixTimestamp(minute) * 1000  AS ts_ms,
            sum(bytes_total)           AS bytes_total,
            sum(packets_total)         AS packets_total,
            sum(flow_count)            AS flow_count
        FROM flow_agg_1min
        WHERE {where}
        GROUP BY minute
        ORDER BY minute ASC
    """)

    return [
        {
            "ts_ms":        int(r["ts_ms"]),
            "bytes_total":  int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":   int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/interface-timeseries", summary="Per-minute flow bytes for a specific interface")
async def interface_flow_timeseries(
    device_id:      str           = Query(...),
    if_index:       int           = Query(...),
    minutes:        int           = Query(default=60, ge=5, le=10080),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device_in_tenant(device_id, current_user.tenant_id, db)

    rows = await _ch(f"""
        SELECT
            toUnixTimestamp(toStartOfMinute(flow_start)) * 1000  AS ts_ms,
            sum(if(input_if_index  = {if_index}, bytes, 0))      AS bytes_in,
            sum(if(output_if_index = {if_index}, bytes, 0))      AS bytes_out,
            sum(packets)                                          AS packets_total,
            count()                                               AS flow_count
        FROM flow_records
        WHERE collector_device_id = toUUID('{device_id}')
          AND (input_if_index = {if_index} OR output_if_index = {if_index})
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
        GROUP BY ts_ms
        ORDER BY ts_ms ASC
    """)

    return [
        {
            "ts_ms":         int(r["ts_ms"]),
            "bytes_in":      int(r["bytes_in"]),
            "bytes_out":     int(r["bytes_out"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":    int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/interface-top-talkers", summary="Top talkers through a specific interface")
async def interface_top_talkers(
    device_id:      str           = Query(...),
    if_index:       int           = Query(...),
    minutes:        int           = Query(default=60, ge=5, le=10080),
    limit:          int           = Query(default=10, ge=1, le=50),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> list[dict]:
    await _assert_device_in_tenant(device_id, current_user.tenant_id, db)

    rows = await _ch(f"""
        SELECT
            IPv4NumToString(src_ip)  AS src_ip,
            IPv4NumToString(dst_ip)  AS dst_ip,
            ip_protocol,
            sum(bytes)               AS bytes_total,
            sum(packets)             AS packets_total,
            count()                  AS flow_count
        FROM flow_records
        WHERE collector_device_id = toUUID('{device_id}')
          AND (input_if_index = {if_index} OR output_if_index = {if_index})
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
        GROUP BY src_ip, dst_ip, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    return [
        {
            "src_ip":        r["src_ip"],
            "dst_ip":        r["dst_ip"],
            "protocol":      int(r["ip_protocol"]),
            "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
            "bytes_total":   int(r["bytes_total"]),
            "packets_total": int(r["packets_total"]),
            "flow_count":    int(r["flow_count"]),
        }
        for r in rows
    ]


@router.get("/ip-detail", summary="Drill-down stats for a single IP address")
async def ip_detail(
    ip:             str           = Query(...),
    minutes:        int           = Query(default=60, ge=1, le=10080),
    device_id:      Optional[str] = Query(default=None),
    current_user:   User          = Depends(get_current_user),
    db:             AsyncSession  = Depends(get_db),
) -> dict:
    _quote_ip(ip)  # validate

    if device_id:
        await _assert_device_in_tenant(device_id, current_user.tenant_id, db)
        device_ids = [device_id]
    else:
        device_ids = await _tenant_device_ids(current_user.tenant_id, db)

    if not device_ids:
        return {}

    dev_clause = _device_filter(device_ids)
    qip = f"toIPv4('{ip}')"
    time_clause = f"minute >= now() - INTERVAL {minutes} MINUTE"

    # ── Totals as src and as dst ──────────────────────────────────────────────
    totals = await _ch(f"""
        SELECT
            sum(if(src_ip = {qip}, bytes_total,   0)) AS bytes_as_src,
            sum(if(dst_ip = {qip}, bytes_total,   0)) AS bytes_as_dst,
            sum(if(src_ip = {qip}, packets_total, 0)) AS pkts_as_src,
            sum(if(dst_ip = {qip}, packets_total, 0)) AS pkts_as_dst,
            sum(flow_count)                            AS flows_total
        FROM flow_agg_1min
        WHERE {dev_clause}
          AND (src_ip = {qip} OR dst_ip = {qip})
          AND {time_clause}
    """)

    # ── Top peers ─────────────────────────────────────────────────────────────
    peers = await _ch(f"""
        SELECT
            if(src_ip = {qip},
               IPv4NumToString(dst_ip),
               IPv4NumToString(src_ip))            AS peer_ip,
            sum(if(src_ip = {qip}, bytes_total, 0)) AS bytes_sent,
            sum(if(dst_ip = {qip}, bytes_total, 0)) AS bytes_received
        FROM flow_agg_1min
        WHERE {dev_clause}
          AND (src_ip = {qip} OR dst_ip = {qip})
          AND {time_clause}
        GROUP BY peer_ip
        ORDER BY bytes_sent + bytes_received DESC
        LIMIT 15
    """)

    # ── Top destination ports used by this IP as source ───────────────────────
    ports = await _ch(f"""
        SELECT
            dst_port,
            ip_protocol,
            sum(bytes)   AS bytes_total,
            sum(packets) AS packets_total,
            count()      AS flow_count
        FROM flow_records
        WHERE {_device_filter(device_ids)}
          AND src_ip = {qip}
          AND flow_start >= now() - INTERVAL {minutes} MINUTE
          AND dst_port > 0
          AND ip_protocol IN (6, 17)
        GROUP BY dst_port, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT 10
    """)

    # ── Per-minute time series (both directions) ──────────────────────────────
    ts = await _ch(f"""
        SELECT
            toUnixTimestamp(minute) * 1000           AS ts_ms,
            sum(if(src_ip = {qip}, bytes_total, 0))  AS bytes_out,
            sum(if(dst_ip = {qip}, bytes_total, 0))  AS bytes_in
        FROM flow_agg_1min
        WHERE {dev_clause}
          AND (src_ip = {qip} OR dst_ip = {qip})
          AND {time_clause}
        GROUP BY minute
        ORDER BY minute ASC
    """)

    t = totals[0] if totals else {}
    return {
        "ip":           ip,
        "bytes_as_src": int(t.get("bytes_as_src", 0)),
        "bytes_as_dst": int(t.get("bytes_as_dst", 0)),
        "pkts_as_src":  int(t.get("pkts_as_src",  0)),
        "pkts_as_dst":  int(t.get("pkts_as_dst",  0)),
        "flows_total":  int(t.get("flows_total",   0)),
        "top_peers": [
            {
                "peer_ip":        r["peer_ip"],
                "bytes_sent":     int(r["bytes_sent"]),
                "bytes_received": int(r["bytes_received"]),
            }
            for r in peers
        ],
        "top_ports": [
            {
                "dst_port":      int(r["dst_port"]),
                "protocol":      int(r["ip_protocol"]),
                "protocol_name": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
                "bytes_total":   int(r["bytes_total"]),
            }
            for r in ports
        ],
        "timeseries": [
            {
                "ts_ms":     int(r["ts_ms"]),
                "bytes_out": int(r["bytes_out"]),
                "bytes_in":  int(r["bytes_in"]),
            }
            for r in ts
        ],
    }
