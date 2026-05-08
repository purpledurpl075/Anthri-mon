# Anthrimon — Progress Report & Todo
_Last updated: 2026-05-08_

---

## What's built

### Core infrastructure
- PostgreSQL schema (15 migrations), VictoriaMetrics time-series, systemd services
- SNMP collector (Go) — polls 6 devices, 60s interface cycle, 4× health cycle
- FastAPI backend (Python) — 53+ endpoints, JWT auth, role-based access
- React 19 frontend — Vite, Tailwind, React Query, React Flow

### Polling
| Data | Status |
|------|--------|
| Interface counters (ifTable/ifXTable) | ✅ |
| Device health — CPU, memory, uptime, temperature | ✅ |
| LLDP neighbours (IEEE + IETF OID spaces) | ✅ |
| CDP neighbours | ✅ |
| OSPF neighbours (ospfNbrTable) | ✅ |
| ARP table (ipNetToMediaTable) | ✅ |
| MAC forwarding table (dot1dTpFdbTable) | ✅ |
| Device sysinfo — vendor, OS, platform | ✅ |

### Vendor profiles
| Vendor | CPU | Memory | Notes |
|--------|-----|--------|-------|
| Cisco IOS/IOS-XE/IOS-XR/NX-OS | ✅ | ✅ | |
| Juniper | ✅ | ✅ | |
| Arista EOS | ✅ | ✅ | |
| Aruba CX | ✅ | ✅ | |
| HP ProCurve / legacy Aruba | ✅ | ✅ | HP-ICF MIBs |
| FortiGate | ✅ | ✅ | |
| Ubiquiti UniFi / UBNT | ✅ | ✅ | UCD-SNMP-MIB (ssCpuIdle, memTotalReal/memAvailReal) |

### Alerting engine
- 15-second eval loop
- Metrics: CPU, memory, device_down, interface_down, interface_flap, uptime, temperature, interface_errors, custom OID
- Duration gating, flap suppression (stable_for_seconds), severity escalation
- Correlated suppression (suppress if parent device down)
- Per-device alert exclusions (metrics + interface IDs)
- Re-notify on acknowledged alerts
- Deduplication via SHA256 fingerprint
- Two built-in rule sets: Device Down, Device Rebooted (uptime < 300s)

**Bug fixed:** `parent_device_id` was queried from `devices` table (doesn't exist there — it's on `alert_rules`), causing all rule evaluations to silently fail. Also fixed `tags ?|` asyncpg type inference failure.

### Notifications
- SMTP delivery (STARTTLS + SSL), password encrypted at rest (AES-256-GCM)
- Notification channel CRUD + per-channel test endpoint
- Channel assignment on alert rules (channel_ids JSONB)
- Re-notify throttling (renotify_seconds)
- Resolve notifications (notify_on_resolve)

### Administration UI (`/admin`)
- SMTP Server tab — host, port, user, password (AES-256 encrypted, never returned to client), from address, SSL toggle, send test
- Notification Channels tab — create/edit/delete email channels, assign to alert rules

### Maintenance windows
- Create/delete from device detail page
- One-time (datetime picker) and recurring (cron expression)
- Engine suppresses alerts during active windows
- Amber "In maintenance" badge in device list and device detail header
- One-time windows auto-deleted by engine after expiry

### L2/L3 visibility
- **Addresses page** (`/addresses`) — global ARP + MAC table search across all devices
  - Debounced search by partial MAC or IP
  - Device dropdown filter, ARP/MAC type toggle
  - Device column links back to device detail
- **Per-device Addresses tab** — same data scoped to one device
- **Neighbours tab** (device detail)
  - LLDP list: local port → remote system, port, mgmt IP, capabilities
  - CDP list: local port → remote device, port, IP, platform, duplex, VLAN
  - OSPF list: state badge (green=full, amber=other), router ID, neighbour IP, area, last state change
  - Inferred OSPF: devices whose SNMP doesn't expose ospfNbrTable are shown via peer reports ("seen from peer" label)
  - Map tab: React Flow radial topology, zoom/pan/drag, node hide/show by protocol/type/name, straight edges from node centres, SVG device-type icons

### Credential management
- Assign SNMP credentials to devices with priority ordering
- SNMP diagnostic tool: live GET of sysDescr/sysName/sysUpTime/sysLocation/sysContact

### Device intelligence
- Device type inference from vendor profile
- Tags, alert exclusions, per-device override rules
- FQDN resolution from sysName

---

## Live environment
- 6 devices polled: coresw.lab.local (Arista), 2920-24-P-01, 2920-48-P-01 (HP ProCurve), UCG-Fiber (Ubiquiti), 2× others
- OSPF full adjacency: coresw.lab.local ↔ UCG-Fiber (10.255.255.255 / 172.16.254.1)
- UCG-Fiber: 5% CPU, ~94% memory used (2.7/2.9 GB) — worth alerting on

---

## Todo

### High priority
- [ ] **Alert rules UI — channel assignment** — `channel_ids` field is in the DB and UI picker exists, but no alerts have channels wired yet; end-to-end notification not proven
- [ ] **HTML email templates** — currently plain text; coloured severity badges, device name, value vs threshold, link back to alert
- [ ] **Alert detail page** — clicking an alert shows a row, no drill-down view
- [ ] **Baseline deviation evaluator** — `baseline_enabled` / `baseline_deviation_pct` fields exist on rules, evaluator never written; would use VictoriaMetrics historical avg

### L2/L3 gaps
- [ ] **VLAN membership** — which ports are in which VLANs, trunk vs access. Cisco: `vtpVlanTable`; HP: proprietary. High value for enterprise.
- [ ] **STP state** — spanning tree port roles (root/designated/blocked). Essential for understanding inactive ports.
- [ ] **BGP session state** — `bgp_sessions` table already in schema, nothing collecting. `bgpPeerTable` (RFC 1657). Critical for Eve-NG labs.
- [ ] **Routing table** — `ipCidrRouteTable` / `inetCidrRouteTable`. Connected/static/OSPF/BGP prefixes.
- [ ] **Interface IP addresses** — `ipAddrTable` to populate `interfaces.ip_addresses` JSONB
- [ ] **VLAN-aware MAC table** — HP ProCurve needs per-VLAN community strings (`public@100`)
- [ ] **Per-interface utilisation alerts** — bandwidth % of link speed; needs VictoriaMetrics query in evaluator

### Platform
- [ ] **Topology map (global)** — `topology_links` table is in schema, sidebar has "Topology" as "Coming soon". Needs LLDP/CDP data to be computed into graph edges.
- [ ] **BGP/OSPF alerting metrics** — `eval_ospf_neighbour()` evaluator for state != full
- [ ] **UniFi Network API collector** — REST API on UCG gives WAN health, client counts per AP/SSID, VPN tunnel state. Much richer than SNMP for UniFi gear.
- [ ] **User management UI** — currently seed SQL only; need create/edit/delete users page in admin
- [ ] **Syslog ingest** — passive event collection → alert correlation

### Polish
- [ ] **UCG-Fiber memory alert** — 94% memory usage, no alert rule targeting it yet
- [ ] **Maintenance windows in Admin page** — currently only accessible per-device; global view would help ops
- [ ] **Overview page alert panel** — "top N open alerts" widget front and centre
- [ ] Debug logging removed from address table poll (done) but health multiplier could be tuned down for more frequent address updates
