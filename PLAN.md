# Anthrimon — Master Plan

Anthrimon is a modern, open-source network monitoring and orchestration platform built to exceed the capability and usability of Zabbix, LibreNMS, and Auvik.

**Core pillars:**
- **SNMP monitoring** — deep polling, health metrics, optical power, STP, VLANs, routing
- **Flow monitoring** — NetFlow / sFlow / IPFIX ingestion and analysis
- **Logging** — Syslog ingest, parsing, correlation with alerts
- **Vendor API orchestration** — REST/vendor SDKs for enriched data beyond SNMP
- **Config management** — backup, diff, deploy, compliance auditing
- **Topology** — live L2/L3 maps with clickable links and bandwidth sparklines
- **Remote collectors** — distributed polling with central aggregation (future phase)

---

## Phase 1 — Foundation ✅ Complete

### Infrastructure
- [x] PostgreSQL schema (20+ migrations)
- [x] VictoriaMetrics time-series store
- [x] systemd service units for all components
- [x] FastAPI backend (Python) — 80+ endpoints, JWT auth, RBAC
- [x] React 19 frontend — Vite, Tailwind CSS v4, React Query, React Flow
- [x] API on port 8001

### SNMP Collector (Go)
- [x] Interface counters (ifTable / ifXTable)
- [x] Interface IP addresses (ipAddrTable)
- [x] Device health — CPU, memory, uptime, temperature
- [x] DOM optical power — Tx/Rx dBm via ENTITY-SENSOR-MIB (type 6, watts→dBm)
- [x] LLDP neighbours (IEEE + IETF OID spaces)
- [x] CDP neighbours
- [x] OSPF neighbours (ospfNbrTable)
- [x] ARP table (ipNetToMediaTable)
- [x] MAC forwarding table (dot1dTpFdbTable)
- [x] Routing table (ipCidrRouteTable — connected / static / OSPF)
- [x] VLAN membership (dot1qVlanStaticTable + port bitmaps)
- [x] STP port state + role (dot1dStpPortTable)
- [x] Device sysinfo — vendor, OS, platform detection

### Vendor support
- [x] Cisco IOS / IOS-XE / IOS-XR / NX-OS
- [x] Juniper
- [x] Arista EOS
- [x] Aruba CX
- [x] HP ProCurve / legacy Aruba (HP-ICF MIBs)
- [x] FortiGate
- [x] Ubiquiti UniFi / UBNT
- [x] Aruba AP (ArubaOS / WLSX-SYSTEMEXT-MIB)

---

## Phase 2 — Alerting & Notifications ✅ Complete

### Alert engine
- [x] 15-second evaluation loop
- [x] Metrics: cpu_util_pct, mem_util_pct, device_down, interface_down, interface_flap, uptime, temperature, interface_errors, interface_util_pct, ospf_state, route_missing, custom_oid
- [x] Duration gating, flap suppression, severity escalation
- [x] Correlated suppression (suppress if parent device is down)
- [x] Manual-resolve suppression — suppress re-creation until condition clears
- [x] Re-notify on acknowledged alerts; resolve notifications
- [x] Maintenance window suppression (one-time + recurring cron), auto-delete expired
- [x] Per-device alert exclusions
- [x] Deduplication via SHA256 fingerprint
- [x] Savepoint isolation per rule evaluation
- [x] Storm protection — max new alerts per device per hour
- [x] Stale alert auto-close — housekeeping every ~5 min

### Notifications
- [x] SMTP delivery (STARTTLS/SSL), password AES-256-GCM encrypted
- [x] Notification channel CRUD + per-channel test endpoint
- [x] HTML email templates — stored in DB, live preview editor, variable substitution
- [x] Multipart/alternative (HTML + plain text fallback)
- [x] Global notification pause, business hours gating, storm protection

### Alert rules UI
- [x] Create / edit / delete rules with simple + advanced modes
- [x] Channel assignment, maintenance window assignment per rule
- [x] Enable / disable toggle per rule
- [x] Device scope — all / by vendor / by tag

---

## Phase 3 — L2/L3 Visibility ✅ Complete

- [x] Addresses page — cross-device ARP + MAC search
- [x] Per-device Addresses tab — scoped ARP + MAC
- [x] Neighbours tab — LLDP/CDP list; OSPF section; React Flow radial map
- [x] Routes tab — connected / OSPF / static with protocol filter pills
- [x] VLANs tab — per-VLAN table with tagged/untagged port lists
- [x] STP tab — per-port state and role with colour badges
- [x] Topology page — hierarchical BFS layout, smooth-step edges, stable drag
  - [x] Link panel — Tx/Rx port names, speed, 30-min bandwidth sparkline
  - [x] Topology edges persisted to `topology_links` table

---

## Phase 4 — Administration & UX Polish ✅ Complete

### Admin page (5 tabs)
- [x] Platform — global config (timezone, storm protection, session timeout, etc.)
- [x] SMTP Server — full config, encrypted password, test button
- [x] Notification Channels — email channel CRUD, per-channel test
- [x] Users — create / edit / deactivate / reset-password; role colour badges
- [x] Email Template — split-pane HTML editor + live iframe preview + variable chips

### UI/UX
- [x] Theme system — Light / Dark / System (no flash on load)
- [x] Mobile layout — bottom tab bar + slide-up drawer (viewport < 768px)
- [x] Collapsible sidebar — 56px icon-only mode
- [x] Shared DeviceTypeIcon SVGs (router / switch / AP / firewall / WC / LB)
- [x] Shared TimeSeriesChart — ResizeObserver width, crosshair tooltip
- [x] Interface detail page — bandwidth + errors/discards charts, time range selector
- [x] Device health tab — CPU, memory, uptime, temperature, DOM optical sparklines

### Role-based access control
- [x] Roles: readonly < operator < admin < superadmin
- [x] Guards on all destructive/privileged actions (frontend + API)

---

## Phase 5 — In Progress / Near-term

### Verification
- [x] **Alert → channel end-to-end test** — force a rule to fire and confirm email delivery

### BGP (blocked on Eve-NG lab)
- [ ] BGP session state — `bgpPeerTable` (RFC 1657); schema exists (`bgp_sessions`)
- [ ] BGP session alerts (session down, prefix count change)

### Platform improvements
- [ ] User invite flow — email invite instead of admin-creates-password
- [x] Topology endpoint reads from `topology_links` DB table instead of computing on the fly
- [ ] Overview page — severity breakdown chart alongside top-8 alert panel
- [ ] Route monitoring — UI affordance in alert rules form to pre-fill common prefixes
- [ ] Maintenance windows — show "next fire" time for recurring windows
- [x] arista-test — SNMP credentials fixed, device polling successfully

---

## Phase 6 — Flow Monitoring

Ingest and analyse NetFlow v5/v9, IPFIX, and sFlow from routers and switches.

- [ ] Flow collector daemon (UDP listener, Go)
- [ ] Flow parser — NetFlow v5, NetFlow v9/IPFIX templates, sFlow
- [ ] Flow storage — ClickHouse (already deployed) with per-flow schema
- [ ] Top talkers — src/dst IP, protocol, port; time windowed
- [ ] Interface-level flow breakdown — match flows to ifIndex
- [ ] Flow alerts — bandwidth threshold per src/dst pair or protocol
- [ ] Frontend — flow explorer page, top talkers table, sankey/treemap visualisation
- [ ] Flow rate charts overlaid on interface bandwidth charts

---

## Phase 7 — Syslog Ingest & Correlation

Passive event collection from network devices.

- [ ] Syslog UDP/TCP listener (Go, RFC 3164 + RFC 5424)
- [ ] Parser — severity, facility, device fingerprint by source IP
- [ ] ClickHouse storage — indexed by device, severity, timestamp
- [ ] Frontend — log explorer with full-text search, device filter, severity filter
- [ ] Alert correlation — suppress or annotate alerts when a matching syslog event exists
- [ ] Alert trigger from syslog — regex match on message → create alert

---

## Phase 8 — Vendor API Orchestration

Enrich data beyond what SNMP exposes using vendor REST APIs.

- [ ] UniFi API — UCG-Fiber: WAN health, client counts, VPN tunnels, wireless stats
- [ ] Aruba Central API — AP health, client roaming, RF utilisation
- [ ] FortiGate REST API — VPN tunnels, HA status, policy hit counts
- [ ] Cisco DNA Center / Catalyst Center — device inventory, client health
- [ ] Generic REST poller — configurable endpoint + JSONPath extraction → metrics
- [ ] Frontend — per-device "API data" tab when vendor API is configured

---

## Phase 9 — Config Management

Network device configuration backup, diff, and compliance.

- [ ] Config retrieval — SSH (Netmiko), RESTCONF, vendor APIs per device type
- [ ] Scheduled backups — configurable interval per device
- [ ] Config versioning — store diffs in PostgreSQL, full snapshots in object store
- [ ] Diff viewer — side-by-side HTML diff between any two versions
- [ ] Compliance rules — regex/template-based checks (e.g. "NTP must be configured")
- [ ] Compliance report — per-device pass/fail with remediation hints
- [ ] Config deploy — push a config snippet or full config via SSH/RESTCONF
- [ ] Change alerts — notify when a running config changes unexpectedly
- [ ] Frontend — config history timeline, diff viewer, compliance dashboard

---

## Phase 10 — Remote Collectors

Distributed polling with a central aggregation hub.

- [ ] Collector agent — lightweight Go binary, runs SNMP + flow + syslog collection
- [ ] Collector registration — API key auth, heartbeat, capability advertisement
- [ ] Encrypted tunnel — mTLS or WireGuard between collector and hub
- [ ] Task dispatch — hub assigns devices to collectors based on reachability / region
- [ ] Metric forwarding — collector pushes to central VictoriaMetrics via remote write
- [ ] Collector health monitoring — latency, queue depth, last-seen; alert if collector goes dark
- [ ] Frontend — collector map, per-collector device list, health dashboard

---

## Longer-term / Deferred

- Baseline-aware alerting — alert when a metric deviates from learned normal
- Multi-condition alert rules — CPU > 80% AND memory > 85%
- Per-device alert threshold overrides UI (two-tier policy model)
- IS-IS neighbour and topology collection
- BGP full-table analysis (prefix counts, path changes)
- DOM Tx bias current and voltage collection
- DOM support for non-Arista vendors
- SSO / SAML / OIDC authentication
- API rate limiting and audit log
- Production build + Nginx serving + Docker Compose
- Helm chart / Kubernetes deployment option
- Public documentation site
