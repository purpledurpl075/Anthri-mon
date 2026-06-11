<div align="center">
  <img src="https://raw.githubusercontent.com/purpledurpl075/Anthri-mon/main/logos/05-banner-hero.svg"
       alt="Anthrimon — Network Monitoring Platform" width="100%">
</div>

<br>

<div align="center">

[![Ubuntu](https://img.shields.io/badge/Ubuntu-22.04%20|%2024.04-E95420?style=flat-square&logo=ubuntu&logoColor=white)](https://ubuntu.com)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![Go](https://img.shields.io/badge/Go-1.22-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://postgresql.org)
[![ClickHouse](https://img.shields.io/badge/ClickHouse-26.x-FFCC01?style=flat-square&logo=clickhouse&logoColor=black)](https://clickhouse.com)
[![WireGuard](https://img.shields.io/badge/WireGuard-VPN-88171A?style=flat-square&logo=wireguard&logoColor=white)](https://wireguard.com)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-5cb85c?style=flat-square)](LICENSE)

</div>

<br>

<p align="center">
  Self-hosted network monitoring — deep SNMP polling, NetFlow/sFlow analysis, syslog ingest,<br>
  SNMP traps, config management, alerting, topology mapping, and distributed remote collectors.
</p>

---

## Features

| | Capability | Details |
|:---:|:---|:---|
| 📡 | **SNMP monitoring** | Interface counters · CPU/memory/temperature/uptime · DOM optical power · ARP/MAC · LLDP/CDP neighbors · OSPF · IS-IS · STP · VLANs · routing table · BGP |
| 🌊 | **Flow monitoring** | NetFlow v5/v9, IPFIX, sFlow v5 — top talkers, protocol breakdown, per-interface analysis, flow alerts |
| 📋 | **Syslog** | RFC 3164 + RFC 5424 · UDP/TCP :514 · severity breakdown · pattern-match alerts · alert correlation |
| 🪤 | **SNMP traps** | v1/v2c/v3 authPriv · vendor-aware classification · hub and remote-site collection · automatic v3 key push |
| ⚙️ | **Config management** | SSH backup · diff viewer · compliance policies · multi-device deploy with template variables |
| 🔔 | **Alerting** | 15-second evaluation · 16 metric types · email/Slack/PagerDuty/Teams · maintenance windows · syslog correlation |
| 🗺️ | **Topology** | Live L2/L3 map from LLDP/CDP · bandwidth sparklines · persistent layout |
| 🛰️ | **Remote collectors** | WireGuard-tunnelled distributed polling — SNMP, flow, syslog, and trap collection at remote sites |
| 🖥️ | **Dashboard** | Customizable overview · drag-to-reorder widgets · dark mode · mobile layout |

**Vendor support** — Arista EOS · Cisco IOS/IOS-XE/IOS-XR/NX-OS · Juniper · Aruba CX · HP ProCurve · FortiGate · Ubiquiti UniFi · Aruba AP

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <a href="https://github.com/user-attachments/assets/5e5bb9e7-3ce4-4724-bd35-4cb1be5e49c4" target="_blank">
        <img src="https://github.com/user-attachments/assets/5e5bb9e7-3ce4-4724-bd35-4cb1be5e49c4" alt="Overview dashboard" width="100%">
      </a>
      <br><sub><b>Overview dashboard</b></sub>
    </td>
    <td align="center" width="50%">
      <a href="https://github.com/user-attachments/assets/7e5b331e-880f-4a92-b959-3ed839b3f9a4" target="_blank">
        <img src="https://github.com/user-attachments/assets/7e5b331e-880f-4a92-b959-3ed839b3f9a4" alt="Topology" width="100%">
      </a>
      <br><sub><b>Topology</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/40c44dd3-77b1-420a-975f-86b50a88b423" target="_blank">
        <img src="https://github.com/user-attachments/assets/40c44dd3-77b1-420a-975f-86b50a88b423" alt="Syslog" width="100%">
      </a>
      <br><sub><b>Syslog</b></sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/32711003-dc57-4f34-bfac-c9c929ae4803" target="_blank">
        <img src="https://github.com/user-attachments/assets/32711003-dc57-4f34-bfac-c9c929ae4803" alt="Flow monitoring" width="100%">
      </a>
      <br><sub><b>Flow monitoring</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/872a551c-7090-4cda-bc7e-7a048e23293b" target="_blank">
        <img src="https://github.com/user-attachments/assets/872a551c-7090-4cda-bc7e-7a048e23293b" alt="MAC and ARP Search" width="100%">
      </a>
      <br><sub><b>MAC &amp; ARP Search</b></sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/8915293a-bb42-488b-9d0f-9ece5424958f" target="_blank">
        <img src="https://github.com/user-attachments/assets/8915293a-bb42-488b-9d0f-9ece5424958f" alt="Device Health Metrics" width="100%">
      </a>
      <br><sub><b>Device Health Metrics</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <a href="https://github.com/user-attachments/assets/68de9a97-1a2e-4cb3-b8ed-0fe2820e958e" target="_blank">
        <img src="https://github.com/user-attachments/assets/68de9a97-1a2e-4cb3-b8ed-0fe2820e958e" alt="Configuration Management and Compliance" width="100%">
      </a>
      <br><sub><b>Configuration Management &amp; Compliance</b></sub>
    </td>
  </tr>
</table>

---

## Requirements

- Ubuntu 22.04 or 24.04 LTS (bare metal or VM)
- 2+ CPU cores · 4 GB RAM minimum (8 GB recommended)
- Outbound internet access for the installer

---

## Installation

```bash
git clone https://github.com/purpledurpl075/Anthri-mon.git
cd Anthri-mon
sudo bash infra/scripts/install.sh
```

The installer prompts for:

| Setting | Default | Notes |
|---|---|---|
| PostgreSQL role | `anthrimon` | |
| PostgreSQL database | `anthrimon` | |
| Database password | *(random)* | Leave blank to auto-generate |
| Public base URL | `https://<IP>` | Used in alert emails and collector configs |
| NetFlow/IPFIX port | `2055` | UDP |
| sFlow port | `6343` | UDP |

It installs all dependencies, creates the database, runs all migrations, builds all Go collectors and the React frontend, generates TLS certificates, configures nginx with HTTPS, sets up the WireGuard hub interface, and registers all systemd services.

### First login

Navigate to `https://<your-server-ip>/` and sign in with the default superadmin account:

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `admin` |

> **Change this password immediately** after first login — **Administration → Users**.

---

## Architecture

```
                    HTTPS :443
Browser ──────────────────────────▶ nginx ──▶ dist/ (React SPA)
                                          └──▶ :8001 (FastAPI)
                                                    │
                              ┌─────────────────────┼─────────────────────┐
                              ▼                     ▼                     ▼
                        PostgreSQL          VictoriaMetrics           ClickHouse
                      (alerts, cfg)          (SNMP metrics)     (flows, syslog, traps)

Network devices (hub site)
  SNMP polling  ◀────── snmp-collector (Go)
  NetFlow/sFlow ───────▶ flow-collector (Go)             :2055 / :6343
  Syslog        ───────▶ syslog-collector (Go)           :514 UDP/TCP
  SNMP traps    ───────▶ snmptrapd + anthrimon-traphandler  :162 UDP

Remote sites (WireGuard tunnel 10.100.0.0/24)
  wg0: 10.100.0.1 ◀──── anthrimon-collector (Go)          SNMP + flow + syslog + trap forwarding
                   ◀──── snmptrapd + anthrimon-traphandler traps from local devices
```

---

## Stack

| Component | Technology |
|---|---|
| API | Python 3.12 · FastAPI · SQLAlchemy · uvicorn |
| Frontend | React 19 · Vite · Tailwind CSS v4 · React Query |
| Time-series | VictoriaMetrics |
| Flow/Syslog/Trap storage | ClickHouse |
| Relational DB | PostgreSQL 14 |
| SNMP collector | Go 1.22 |
| Flow collector | Go 1.22 — NetFlow v5/v9, IPFIX, sFlow v5 |
| Syslog collector | Go 1.22 — RFC 3164 + RFC 5424 |
| Hub trap receiver | net-snmp `snmptrapd` (:162) → `anthrimon-traphandler` (Go) |
| Remote collector | Go 1.22 — SNMP + flow + syslog + trap forwarding |
| Trap handler | Go 1.22 — snmptrapd exec handler (hub + remote sites) |
| Reverse proxy | nginx — HTTPS with self-signed CA |
| VPN | WireGuard — remote collector tunnels |

---

## Services

```bash
systemctl status anthrimon-api            # FastAPI backend (127.0.0.1:8001)
systemctl status snmp-collector           # SNMP polling daemon
systemctl status flow-collector           # NetFlow/sFlow listener (:2055, :6343)
systemctl status syslog-collector         # Syslog listener (:514 UDP/TCP)
systemctl status snmptrapd                # SNMP trap receiver (:162 UDP) → anthrimon-traphandler
systemctl status nginx                    # HTTPS frontend + API proxy (:443)
systemctl status victoria-metrics         # Time-series store (:8428)
systemctl status clickhouse-server        # Flow/syslog/trap analytics store
systemctl status postgresql               # Relational database
systemctl status wg-quick@wg0             # WireGuard hub interface
```

---

## Ports

| Port | Protocol | Required | Purpose |
|:---:|:---:|:---:|---|
| 443 | TCP | Yes | HTTPS — dashboard and API |
| 162 | UDP | Configurable | SNMP traps from network devices |
| 51820 | UDP | Remote collectors only | WireGuard VPN tunnel |
| 2055 | UDP | Configurable | NetFlow v5/v9 / IPFIX from network devices |
| 6343 | UDP | Configurable | sFlow from network devices |
| 514 | UDP + TCP | Configurable | Syslog from network devices |

The API (:8001), VictoriaMetrics (:8428), ClickHouse (:8123/:9000), and PostgreSQL (:5432) bind to localhost only and are not exposed externally.

---

## Remote Collectors

For devices at remote sites that can't reach the hub directly, deploy a lightweight collector binary that tunnels home over WireGuard. The remote collector also runs `snmptrapd` for local trap collection — the trap handler binary and SNMPv3 keys are pushed automatically from the hub.

**Register a collector** — in the Anthrimon UI:

1. Go to **Configuration → Collectors → New collector**
2. Complete the setup wizard and download the deployment package
3. On the remote server:

```bash
unzip anthrimon-remote-collector-linux-amd64.zip
sudo bash install.sh
```

The install script installs `wireguard-tools` and `snmptrapd`, copies the binary, config, and hub CA cert, configures capability overrides for port 162 binding, and starts `anthrimon-collector.service`. The collector self-registers over HTTPS, establishes the WireGuard tunnel, downloads the trap handler binary, and appears **online** in the UI within seconds.

---

## TLS

The installer generates a self-signed CA and server certificate. The CA cert lives at `/etc/anthrimon/tls/ca.crt`.

**Add to your browser** (removes the security warning):

```bash
scp <server>:/etc/anthrimon/tls/ca.crt ~/anthrimon-ca.crt
# macOS:   open ~/anthrimon-ca.crt → trust for all users
# Linux:   sudo cp ~/anthrimon-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
# Windows: double-click → Install → Trusted Root Certification Authorities
```

**Renew the server certificate** (CA is preserved, valid 2 years):

```bash
sudo bash scripts/setup-tls.sh
```

---

## Upgrading

```bash
git pull
sudo bash infra/scripts/install.sh
```

The installer is idempotent — it skips steps already complete (existing CA, existing WireGuard config, already-applied migrations).

---

## Disk Space

Rough estimates for 90-day retention defaults:

| Data type | Per device/day | 10 devices, 90 days |
|---|---|---|
| SNMP metrics (VictoriaMetrics) | ~5 MB | ~4.5 GB |
| Flow records (ClickHouse) | ~50 MB at 1k flows/s | varies greatly |
| Syslog (ClickHouse) | ~10 MB | ~9 GB |
| Config backups (PostgreSQL) | ~100 KB/backup | negligible |

Flow data dominates. A quiet network exporting at 1,000 flows/second averages ~4 GB/day in ClickHouse. Reduce the ClickHouse TTL from the default 90 days in **Administration → Data** if disk is constrained.

VictoriaMetrics compresses time-series data aggressively — real usage is typically 30–50% lower than the estimate above.

---

<details>
<summary><b>Project layout</b></summary>

```
collectors/
  snmp/           Go SNMP polling daemon
  flow/           Go NetFlow/sFlow collector
  syslog/         Go syslog collector
  remote/
    cmd/
      remote-collector/   Remote collector agent (WireGuard + SNMP + flow + syslog + trap forwarding)
      trap-handler/       snmptrapd exec handler (deployed to remote sites)
      trap-receiver/      Standalone UDP trap receiver (legacy — hub now uses snmptrapd)
api/
  backend/
    routers/      FastAPI endpoints
    models/       SQLAlchemy models
    alerting/     Alert engine + evaluators
    configmgmt/   Config backup/deploy engine
frontend/
  dashboard/      React 19 + Vite frontend
storage/
  migrations/
    postgres/     PostgreSQL schema migrations
    clickhouse/   ClickHouse schema migrations
logos/            Branding assets (SVG)
infra/
  scripts/
    install.sh         Full installer — prompts for config, installs everything
    setup-tls.sh       Generate self-signed CA + server cert, configure nginx HTTPS
    setup-wireguard.sh Set up WireGuard hub interface (wg0, 10.100.0.1/24)
```

</details>

---

## Documentation

- **[API Reference](https://purpledurpl075.github.io/Anthri-mon/)** — interactive endpoint browser with request/response schemas, generated from the running API's OpenAPI 3.1 spec (190 endpoints)
- **[Wiki](WIKI.md)** — operator guide for SNMP, flow, syslog, alerts, config management, topology

## Contributing

Bug reports, feature requests, and pull requests are all welcome.

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to get a dev environment, code style, PR process, DCO sign-off
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — Contributor Covenant 2.1
- **[SECURITY.md](SECURITY.md)** — how to report vulnerabilities privately

## License

Anthrimon is licensed under the [Apache License 2.0](LICENSE). Third-party dependencies are listed in [NOTICE](NOTICE).

---

<div align="center">
  <img src="https://raw.githubusercontent.com/purpledurpl075/Anthri-mon/main/logos/04-icon-favicon.svg"
       alt="Anthrimon" width="56">
  <br><br>
  <sub>Apache License 2.0</sub>
</div>
