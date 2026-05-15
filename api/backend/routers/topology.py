from __future__ import annotations

import asyncio
import json
import uuid
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.device import Device
from ..models.interface import Interface, LLDPNeighbor, CDPNeighbor
from ..models.tenant import User
from ..database import AsyncSessionLocal

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/topology", tags=["topology"])

_ZERO_UUID = "00000000-0000-0000-0000-000000000000"


async def _compute_edges(devices: list, db: AsyncSession) -> list[dict]:
    """Build edge list from LLDP/CDP neighbor tables."""
    dev_by_ip   = {str(d.mgmt_ip).split("/")[0]: str(d.id) for d in devices}
    dev_by_host: dict[str, str] = {}
    for d in devices:
        if d.hostname:
            dev_by_host[d.hostname.lower()] = str(d.id)
        if d.fqdn:
            dev_by_host[d.fqdn.lower()] = str(d.id)

    def resolve_device(name: Optional[str], ip: Optional[str]) -> Optional[str]:
        if ip:
            clean_ip = str(ip).split("/")[0]
            if clean_ip in dev_by_ip:
                return dev_by_ip[clean_ip]
        if name:
            key = name.lower()
            if key in dev_by_host:
                return dev_by_host[key]
            for host, did in dev_by_host.items():
                if key.startswith(host) or host.startswith(key):
                    return did
        return None

    ifaces = (await db.execute(
        select(Interface).where(Interface.device_id.in_([d.id for d in devices]))
    )).scalars().all()
    iface_info: dict[str, dict] = {
        f"{str(i.device_id)}:{i.name}": {
            "id":        str(i.id),
            "speed_bps": i.speed_bps,
            "if_index":  i.if_index,
        }
        for i in ifaces
    }

    edges: list[dict] = []
    seen_pairs: set[frozenset] = set()

    lldp_rows = (await db.execute(
        select(LLDPNeighbor).where(LLDPNeighbor.device_id.in_([d.id for d in devices]))
    )).scalars().all()

    for n in lldp_rows:
        src_id = str(n.device_id)
        dst_id = resolve_device(n.remote_system_name, n.remote_mgmt_ip)
        if not dst_id or dst_id == src_id:
            continue
        pair = frozenset([src_id, dst_id])
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        src_iface = iface_info.get(f"{src_id}:{n.local_port_name}", {})
        edges.append({
            "id":               f"lldp-{src_id[:8]}-{dst_id[:8]}",
            "source":           src_id,
            "target":           dst_id,
            "source_port":      n.local_port_name,
            "target_port":      n.remote_port_id or n.remote_port_desc,
            "source_iface_id":  src_iface.get("id"),
            "source_speed_bps": src_iface.get("speed_bps"),
            "source_if_index":  src_iface.get("if_index"),
            "protocol":         "lldp",
        })

    cdp_rows = (await db.execute(
        select(CDPNeighbor).where(CDPNeighbor.device_id.in_([d.id for d in devices]))
    )).scalars().all()

    for n in cdp_rows:
        src_id = str(n.device_id)
        dst_id = resolve_device(n.remote_device_id, n.remote_mgmt_ip)
        if not dst_id or dst_id == src_id:
            continue
        pair = frozenset([src_id, dst_id])
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        src_iface = iface_info.get(f"{src_id}:{n.local_port_name}", {})
        edges.append({
            "id":               f"cdp-{src_id[:8]}-{dst_id[:8]}",
            "source":           src_id,
            "target":           dst_id,
            "source_port":      n.local_port_name,
            "target_port":      n.remote_port_id,
            "source_iface_id":  src_iface.get("id"),
            "source_speed_bps": src_iface.get("speed_bps"),
            "source_if_index":  src_iface.get("if_index"),
            "protocol":         "cdp",
        })

    return edges


async def _persist_topology_links(tenant_id: str, edges: list[dict]) -> None:
    """Upsert computed topology edges into topology_links and prune stale ones."""
    try:
        async with AsyncSessionLocal() as db:
            for edge in edges:
                src, dst = edge["source"], edge["target"]
                # Canonical ordering: lower UUID is always source
                if src > dst:
                    src, dst = dst, src
                    siface = None
                    meta = {
                        "source_port":      edge.get("target_port"),
                        "dest_port":        edge.get("source_port"),
                        "source_speed_bps": None,
                        "source_if_index":  None,
                    }
                else:
                    siface = edge.get("source_iface_id")
                    meta = {
                        "source_port":      edge.get("source_port"),
                        "dest_port":        edge.get("target_port"),
                        "source_speed_bps": edge.get("source_speed_bps"),
                        "source_if_index":  edge.get("source_if_index"),
                    }
                meta = {k: v for k, v in meta.items() if v is not None}

                await db.execute(text("""
                    INSERT INTO topology_links
                        (tenant_id, source_device_id, source_interface_id,
                         dest_device_id, link_type, metadata, discovered_at, updated_at)
                    VALUES
                        (:tid::uuid, :src::uuid, :siface::uuid,
                         :dst::uuid, :ltype::topology_link_type, :meta::jsonb, now(), now())
                    ON CONFLICT (source_device_id, dest_device_id, link_type,
                        COALESCE(source_interface_id, :zero::uuid),
                        COALESCE(dest_interface_id,   :zero::uuid))
                    DO UPDATE SET
                        source_interface_id = EXCLUDED.source_interface_id,
                        metadata            = EXCLUDED.metadata,
                        updated_at          = now()
                """), {"tid": tenant_id, "src": src, "siface": siface,
                       "dst": dst, "ltype": edge.get("protocol", "lldp"),
                       "meta": json.dumps(meta), "zero": _ZERO_UUID})

            await db.execute(text("""
                DELETE FROM topology_links
                WHERE tenant_id = :tid::uuid
                AND updated_at < now() - interval '10 minutes'
            """), {"tid": tenant_id})

            await db.commit()
    except Exception:
        logger.exception("topology_links_persist_failed")


async def _refresh_topology(tenant_id: str) -> None:
    """Recompute topology from neighbor tables and update topology_links."""
    try:
        async with AsyncSessionLocal() as db:
            devices = (await db.execute(
                select(Device).where(
                    Device.tenant_id == uuid.UUID(tenant_id),
                    Device.is_active == True,  # noqa: E712
                )
            )).scalars().all()
            edges = await _compute_edges(devices, db)
        await _persist_topology_links(tenant_id, edges)
    except Exception:
        logger.exception("topology_refresh_failed")


async def start_topology_refresh_loop(interval_seconds: int = 300) -> asyncio.Task:
    """Periodic topology refresh — runs for all active tenants every interval."""
    async def _loop() -> None:
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                async with AsyncSessionLocal() as db:
                    tenant_ids = (await db.execute(
                        text("SELECT DISTINCT tenant_id::text FROM devices WHERE is_active = true")
                    )).scalars().all()
                for tid in tenant_ids:
                    await _refresh_topology(tid)
                    logger.debug("topology_refresh_complete", tenant_id=tid)
            except Exception:
                logger.exception("topology_refresh_loop_error")

    return asyncio.create_task(_loop(), name="topology-refresh-loop")


@router.get("/link-utilisation", summary="Current utilisation snapshot for a set of interfaces")
async def get_link_utilisation_batch(
    iface_ids: str = Query(..., description="Comma-separated interface UUIDs"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    raw_ids = [i.strip() for i in iface_ids.split(",") if i.strip()]
    if not raw_ids:
        return {}

    valid_uuids: list[uuid.UUID] = []
    for r in raw_ids:
        try:
            valid_uuids.append(uuid.UUID(r))
        except ValueError:
            pass
    if not valid_uuids:
        return {}

    rows = (await db.execute(
        select(Interface.id, Interface.device_id, Interface.if_index, Interface.speed_bps)
        .join(Device, Interface.device_id == Device.id)
        .where(
            Interface.id.in_(valid_uuids),
            Device.tenant_id == current_user.tenant_id,
        )
    )).all()
    if not rows:
        return {}

    # (device_id, if_index) → (iface_id, speed_bps)
    key_to_iface: dict[tuple[str, str], tuple[str, int | None]] = {
        (str(r.device_id), str(r.if_index)): (str(r.id), r.speed_bps)
        for r in rows
    }
    device_re = "|".join({str(r.device_id) for r in rows})

    async def vm_instant(metric: str) -> dict[str, float]:
        query = f'rate({metric}{{device_id=~"{device_re}"}}[2m]) * 8'
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    "http://localhost:8428/api/v1/query",
                    params={"query": query},
                )
            series_list = resp.json().get("data", {}).get("result", [])
        except Exception:
            logger.exception("topo_util_vm_failed", metric=metric)
            return {}
        out: dict[str, float] = {}
        for series in series_list:
            did = series["metric"].get("device_id", "")
            idx = series["metric"].get("if_index", "")
            val = series.get("value")
            bps = float(val[1]) if val else 0.0
            entry = key_to_iface.get((did, idx))
            if entry:
                out[entry[0]] = bps
        return out

    in_map, out_map = await asyncio.gather(
        vm_instant("anthrimon_if_in_octets_total"),
        vm_instant("anthrimon_if_out_octets_total"),
    )

    return {
        str(r.id): {
            "in_bps":    in_map.get(str(r.id), 0.0),
            "out_bps":   out_map.get(str(r.id), 0.0),
            "speed_bps": r.speed_bps,
        }
        for r in rows
    }


@router.get("", summary="Network topology graph derived from LLDP/CDP neighbor data")
async def get_topology(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tenant_id = current_user.tenant_id

    devices = (await db.execute(
        select(Device).where(Device.tenant_id == tenant_id, Device.is_active == True)  # noqa: E712
    )).scalars().all()

    # Read pre-computed edges from topology_links
    link_rows = (await db.execute(text("""
        SELECT source_device_id::text, source_interface_id::text,
               dest_device_id::text, link_type, metadata
        FROM topology_links
        WHERE tenant_id = :tid
    """), {"tid": str(tenant_id)})).mappings().all()

    if link_rows:
        edges = []
        for row in link_rows:
            meta     = row["metadata"] or {}
            src_id   = row["source_device_id"]
            dst_id   = row["dest_device_id"]
            protocol = row["link_type"]
            edges.append({
                "id":               f"{protocol}-{src_id[:8]}-{dst_id[:8]}",
                "source":           src_id,
                "target":           dst_id,
                "source_port":      meta.get("source_port"),
                "target_port":      meta.get("dest_port"),
                "source_iface_id":  row["source_interface_id"],
                "source_speed_bps": meta.get("source_speed_bps"),
                "source_if_index":  meta.get("source_if_index"),
                "protocol":         protocol,
            })
        asyncio.create_task(_refresh_topology(str(tenant_id)))
    else:
        # First run or table expired — compute synchronously so the page isn't blank
        edges = await _compute_edges(devices, db)
        asyncio.create_task(_persist_topology_links(str(tenant_id), edges))

    connected_ids = {e["source"] for e in edges} | {e["target"] for e in edges}
    nodes = [
        {
            "id":          str(d.id),
            "hostname":    d.fqdn or d.hostname,
            "mgmt_ip":     str(d.mgmt_ip).split("/")[0],
            "vendor":      d.vendor,
            "device_type": d.device_type,
            "status":      d.status,
            "connected":   str(d.id) in connected_ids,
        }
        for d in devices
    ]

    return {"nodes": nodes, "edges": edges}
