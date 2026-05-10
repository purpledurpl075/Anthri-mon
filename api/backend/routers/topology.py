from __future__ import annotations

import asyncio
import json
import uuid
from typing import Optional

import structlog
from fastapi import APIRouter, Depends
from sqlalchemy import cast, String, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db
from ..models.device import Device
from ..models.interface import Interface, LLDPNeighbor, CDPNeighbor
from ..models.tenant import User
from ..database import AsyncSessionLocal

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/topology", tags=["topology"])

_ZERO_UUID = "00000000-0000-0000-0000-000000000000"


async def _persist_topology_links(tenant_id: str, edges: list[dict]) -> None:
    """Upsert computed topology edges into topology_links and prune stale ones."""
    try:
        async with AsyncSessionLocal() as db:
            for edge in edges:
                src, dst = edge["source"], edge["target"]
                # Enforce canonical ordering required by the check constraint
                if src > dst:
                    src, dst = dst, src
                    meta = {"source_port": edge.get("target_port"), "dest_port": edge.get("source_port")}
                else:
                    meta = {"source_port": edge.get("source_port"), "dest_port": edge.get("target_port")}
                meta = {k: v for k, v in meta.items() if v}

                await db.execute(text("""
                    INSERT INTO topology_links
                        (tenant_id, source_device_id, dest_device_id, link_type, metadata, discovered_at, updated_at)
                    VALUES
                        (:tid::uuid, :src::uuid, :dst::uuid, :ltype::topology_link_type, :meta::jsonb, now(), now())
                    ON CONFLICT (source_device_id, dest_device_id, link_type,
                        COALESCE(source_interface_id, :zero::uuid),
                        COALESCE(dest_interface_id,   :zero::uuid))
                    DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = now()
                """), {"tid": tenant_id, "src": src, "dst": dst,
                       "ltype": edge.get("protocol", "lldp"),
                       "meta": json.dumps(meta), "zero": _ZERO_UUID})

            # Prune edges not refreshed in the last 10 minutes
            await db.execute(text("""
                DELETE FROM topology_links
                WHERE tenant_id = :tid::uuid
                AND updated_at < now() - interval '10 minutes'
            """), {"tid": tenant_id})

            await db.commit()
    except Exception:
        logger.exception("topology_links_persist_failed")


@router.get("", summary="Network topology graph derived from LLDP/CDP neighbour data")
async def get_topology(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tenant_id = current_user.tenant_id

    # ── Load all devices ────────────────────────────────────────────────────
    devices = (await db.execute(
        select(Device).where(Device.tenant_id == tenant_id, Device.is_active == True)  # noqa: E712
    )).scalars().all()

    dev_by_id   = {str(d.id): d for d in devices}
    dev_by_ip   = {str(d.mgmt_ip).split("/")[0]: str(d.id) for d in devices}
    dev_by_host = {}
    for d in devices:
        if d.hostname:
            dev_by_host[d.hostname.lower()] = str(d.id)
        if d.fqdn:
            dev_by_host[d.fqdn.lower()] = str(d.id)

    def resolve_device(name: Optional[str], ip: Optional[str]) -> Optional[str]:
        """Return device_id for a remote neighbour, or None if not in inventory."""
        if ip:
            clean_ip = str(ip).split("/")[0]
            if clean_ip in dev_by_ip:
                return dev_by_ip[clean_ip]
        if name:
            key = name.lower()
            if key in dev_by_host:
                return dev_by_host[key]
            # Partial hostname match (some devices report short names)
            for host, did in dev_by_host.items():
                if key.startswith(host) or host.startswith(key):
                    return did
        return None

    # ── Load interfaces for port label resolution ───────────────────────────
    ifaces = (await db.execute(
        select(Interface).where(
            Interface.device_id.in_([d.id for d in devices])
        )
    )).scalars().all()
    iface_info: dict[str, dict] = {
        f"{str(i.device_id)}:{i.name}": {
            "id":        str(i.id),
            "speed_bps": i.speed_bps,
            "if_index":  i.if_index,
        }
        for i in ifaces
    }

    # ── Collect edges from LLDP ─────────────────────────────────────────────
    lldp_rows = (await db.execute(
        select(LLDPNeighbor).where(
            LLDPNeighbor.device_id.in_([d.id for d in devices])
        )
    )).scalars().all()

    edges: list[dict] = []
    seen_pairs: set[frozenset] = set()

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

    # ── Collect edges from CDP (skip if LLDP already found the pair) ────────
    cdp_rows = (await db.execute(
        select(CDPNeighbor).where(
            CDPNeighbor.device_id.in_([d.id for d in devices])
        )
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

    # ── Build node list (only devices that appear in at least one edge) ──────
    connected_ids = {e["source"] for e in edges} | {e["target"] for e in edges}
    # Include ALL known devices so isolated devices can be optionally shown
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

    result = {"nodes": nodes, "edges": edges}

    # Persist computed edges to topology_links in the background (non-blocking)
    asyncio.create_task(_persist_topology_links(str(tenant_id), edges))

    return result
