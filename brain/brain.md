# Anthrimon — Progress Report & Todo
_Last updated: 2026-05-09 (session 3)_

---

## What's built

### Core infrastructure
- PostgreSQL schema (20 migrations), VictoriaMetrics time-series, systemd services
- SNMP collector (Go) — polls 7 devices, 60s interface cycle, 5× health cycle
- FastAPI backend (Python) — 70+ endpoints, JWT auth, role-based access
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
| **VLAN membership** (dot1qVlanStaticTable + port bitmaps) | ✅ |
| **STP port state + role** (dot1dStpPortTable) | ✅ |

### Vendor profiles
| Vendor | Detection | CPU | Memory | Uptime | Notes |
|--------|-----------|-----|--------|--------|-------|
| Cisco IOS/IOS-XE/IOS-XR/NX-OS | ✅ | ✅ | ✅ | sysUpTime | |
| Juniper | ✅ | ✅ | ✅ | sysUpTime | |
| Arista EOS | ✅ | ✅ | ✅ | sysUpTime | |
| Aruba CX | ✅ | ✅ | ✅ | **hrSystemUptime** | sysUpTime resets on agent restart; hrSystemUptime fixed this |
| HP ProCurve / legacy Aruba | ✅ | ✅ | ✅ | sysUpTime | HP-ICF MIBs |
| FortiGate | ✅ | ✅ | ✅ | sysUpTime | |
| Ubiquiti UniFi / UBNT | ✅ | ✅ | ✅ | sysUpTime | UCD-SNMP-MIB |
| Aruba AP (ArubaOS) | ✅ | ✅ | ✅ | sysUpTime | WLSX-SYSTEMEXT-MIB |

### Alerting engine
- 15-second eval loop; all metrics below evaluated per rule
- **Metrics**: cpu_util_pct, mem_util_pct, device_down, interface_down, interface_flap, uptime, temperature, interface_errors, interface_util_pct, custom_oid, ospf_state
- Duration gating, flap suppression, severity escalation, correlated suppression
- Re-notify on acknowledged alerts; resolve notifications
- Maintenance window suppression (one-time + recurring cron), auto-delete expired windows
- Per-device alert exclusions
- Deduplication via SHA256 fingerprint
- **Savepoint isolation** — each rule evaluates in its own DB savepoint; a failing rule no longer rolls back the entire cycle
- **Manual-resolve suppression** — resolving an active-condition alert suppresses re-creation until the condition actually clears, then re-fires on next breach
- **interface_errors** evaluator uses VictoriaMetrics `increase(errors[5m])` (columns never existed in postgres)
- **interface_util_pct** evaluator uses VictoriaMetrics `rate(octets[5m]) * 8 / speed_bps * 100`, reports max(in, out) per interface

### Active alert rules (current tenant)
- CPU high (warn/critical), Memory high, Device Down, Device unreachable
- High CPU - Lab (tag: lab), Interface down, Interface flapping
- Device rebooted (uptime < 300s), Core device rebooted
- Memory critical (gateway) — Ubiquiti vendor, >95% for 3min
- Temperature high — any device, >65°C for 2min
- Interface errors accumulating — >500 errors for 5min

### Notifications
- SMTP delivery (STARTTLS/SSL), password AES-256-GCM encrypted in DB
- Notification channel CRUD + test endpoint
- Channel assignment on alert rules
- Re-notify throttling, resolve notifications
- **Notification dispatch moved after db.commit()** — emails never sent for rolled-back alert creations; uses own session (no greenlet conflict)

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
  - OSPF section — state badge (green=full, amber=other), inferred from peer; uses ARP lookup for correct peer IP
  - Map sub-tab — React Flow radial topology, zoom/pan/drag, per-node popup panel, filter by protocol/type/node, animated selected edges
- **Routes tab** (device detail) — connected (green), OSPF (blue), static (yellow); protocol filter pills
- **VLANs tab** (device detail) — per-VLAN table with tagged/untagged port lists; populated from Q-BRIDGE-MIB
- **STP tab** (device detail) — per-port state (forwarding/blocking/etc) and role (root/designated/alternate/backup) with colour badges
- **Topology page** (`/topology`) — hierarchical BFS layout (core→distribution→access), smooth-step edges with 4-handle nodes, stable drag positions; LLDP/CDP data; device type popup; animated edges on selection

### Credential management
- Assign SNMP credentials to devices with priority ordering
- SNMP diagnostic tool — live GET of standard sysDescr/sysName/sysUpTime/sysLocation/sysContact

### Alert detail page (`/alerts/:id`)
- Severity/status badges, value vs threshold, timeline, device card with link
- Comment thread — multi-author, timestamps, Ctrl+Enter to submit, 30s polling

### UI/UX
- **Sidebar** — collapsible (56px icon-only mode), state persisted to localStorage
- **DeviceTypeIcon** — shared SVG icons (router/switch/AP/firewall/WC/LB/unknown)
- **Device list** — maintenance amber badge, device type icon
- **Device detail** — Interfaces / Neighbours / Addresses / Routes / VLANs / STP tabs; maintenance; credentials; SNMP diagnostic; settings

### Live environment
- **7 devices** polled: coresw.lab.local (Arista), 2920-24-P-01, 2920-48-P-01 (HP ProCurve), UCG-Fiber (Ubiquiti), House-AP-01 (Aruba AP), cxtest (Aruba CX), arista-test
- **arista-test** — stale (no SNMP response for 20+ hours); open `device_down` alert
- **cxtest** — Aruba CX switch; sysUpTime was resetting every ~2min (SNMP agent restarts); fixed with hrSystemUptime in vendor profile
- **OSPF full adjacency**: coresw.lab.local ↔ UCG-Fiber

---

## Todo

### High priority
- [ ] **BGP session state** — waiting on Eve-NG lab. Schema exists (`bgp_sessions`). `bgpPeerTable` RFC 1657.
- [ ] **Alert → channel end-to-end** — SMTP configured but Gmail 535 auth error (need App Password). Once fixed, verify a rule fires and email arrives.
- [ ] **HTML email templates** — currently plain text; coloured severity badges, value vs threshold, link back to alert.

### L2/L3 gaps
- [ ] **VLAN-aware MAC table** — HP ProCurve needs per-VLAN community strings (`public@100`); requires credential system changes. Deferred.
- [ ] **Interface IP addresses in routing** — OSPF inferred IP uses ARP workaround; will improve naturally as ip_addresses populates.

### Platform
- [ ] **User management UI** — seed SQL only; create/edit/delete users in admin page.
- [ ] **Overview page alert panel** — top-N open alerts widget on the overview.
- [ ] **Alert detail — rule name link** — shows raw rule_id UUID; fetch and display rule name.
- [ ] **Topology → topology_links table** — persist edges to DB; currently computed on-the-fly.
- [ ] **Syslog ingest** — passive event collection → alert correlation.
- [ ] **UniFi API collector** — UCG-Fiber REST API for WAN health, client counts, VPN tunnels.

### Polish
- [ ] **Route monitoring** — alert when a specific prefix disappears; new evaluator using route_entries.
- [ ] **Maintenance windows — global admin view** — currently only accessible per-device.
- [ ] **arista-test cleanup** — either fix SNMP or remove from polling; been unreachable for 20+ hours.
