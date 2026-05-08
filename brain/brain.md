# Anthrimon — Progress Report & Todo
_Last updated: 2026-05-08 (session 2)_

---

## What's built

### Core infrastructure
- PostgreSQL schema (19 migrations), VictoriaMetrics time-series, systemd services
- SNMP collector (Go) — polls 6 devices, 60s interface cycle, 4× health cycle
- FastAPI backend (Python) — 66+ endpoints, JWT auth, role-based access
- React 19 frontend — Vite, Tailwind, React Query, React Flow

### Polling (collector)
| Data | Status |
|------|--------|
| Interface counters (ifTable/ifXTable) | ✅ |
| Interface IP addresses (ipAddrTable) | ✅ |
| Device health — CPU, memory, uptime, temperature | ✅ |
| LLDP neighbours (IEEE + IETF OID spaces) | ✅ |
| CDP neighbours | ✅ |
| OSPF neighbours (ospfNbrTable) | ✅ |
| ARP table (ipNetToMediaTable) | ✅ |
| MAC forwarding table (dot1dTpFdbTable) | ✅ |
| Routing table (ipCidrRouteTable — connected/static/OSPF) | ✅ |
| Device sysinfo — vendor, OS, platform | ✅ |

### Vendor profiles
| Vendor | Detection | CPU | Memory | Notes |
|--------|-----------|-----|--------|-------|
| Cisco IOS/IOS-XE/IOS-XR/NX-OS | ✅ | ✅ | ✅ | |
| Juniper | ✅ | ✅ | ✅ | |
| Arista EOS | ✅ | ✅ | ✅ | |
| Aruba CX | ✅ | ✅ | ✅ | |
| HP ProCurve / legacy Aruba | ✅ | ✅ | ✅ | HP-ICF MIBs |
| FortiGate | ✅ | ✅ | ✅ | |
| Ubiquiti UniFi / UBNT | ✅ | ✅ | ✅ | UCD-SNMP-MIB |
| Aruba AP (ArubaOS) | ✅ | ✅ | ✅ | WLSX-SYSTEMEXT-MIB |

### Alerting engine
- 15-second eval loop; all metrics below evaluated per rule
- **Metrics**: cpu_util_pct, mem_util_pct, device_down, interface_down, interface_flap, uptime, temperature, interface_errors, custom_oid, **ospf_state** (new)
- Duration gating, flap suppression, severity escalation, correlated suppression
- Re-notify on acknowledged alerts
- Maintenance window suppression (one-time + recurring cron), auto-delete expired windows
- Per-device alert exclusions
- Deduplication via SHA256 fingerprint
- **ospf_state** evaluator: fires when any OSPF neighbour is not `full`, prioritises worst state

### Active alert rules (current tenant)
- CPU high (warn/critical), Memory high, Device Down, Device unreachable
- High CPU - Lab (tag: lab), Interface down, Interface flapping
- Device rebooted (uptime < 300s), Core device rebooted
- **Memory critical (gateway)** — Ubiquiti vendor, >95% for 3min
- **Temperature high** — any device, >65°C for 2min
- **Interface errors accumulating** — >500 errors for 5min

### Notifications
- SMTP delivery (STARTTLS/SSL), password AES-256-GCM encrypted in DB
- Notification channel CRUD + test endpoint
- Channel assignment on alert rules
- Re-notify throttling, resolve notifications

### Administration UI (`/admin`)
- SMTP Server tab — full config, encrypted password, test button
- Notification Channels tab — email channel CRUD, per-channel test

### Maintenance windows
- Per-device from device detail page (one-time + recurring cron)
- Engine suppresses alerts during active windows; amber badge in device list/detail
- Auto-delete expired one-time windows

### L2/L3 visibility
- **Addresses page** (`/addresses`) — cross-device ARP + MAC search by partial MAC/IP
- **Per-device Addresses tab** — scoped ARP + MAC table
- **Neighbours tab** (device detail)
  - LLDP/CDP list with port, system name, mgmt IP, capabilities
  - OSPF section — state badge (green=full, amber=other), inferred from peer if device doesn't expose ospfNbrTable; uses ARP lookup to find correct peer OSPF interface IP
  - Map sub-tab — React Flow radial topology, zoom/pan/drag, per-node popup panel, filter by protocol/type/node, animated selected edges
- **Routes tab** (device detail) — connected (green), OSPF (blue), static (yellow); protocol filter pills
- **Topology page** (`/topology`) — global network map from LLDP/CDP data with force-directed layout; device type popup with links; animated edges on selection

### Credential management
- Assign SNMP credentials to devices with priority ordering
- SNMP diagnostic tool — live GET of standard sysDescr/sysName/sysUpTime/sysLocation/sysContact

### Alert detail page (`/alerts/:id`)
- Severity/status badges, value vs threshold, timeline, device card with link
- **Comment thread** — multi-author, timestamps, Ctrl+Enter to submit, 30s polling

### UI/UX
- **Sidebar** — collapsible (56px icon-only mode), state persisted to localStorage; three collapsible sections: Network, Monitoring, Configuration
- **DeviceTypeIcon** — shared SVG icons (router/switch/AP/firewall/WC/LB/unknown) used in topology nodes, device list, device detail, alert detail
- **Device list** — maintenance amber badge, device type icon
- **Device detail** — Interfaces / Neighbours / Addresses / Routes tabs; maintenance section; credentials section; SNMP diagnostic; settings panel

### Live environment
- **6 devices** polled: coresw.lab.local (Arista), 2920-24-P-01, 2920-48-P-01 (HP ProCurve), UCG-Fiber (Ubiquiti — 94% memory), House-AP-01 (Aruba AP), cxtest
- **OSPF full adjacency**: coresw.lab.local ↔ UCG-Fiber (router-id 10.255.255.255 / link IP 172.16.254.1–2 on Vlan444)
- **12 LLDP neighbours** across the switches
- **45 ARP + 61 MAC** entries across all devices

---

## Todo

### High priority
- [ ] **BGP session state** — waiting on Eve-NG lab setup. Schema exists (`bgp_sessions`). `bgpPeerTable` RFC 1657. Wire when lab is ready.
- [ ] **Alert → channel wiring** — rules have channel_ids UI, but no existing rule has a channel assigned. End-to-end notification not yet proven in prod.
- [ ] **HTML email templates** — currently plain text; coloured severity badges, value vs threshold, link back to alert.

### L2/L3 gaps
- [ ] **VLAN membership** — which ports are in which VLANs, trunk vs access. Cisco: `vtpVlanTable`; HP: proprietary.
- [ ] **STP state** — spanning tree port roles (root/designated/blocked).
- [ ] **Per-interface utilisation alerts** — bandwidth % of link speed; needs VictoriaMetrics query in evaluator.
- [ ] **VLAN-aware MAC table** — HP ProCurve needs per-VLAN community strings (`public@100`).
- [ ] **Interface IP addresses in routing** — `interfaces.ip_addresses` now populated; OSPF inferred IP uses ARP workaround — will improve naturally.

### Platform
- [ ] **Topology → topology_links table** — compute edges into the DB for persistence; currently computed on-the-fly per API request.
- [ ] **User management UI** — currently seed SQL only; create/edit/delete users in admin page.
- [ ] **Overview page alert panel** — top-N open alerts widget on the overview.
- [ ] **Alert detail — rule name link** — currently shows raw rule_id UUID; fetch and display rule name.
- [ ] **Syslog ingest** — passive event collection → alert correlation.
- [ ] **UniFi API collector** — UCG-Fiber REST API gives WAN health, client counts, VPN tunnels. Much richer than SNMP for UniFi gear.

### Polish
- [ ] **UCG-Fiber memory** — at 94%, Memory critical (gateway) rule is now active and will alert if it hits 95%.
- [ ] **Route monitoring** — OSPF route count alert; alert when a specific prefix disappears. Would need a new evaluator using the route_entries table.
- [ ] **Maintenance windows — global admin view** — currently only accessible per-device.
