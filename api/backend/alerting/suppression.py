"""Parent-child alert suppression — Tier 1.

Computes a per-cycle map of which device IDs / metric combinations are
suppressed by which parent alert.  The engine consults this map when creating
new alerts (set status='suppressed') and when device_down resolves
(unsuppress dependents).

Suppression rules implemented in this tier:

  1. device_down on device X suppresses all OTHER alerts on X.
     (own-device collateral — interfaces, BGP, OSPF, CPU)

  2. device_down on device X suppresses device_down on devices that are
     topology-downstream of X (via topology_links).  Determined by graph
     traversal where the parent went down before the child.

  3. interface_down on device X for port P suppresses device_down on the
     LLDP/CDP neighbor connected to P.  Catches the "uplink dropped, the
     downstream device went unreachable" pattern.

Future tiers (NOT implemented here):
  - bgp_session_down → route_missing for prefixes from that peer
  - ospf_neighbor down → routes via that neighbor
  - environmental (temp/PSU) → device_down on same device
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class SuppressionMap:
    # device_id → parent_alert_id: the device_down on this device is suppressed
    # because the root cause is the referenced parent alert (topology upstream).
    device_down_parent: dict[str, uuid.UUID] = field(default_factory=dict)

    # device_id → parent_alert_id: any non-device_down alert on this device is
    # suppressed because of the root cause.  Set when the device itself is down
    # (own-device collateral) or when the device is downstream of a parent.
    other_alerts_parent: dict[str, uuid.UUID] = field(default_factory=dict)

    def parent_for(self, device_id: Optional[str], metric: str) -> Optional[uuid.UUID]:
        """Return the parent alert ID that should suppress this breach, if any."""
        if not device_id:
            return None
        if metric == "device_down":
            return self.device_down_parent.get(device_id)
        return self.other_alerts_parent.get(device_id)


async def compute_suppression_map(db: AsyncSession, tenant_id: str) -> SuppressionMap:
    """Build the suppression map for one tenant in one cycle.

    Order matters: own-device first, then topology downstream cascade, then
    interface_down → downstream device.  Earlier rules win — once a device
    is attributed to a parent, later rules don't reattribute it.
    """
    sm = SuppressionMap()

    # ── Load all currently-active device_down alerts (parents for rule 1 + 2) ─
    # Include 'suppressed' status too: a suppressed device_down still represents
    # a device that's currently down — it just means it's NOT the root cause.
    # Excluding suppressed would make the "all my other topology neighbours are
    # also down" check (refined Rule 2) unstable, because as soon as one mesh
    # peer gets suppressed it would fall out of the down set, breaking the
    # cascade for everyone else and causing a flapping unsuppress→suppress loop.
    rows = (await db.execute(text("""
        SELECT a.id, a.device_id, a.triggered_at, a.status
          FROM alerts a
          JOIN alert_rules ar ON ar.id = a.rule_id
         WHERE a.tenant_id = CAST(:tid AS uuid)
           AND ar.metric = 'device_down'
           AND a.status IN ('open','acknowledged','suppressed')
           AND a.device_id IS NOT NULL
         ORDER BY a.triggered_at ASC
    """), {"tid": tenant_id})).fetchall()

    if not rows:
        # Even without device_downs, interface_down → downstream may still apply.
        return await _apply_interface_down_rules(db, tenant_id, sm)

    # device_id → (alert_id, triggered_at) — earliest open device_down per device
    down_devices: dict[str, tuple[uuid.UUID, object]] = {}
    for r in rows:
        did = str(r.device_id)
        if did not in down_devices:
            down_devices[did] = (r.id, r.triggered_at)

    # ── Rule 1: own-device collateral ──────────────────────────────────────
    for did, (aid, _) in down_devices.items():
        sm.other_alerts_parent[did] = aid

    # ── Rule 2: topology downstream cascade ────────────────────────────────
    # Load topology adjacency: undirected edges from topology_links.
    edges = (await db.execute(text("""
        SELECT source_device_id::text AS a, dest_device_id::text AS b
          FROM topology_links
         WHERE tenant_id = CAST(:tid AS uuid)
    """), {"tid": tenant_id})).fetchall()

    adj: dict[str, set[str]] = {}
    for e in edges:
        adj.setdefault(e.a, set()).add(e.b)
        adj.setdefault(e.b, set()).add(e.a)

    # Walk from each down device (sorted by triggered_at ASC) so the earliest
    # failure wins attribution.  A child is downstream of a parent only if:
    #   - it is a topology neighbor of the parent
    #   - it also went down, at or after the parent's triggered_at
    #   - ALL of its other topology neighbors are also currently down
    #     (i.e., no surviving uplink — its failure is genuinely caused by the
    #     loss of upstream connectivity, not an independent failure happening
    #     to coincide in a meshed topology)
    visited: set[str] = set()
    for root_did, (root_aid, root_ts) in sorted(
        down_devices.items(), key=lambda kv: kv[1][1]
    ):
        if root_did in visited:
            continue
        visited.add(root_did)
        queue: list[str] = [root_did]
        while queue:
            cur = queue.pop(0)
            for nb in adj.get(cur, ()):
                if nb in visited or nb not in down_devices:
                    continue
                nb_aid, nb_ts = down_devices[nb]
                if nb_ts < root_ts:
                    # Neighbor failed earlier than the root; don't attribute it.
                    continue
                # Refined check: only attribute as downstream if the neighbour
                # has no surviving uplink.  Every monitored topology neighbour
                # of `nb` must also be in down_devices.
                if any(other not in down_devices for other in adj.get(nb, ())):
                    continue
                visited.add(nb)
                sm.device_down_parent[nb] = root_aid
                sm.other_alerts_parent[nb] = root_aid
                queue.append(nb)

    # ── Rule 3: interface_down → downstream device ─────────────────────────
    return await _apply_interface_down_rules(db, tenant_id, sm)


async def _apply_interface_down_rules(
    db: AsyncSession, tenant_id: str, sm: SuppressionMap
) -> SuppressionMap:
    """For each open interface_down alert on device X port P, find the LLDP/CDP
    neighbor on P and suppress that neighbor's device_down under this interface
    alert — but only if the neighbor isn't already attributed to an earlier
    cause (rule 2 wins over rule 3 because device_down on the upstream device
    is a more fundamental root cause).
    """
    rows = (await db.execute(text("""
        SELECT a.id            AS alert_id,
               a.device_id     AS device_id,
               a.interface_id  AS interface_id,
               i.name          AS local_port_name
          FROM alerts a
          JOIN alert_rules ar ON ar.id = a.rule_id
          JOIN interfaces  i  ON i.id  = a.interface_id
         WHERE a.tenant_id = CAST(:tid AS uuid)
           AND ar.metric = 'interface_down'
           AND a.status IN ('open','acknowledged')
           AND a.interface_id IS NOT NULL
    """), {"tid": tenant_id})).fetchall()

    if not rows:
        return sm

    # Resolve each interface to its remote device via LLDP first, CDP as fallback.
    # remote_mgmt_ip → device_id lookup, scoped to tenant.
    dev_by_ip = {
        str(r.mgmt_ip).split("/")[0]: str(r.id)
        for r in (await db.execute(text("""
            SELECT id, mgmt_ip FROM devices WHERE tenant_id = CAST(:tid AS uuid)
        """), {"tid": tenant_id})).fetchall()
    }

    for r in rows:
        # Find downstream device via LLDP, then CDP.
        remote_ip = (await db.execute(text("""
            SELECT remote_mgmt_ip FROM lldp_neighbors
             WHERE device_id = :did AND local_port_name = :port
             LIMIT 1
        """), {"did": str(r.device_id), "port": r.local_port_name})).scalar_one_or_none()
        if not remote_ip:
            remote_ip = (await db.execute(text("""
                SELECT remote_mgmt_ip FROM cdp_neighbors
                 WHERE device_id = :did AND local_port_name = :port
                 LIMIT 1
            """), {"did": str(r.device_id), "port": r.local_port_name})).scalar_one_or_none()
        if not remote_ip:
            continue
        remote_did = dev_by_ip.get(remote_ip)
        if not remote_did:
            continue
        # Don't reattribute if rule 2 already assigned this neighbor to an earlier root.
        if remote_did in sm.device_down_parent:
            continue
        sm.device_down_parent[remote_did] = r.alert_id
        if remote_did not in sm.other_alerts_parent:
            sm.other_alerts_parent[remote_did] = r.alert_id

    return sm
