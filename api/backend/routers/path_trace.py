from __future__ import annotations

import ipaddress
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_principal, get_db, accessible_device_ids_subquery, Principal
from ..models.device import Device
from ..models.interface import ARPEntry, CDPNeighbor, Interface, LLDPNeighbor, MACEntry, RouteEntry

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/path-trace", tags=["path-trace"])

MAX_HOPS = 15


# ── Pydantic models ────────────────────────────────────────────────────────────

class TraceRequest(BaseModel):
    src_ip: str
    dst_ip: str


class L3Hop(BaseModel):
    device_id: str
    device_name: str
    mgmt_ip: str
    egress_if: Optional[str] = None
    next_hop: Optional[str] = None
    route_prefix: Optional[str] = None
    route_protocol: Optional[str] = None
    ecmp_count: Optional[int] = None


class L2Hop(BaseModel):
    device_id: str
    device_name: str
    mgmt_ip: str
    ingress_port: Optional[str] = None
    egress_port: Optional[str] = None
    vlan: Optional[int] = None


class TraceResult(BaseModel):
    src_ip: str
    dst_ip: str
    src_mac: Optional[str] = None
    dst_mac: Optional[str] = None
    src_located: bool = False   # True when src was found via mgmt_ip / interface / ARP / connected route
    src_device: Optional[str] = None  # device name where src was located
    l3_hops: list[L3Hop] = []
    l2_hops: list[L2Hop] = []
    dst_device: Optional[str] = None  # name of dst device if it's monitored
    dst_found: bool = False
    incomplete: bool = False
    incomplete_reason: Optional[str] = None  # "no_route" | "unmonitored_next_hop" | "loop" | "self_loop" | "max_hops"
    dead_end_device: Optional[str] = None  # device name where the trace ran out of routes (no_route)
    dead_end_device_id: Optional[str] = None  # device id where the trace ran out of routes (no_route)
    error: Optional[str] = None


# ── Helpers ────────────────────────────────────────────────────────────────────

def _norm_mac(m: str) -> str:
    return m.lower().replace("-", ":").replace(".", ":")


def _norm_ip(ip_str) -> Optional[str]:
    if not ip_str:
        return None
    try:
        return str(ipaddress.ip_address(ip_str))
    except (ValueError, TypeError):
        return None


def _is_connected(route: RouteEntry) -> bool:
    return route.protocol in ("connected", "local", "direct") or route.next_hop in (None, "", "0.0.0.0")


def _select_route(
    dst_addr: ipaddress.IPv4Address | ipaddress.IPv6Address,
    routes: list[RouteEntry],
    ip_to_device: dict[str, tuple[Device, str]],
    dev_by_ip: dict[str, Device],
) -> tuple[Optional[RouteEntry], int]:
    """Longest-prefix match with ECMP awareness.

    Among routes tied for the longest matching prefix, prefer one whose
    next-hop resolves to a monitored device (interface IP or mgmt IP) so the
    trace can keep walking. Returns (route, candidate_count) — candidate_count
    is the number of equal-cost routes tied at the winning prefix length.
    """
    best_len = -1
    candidates: list[RouteEntry] = []
    for r in routes:
        if not r.destination:
            continue
        try:
            net = ipaddress.ip_network(r.destination, strict=False)
        except ValueError:
            continue
        if dst_addr not in net:
            continue
        if net.prefixlen > best_len:
            best_len = net.prefixlen
            candidates = [r]
        elif net.prefixlen == best_len:
            candidates.append(r)

    if not candidates:
        return None, 0
    if len(candidates) == 1:
        return candidates[0], 1

    for r in candidates:
        nh = _norm_ip(r.next_hop)
        if nh and (nh in ip_to_device or nh in dev_by_ip):
            return r, len(candidates)

    return candidates[0], len(candidates)


# ── Endpoint ───────────────────────────────────────────────────────────────────

@router.post("", response_model=TraceResult)
async def trace_path(
    req: TraceRequest,
    db: AsyncSession = Depends(get_db),
    principal: Principal = Depends(get_current_principal),
):
    src_ip = req.src_ip.strip()
    dst_ip = req.dst_ip.strip()

    try:
        dst_addr = ipaddress.ip_address(dst_ip)
        src_addr = ipaddress.ip_address(src_ip)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid IP address: {e}")

    src_norm = _norm_ip(src_ip) or src_ip
    dst_norm = _norm_ip(dst_ip) or dst_ip

    result = TraceResult(src_ip=src_ip, dst_ip=dst_ip)

    # ── Load all devices ───────────────────────────────────────────────────────
    devs_result = await db.execute(
        select(Device).where(Device.id.in_(accessible_device_ids_subquery(principal)))
    )
    all_devices: list[Device] = list(devs_result.scalars().all())

    dev_by_ip: dict[str, Device] = {}
    for d in all_devices:
        norm = _norm_ip(d.mgmt_ip_str)
        if norm:
            dev_by_ip[norm] = d
    dev_by_id: dict[str, Device] = {str(d.id): d for d in all_devices}

    # ── Load every IP address configured on every monitored interface ─────────
    # This is the key to walking routed hops between routers: BGP/IGP next-hops
    # are point-to-point link addresses or loopbacks, almost never a device's
    # mgmt_ip. Map every such address to its owning device + interface.
    ifaces_result = await db.execute(
        select(Interface).where(Interface.device_id.in_(accessible_device_ids_subquery(principal)))
    )
    all_ifaces: list[Interface] = list(ifaces_result.scalars().all())

    ip_to_device: dict[str, tuple[Device, str]] = {}
    for iface in all_ifaces:
        dev = dev_by_id.get(str(iface.device_id))
        if not dev:
            continue
        for addr in (iface.ip_addresses or []):
            norm = _norm_ip(addr.get("address"))
            if norm:
                ip_to_device[norm] = (dev, iface.name)

    # Check if dst_ip IS a monitored device — any interface address, not just mgmt_ip
    if dst_norm in ip_to_device:
        result.dst_device = ip_to_device[dst_norm][0].display_name
    elif dst_norm in dev_by_ip:
        result.dst_device = dev_by_ip[dst_norm].display_name

    # ── Load all ARP entries ───────────────────────────────────────────────────
    arp_result = await db.execute(
        select(ARPEntry).where(ARPEntry.device_id.in_(accessible_device_ids_subquery(principal)))
    )
    all_arp: list[ARPEntry] = list(arp_result.scalars().all())

    arp_ip_to_mac: dict[str, str] = {}
    arp_by_dev_ip: dict[tuple[str, str], str] = {}
    # ip → list of device_ids that have this IP in ARP
    arp_ip_to_devs: dict[str, list[str]] = {}
    for a in all_arp:
        norm = _norm_ip(a.ip_address) or a.ip_address
        arp_ip_to_mac[norm] = a.mac_address
        arp_by_dev_ip[(str(a.device_id), norm)] = a.mac_address
        arp_ip_to_devs.setdefault(norm, []).append(str(a.device_id))

    result.src_mac = arp_ip_to_mac.get(src_norm)
    result.dst_mac = arp_ip_to_mac.get(dst_norm)

    # ── Load all route entries ─────────────────────────────────────────────────
    routes_result = await db.execute(
        select(RouteEntry).where(RouteEntry.device_id.in_(accessible_device_ids_subquery(principal)))
    )
    all_routes: list[RouteEntry] = list(routes_result.scalars().all())

    routes_by_dev: dict[str, list[RouteEntry]] = {}
    for r in all_routes:
        routes_by_dev.setdefault(str(r.device_id), []).append(r)

    # ── Determine starting device ──────────────────────────────────────────────
    # Priority 1: src_ip IS a monitored device's mgmt_ip
    # Priority 2: src_ip IS a monitored device's interface address (loopback,
    #             point-to-point link, SVI — anything beyond mgmt_ip)
    # Priority 3: src_ip appears in any device's ARP table (directly connected host)
    # Priority 4: src_ip matches a route on some device — longest prefix, prefer
    #             connected routes and higher prefix lengths (> 0) over defaults
    # Fallback:   use the device with the best route toward dst_ip (src is
    #             outside monitored network)
    start_device: Optional[Device] = None

    if src_norm in dev_by_ip:
        start_device = dev_by_ip[src_norm]
        result.src_located = True
        result.src_device = start_device.display_name

    if start_device is None and src_norm in ip_to_device:
        start_device = ip_to_device[src_norm][0]
        result.src_located = True
        result.src_device = start_device.display_name

    if start_device is None:
        src_arp_devs = arp_ip_to_devs.get(src_norm, [])
        if src_arp_devs:
            start_device = dev_by_id.get(src_arp_devs[0])
            if start_device:
                result.src_located = True
                result.src_device = start_device.display_name

    if start_device is None:
        # Search route tables for src_ip — find the device that owns/routes this address.
        # Prefer connected routes (src is directly attached), then longer prefixes,
        # and only consider specific routes (prefix_len > 0, not default 0.0.0.0/0).
        best_src_dev: Optional[Device] = None
        best_src_len = -1
        best_src_connected = False

        for d in all_devices:
            routes = routes_by_dev.get(str(d.id), [])
            match, _ = _select_route(src_addr, routes, ip_to_device, dev_by_ip)
            if not match:
                continue
            try:
                net = ipaddress.ip_network(match.destination, strict=False)
            except ValueError:
                continue
            if net.prefixlen == 0:
                continue  # skip default routes — not informative for src location
            is_conn = _is_connected(match)
            # connected beats non-connected; longer prefix beats shorter
            if (is_conn and not best_src_connected) or \
               (is_conn == best_src_connected and net.prefixlen > best_src_len):
                best_src_len = net.prefixlen
                best_src_dev = d
                best_src_connected = is_conn

        if best_src_dev:
            start_device = best_src_dev
            result.src_located = True
            result.src_device = best_src_dev.display_name

    if start_device is None:
        # True fallback: src is completely unknown — pick the best device for routing dst.
        # Prefer the device that has the most specific non-default route for dst, then
        # the device with the most routes (likely the core router), then any device.
        best_dst_dev: Optional[Device] = None
        best_dst_len = -1
        best_dst_count = -1

        for d in all_devices:
            routes = routes_by_dev.get(str(d.id), [])
            match, _ = _select_route(dst_addr, routes, ip_to_device, dev_by_ip)
            if not match:
                continue
            try:
                net = ipaddress.ip_network(match.destination, strict=False)
            except ValueError:
                continue
            n_routes = len(routes)
            # rank: (prefix_length, route_count) — more specific and more routing knowledge wins
            if net.prefixlen > best_dst_len or \
               (net.prefixlen == best_dst_len and n_routes > best_dst_count):
                best_dst_len = net.prefixlen
                best_dst_count = n_routes
                best_dst_dev = d

        start_device = best_dst_dev
        result.src_located = False

    if start_device is None:
        result.error = "No monitored device has routing data for this path"
        return result

    if result.src_located:
        better_src_mac = arp_by_dev_ip.get((str(start_device.id), src_norm))
        if better_src_mac:
            result.src_mac = better_src_mac

    # ── L3 hop walk ───────────────────────────────────────────────────────────
    visited_l3: set[str] = set()
    cur_dev = start_device

    for _ in range(MAX_HOPS):
        did = str(cur_dev.id)
        if did in visited_l3:
            result.incomplete = True
            result.incomplete_reason = "loop"
            result.error = "Routing loop detected"
            break
        visited_l3.add(did)

        # If dst_ip is configured directly on this device's own interfaces, the
        # trace ends here regardless of the route table (loopbacks/SVIs aren't
        # always exported as explicit host routes by every platform's MIB).
        owner = ip_to_device.get(dst_norm)
        if owner and str(owner[0].id) == did:
            result.l3_hops.append(L3Hop(
                device_id=did,
                device_name=cur_dev.display_name,
                mgmt_ip=cur_dev.mgmt_ip_str,
                egress_if=owner[1],
                next_hop=None,
                route_prefix=f"{dst_ip}/32" if dst_addr.version == 4 else f"{dst_ip}/128",
                route_protocol="local",
            ))
            result.dst_found = True
            break

        routes = routes_by_dev.get(did, [])
        route, ecmp_count = _select_route(dst_addr, routes, ip_to_device, dev_by_ip)

        if route is None:
            result.incomplete = True
            result.incomplete_reason = "no_route"
            result.dead_end_device = cur_dev.display_name
            result.dead_end_device_id = did
            result.error = f"No route to {dst_ip} on {cur_dev.display_name}"
            break

        hop = L3Hop(
            device_id=did,
            device_name=cur_dev.display_name,
            mgmt_ip=cur_dev.mgmt_ip_str,
            egress_if=route.interface_name,
            next_hop=route.next_hop if route.next_hop else None,
            route_prefix=route.destination,
            route_protocol=route.protocol,
            ecmp_count=ecmp_count if ecmp_count > 1 else None,
        )
        result.l3_hops.append(hop)

        if _is_connected(route):
            # Destination is on a directly connected subnet of this device
            result.dst_found = True
            break

        # Advance to next hop. Resolve via ANY interface address first — this is
        # what lets the trace cross routed point-to-point links and iBGP
        # loopback next-hops — then fall back to mgmt_ip.
        next_hop_norm = _norm_ip(route.next_hop)
        next_dev: Optional[Device] = None
        if next_hop_norm:
            if next_hop_norm in ip_to_device:
                next_dev = ip_to_device[next_hop_norm][0]
            elif next_hop_norm in dev_by_ip:
                next_dev = dev_by_ip[next_hop_norm]

        if next_dev is None:
            # Next hop is not a monitored device — trace ends here (incomplete)
            result.incomplete = True
            result.incomplete_reason = "unmonitored_next_hop"
            break

        if str(next_dev.id) == did:
            # Next-hop resolves back to this same device — can't progress further
            result.incomplete = True
            result.incomplete_reason = "self_loop"
            result.error = f"Route on {cur_dev.display_name} points back to itself"
            break

        cur_dev = next_dev
    else:
        result.incomplete = True
        result.incomplete_reason = "max_hops"
        result.error = "Exceeded maximum hop count"

    if result.dst_found and result.l3_hops:
        better_dst_mac = arp_by_dev_ip.get((result.l3_hops[-1].device_id, dst_norm))
        if better_dst_mac:
            result.dst_mac = better_dst_mac

    # ── L2 trace ──────────────────────────────────────────────────────────────
    # Trace through switches from the last L3 router to the destination host
    dst_mac = result.dst_mac
    if result.dst_found and dst_mac:
        mac_result = await db.execute(
            select(MACEntry).where(MACEntry.device_id.in_(accessible_device_ids_subquery(principal)))
        )
        all_macs: list[MACEntry] = list(mac_result.scalars().all())

        # (device_id, norm_mac) → MACEntry
        mac_map: dict[tuple[str, str], MACEntry] = {}
        for m in all_macs:
            mac_map[(str(m.device_id), _norm_mac(m.mac_address))] = m

        lldp_result = await db.execute(
            select(LLDPNeighbor).where(LLDPNeighbor.device_id.in_(accessible_device_ids_subquery(principal)))
        )
        all_lldp: list[LLDPNeighbor] = list(lldp_result.scalars().all())

        cdp_result = await db.execute(
            select(CDPNeighbor).where(CDPNeighbor.device_id.in_(accessible_device_ids_subquery(principal)))
        )
        all_cdp: list[CDPNeighbor] = list(cdp_result.scalars().all())

        # device_id → port_name → neighbor mgmt_ip
        uplinks: dict[str, dict[str, str]] = {}
        for n in all_lldp:
            if n.remote_mgmt_ip:
                uplinks.setdefault(str(n.device_id), {})[n.local_port_name] = n.remote_mgmt_ip
        for n in all_cdp:
            if n.remote_mgmt_ip:
                uplinks.setdefault(str(n.device_id), {})[n.local_port_name] = n.remote_mgmt_ip

        dst_mac_norm = _norm_mac(dst_mac)
        # Start L2 walk from the last L3 hop device
        l2_start_did = result.l3_hops[-1].device_id if result.l3_hops else str(start_device.id)
        l2_cur = dev_by_id.get(l2_start_did)
        l2_visited: set[str] = set()
        ingress_port: Optional[str] = None

        for _ in range(MAX_HOPS):
            if l2_cur is None:
                break
            l2_did = str(l2_cur.id)
            if l2_did in l2_visited:
                break
            l2_visited.add(l2_did)

            mac_entry = mac_map.get((l2_did, dst_mac_norm))
            if mac_entry is None:
                break

            egress_port = mac_entry.port_name
            l2_hop = L2Hop(
                device_id=l2_did,
                device_name=l2_cur.display_name,
                mgmt_ip=l2_cur.mgmt_ip_str,
                ingress_port=ingress_port,
                egress_port=egress_port,
                vlan=mac_entry.vlan_id,
            )
            result.l2_hops.append(l2_hop)

            # Check if egress port leads to another monitored switch
            neighbor_ip = uplinks.get(l2_did, {}).get(egress_port or "")
            if neighbor_ip:
                next_l2 = dev_by_ip.get(_norm_ip(neighbor_ip) or neighbor_ip)
                if next_l2 and str(next_l2.id) not in l2_visited:
                    ingress_port = uplinks.get(str(next_l2.id), {}).get(l2_cur.mgmt_ip_str)
                    l2_cur = next_l2
                    continue
            # Egress port has no monitored neighbor → host is directly attached here
            break

    return result
