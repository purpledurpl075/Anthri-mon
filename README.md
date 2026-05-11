# Anthri-mon
Next Generation Open-Source Network Monitor

## Requirements

- Ubuntu 22.04 or 24.04 LTS
- Go 1.22+
- Node.js 20.x
- Python 3.12
- PostgreSQL 14
- ClickHouse
- VictoriaMetrics

## First-time setup

Run the installer as root. It installs all dependencies, creates the database, runs migrations, and registers systemd services.

```bash
sudo bash infra/scripts/install-dev.sh
```

Then seed the default admin user:

```bash
sudo -u postgres psql -d anthrimon < storage/migrations/postgres/seed_admin.sql
```

Default login: **admin / admin** — change it after first login.

## Services

All backend services are managed by systemd after installation.

| Service | Command |
|---------|---------|
| API | `sudo systemctl start anthrimon-api` |
| SNMP collector | `sudo systemctl start snmp-collector` |
| VictoriaMetrics | `sudo systemctl start victoria-metrics` |
| ClickHouse | `sudo systemctl start clickhouse-server` |
| PostgreSQL | `sudo systemctl start postgresql` |

Check status of all services:

```bash
sudo systemctl status anthrimon-api snmp-collector victoria-metrics clickhouse-server postgresql
```

View live collector logs:

```bash
journalctl -u snmp-collector -f
```

## Frontend (dev)

The frontend is a Vite dev server during development. Start it with:

```bash
./dev-frontend.sh
```

Accessible at `http://<server-ip>:5173`.

> **Note:** Production deployments should use `npm run build` inside `frontend/dashboard` and serve the output with Nginx.

## Collector config

The SNMP collector is configured at `collectors/snmp/snmp-collector.yaml`.

Key settings:

```yaml
database:
  dsn: "postgres://anthrimon:changeme@127.0.0.1/anthrimon?sslmode=disable"

polling:
  default_interval_s: 15      # how often to poll interfaces
  health_multiplier: 1        # health polls every N × default_interval_s
  device_refresh_s: 30        # how often to pull updated device list from DB

metrics:
  victoriametrics_url: "http://localhost:8428"
```

After editing the config, restart the collector:

```bash
sudo systemctl restart snmp-collector
```

## Rebuilding the SNMP collector

The SNMP collector is a Go binary. Rebuild after any changes to the `collectors/snmp` source:

```bash
cd collectors/snmp
go build -o snmp-collector ./cmd/snmp-collector/
sudo systemctl restart snmp-collector
```

## API

- API base: `http://<server-ip>:8001/api/v1`
- Swagger docs: `http://<server-ip>:8001/api/docs`

The API runs on port **8001** (port 8000 is reserved to avoid conflicts with other services that commonly bind there).

The API uses a Python virtualenv at `api/.venv`. To work with it directly:

```bash
source api/.venv/bin/activate
```

## Access

| Service | URL |
|---------|-----|
| Dashboard | `http://<server-ip>:5173` (dev) |
| API | `http://<server-ip>:8001` |
| API docs | `http://<server-ip>:8001/api/docs` |
| VictoriaMetrics | `http://<server-ip>:8428` |

> **Port note:** If port 8001 conflicts with something on your host, change `--port 8001` in `/etc/systemd/system/anthrimon-api.service`, update the `proxy` target in `frontend/dashboard/vite.config.ts` to match, then `sudo systemctl daemon-reload && sudo systemctl restart anthrimon-api`.
