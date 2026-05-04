#!/usr/bin/env bash
# Anthrimon — developer environment installer
# Targets Ubuntu 22.04 / 24.04 LTS (bare metal or VM)
# Usage: sudo bash infra/scripts/install-dev.sh
#
# What this script does:
#   1. Installs system packages
#   2. Installs Go 1.22.3
#   3. Installs Node.js 20.x (via NodeSource)
#   4. Installs Python 3.10 packages (pip, venv) + project requirements
#   5. Installs PostgreSQL 14 and creates the anthrimon role + database
#   6. Runs all PostgreSQL migrations
#   7. Installs ClickHouse 26.5 and runs the ClickHouse migration
#   8. Installs VictoriaMetrics 1.96 as a systemd service
#   9. Installs npm dependencies for the frontend
#  10. Prints access URLs and next steps

set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────

GO_VERSION="1.22.3"
GO_ARCHIVE="go${GO_VERSION}.linux-amd64.tar.gz"
GO_URL="https://go.dev/dl/${GO_ARCHIVE}"
GO_INSTALL_DIR="/usr/local"

VM_VERSION="1.96.0"
VM_BINARY="victoria-metrics-linux-amd64-v${VM_VERSION}.tar.gz"
VM_URL="https://github.com/VictoriaMetrics/VictoriaMetrics/releases/download/v${VM_VERSION}/${VM_BINARY}"
VM_INSTALL="/usr/local/bin/victoria-metrics-prod"
VM_DATA="/var/lib/victoria-metrics"

DB_NAME="anthrimon"
DB_USER="anthrimon"
DB_PASS="changeme"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Colour helpers ────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()  { echo -e "  ${RED}✘${RESET}  $*" >&2; }
hdr()  { echo -e "\n${BOLD}━━━  $*  ━━━${RESET}"; }
die()  { err "$*"; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────

hdr "Preflight"

[[ $EUID -eq 0 ]] || die "Run with sudo: sudo bash $0"

# Identify the real user who invoked sudo (we install user-scoped things as them)
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(eval echo "~${REAL_USER}")
info "Installing for user: ${REAL_USER} (home: ${REAL_HOME})"

# Ubuntu version check (22.04 and 24.04 supported)
if ! grep -qE 'Ubuntu (22|24)\.04' /etc/os-release 2>/dev/null; then
    warn "This script targets Ubuntu 22.04 / 24.04 LTS. Detected:"
    grep PRETTY_NAME /etc/os-release || true
    warn "Continuing anyway — things may break."
fi
ok "Preflight passed"

# ── 1. System packages ────────────────────────────────────────────────────────

hdr "System packages"
apt-get update -qq
apt-get install -y -qq \
    curl wget gnupg2 ca-certificates lsb-release apt-transport-https \
    git build-essential \
    python3 python3-pip python3-venv python3-dev \
    libpq-dev \
    net-tools iproute2 \
    jq unzip
ok "System packages installed"

# ── 2. Go ─────────────────────────────────────────────────────────────────────

hdr "Go ${GO_VERSION}"
if go version 2>/dev/null | grep -q "${GO_VERSION}"; then
    ok "Go ${GO_VERSION} already installed"
else
    info "Downloading ${GO_ARCHIVE}..."
    TMP_GO=$(mktemp -d)
    curl -fsSL "${GO_URL}" -o "${TMP_GO}/${GO_ARCHIVE}"
    rm -rf "${GO_INSTALL_DIR}/go"
    tar -C "${GO_INSTALL_DIR}" -xzf "${TMP_GO}/${GO_ARCHIVE}"
    rm -rf "${TMP_GO}"

    # Add to system-wide profile if not already there
    GO_PROFILE=/etc/profile.d/go.sh
    cat > "${GO_PROFILE}" <<'EOF'
export PATH=$PATH:/usr/local/go/bin
EOF
    chmod 644 "${GO_PROFILE}"
    export PATH="$PATH:/usr/local/go/bin"
    ok "Go ${GO_VERSION} installed (${GO_INSTALL_DIR}/go)"
fi

# ── 3. Node.js 20.x ──────────────────────────────────────────────────────────

hdr "Node.js 20.x"
if node --version 2>/dev/null | grep -q '^v20\.'; then
    ok "Node.js $(node --version) already installed"
else
    info "Adding NodeSource repo for Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y -qq nodejs
    ok "Node.js $(node --version) installed"
fi

# ── 4. Python virtualenv + requirements ──────────────────────────────────────

hdr "Python — virtualenv + requirements"
API_DIR="${REPO_DIR}/api"
VENV_DIR="${API_DIR}/.venv"

if [[ ! -d "${VENV_DIR}" ]]; then
    info "Creating virtualenv at ${VENV_DIR}..."
    sudo -u "${REAL_USER}" python3 -m venv "${VENV_DIR}"
fi

info "Installing Python requirements..."
sudo -u "${REAL_USER}" "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
sudo -u "${REAL_USER}" "${VENV_DIR}/bin/pip" install --quiet -r "${API_DIR}/backend/requirements.txt"
ok "Python requirements installed"

# ── 5. PostgreSQL 14 ─────────────────────────────────────────────────────────

hdr "PostgreSQL 14"
if ! dpkg -l postgresql-14 2>/dev/null | grep -q '^ii'; then
    info "Adding PostgreSQL apt repo..."
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
    echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
    apt-get install -y -qq postgresql-14 postgresql-client-14
    ok "PostgreSQL 14 installed"
else
    ok "PostgreSQL 14 already installed"
fi

systemctl enable postgresql
systemctl start postgresql
ok "PostgreSQL service running"

pg_su() { sudo -u postgres bash -c 'cd /tmp && psql "$@"' -- "$@"; }

if pg_su -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null | grep -q 1; then
    ok "Role '${DB_USER}' exists"
else
    info "Creating role '${DB_USER}'..."
    pg_su -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';"
    ok "Role created"
fi

if pg_su -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | grep -q 1; then
    ok "Database '${DB_NAME}' exists"
else
    info "Creating database '${DB_NAME}'..."
    pg_su -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
    ok "Database created"
fi

# ── 6. PostgreSQL migrations ──────────────────────────────────────────────────

hdr "PostgreSQL migrations"
PG_MIGRATIONS="${REPO_DIR}/storage/migrations/postgres"

# Tracking table (idempotent)
pg_su -d "${DB_NAME}" -c "
    CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
    );
" 2>/dev/null

for f in "${PG_MIGRATIONS}"/*.sql; do
    fname=$(basename "$f")
    if pg_su -d "${DB_NAME}" -tAc \
        "SELECT 1 FROM schema_migrations WHERE filename='${fname}'" 2>/dev/null | grep -q 1; then
        ok "${fname} — already applied"
    else
        info "Applying ${fname}..."
        pg_su -d "${DB_NAME}" < "$f"
        pg_su -d "${DB_NAME}" -c \
            "INSERT INTO schema_migrations(filename) VALUES ('${fname}');"
        # Grant privileges to the anthrimon role after each migration
        pg_su -d "${DB_NAME}" -c "
            GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};
            GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};
            GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO ${DB_USER};
        " 2>/dev/null || true
        ok "${fname} — applied"
    fi
done

# ── 7. ClickHouse ─────────────────────────────────────────────────────────────

hdr "ClickHouse"
if ! dpkg -l clickhouse-server 2>/dev/null | grep -q '^ii'; then
    info "Adding ClickHouse apt repo..."
    # The RPM repodata key is the correct signing key for both RPM and DEB repos
    curl -fsSL 'https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key' \
        | gpg --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg
    # ClickHouse's deb repo doesn't publish per-codename suites; use 'stable'
    echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=amd64] \
https://packages.clickhouse.com/deb stable main" \
        > /etc/apt/sources.list.d/clickhouse.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
        clickhouse-server \
        clickhouse-client
    ok "ClickHouse installed"
else
    ok "ClickHouse already installed"
fi

systemctl enable clickhouse-server
systemctl start clickhouse-server
sleep 3

# ClickHouse migration
CH_MIGRATION="${REPO_DIR}/storage/migrations/clickhouse/001_flow_records.sql"
if [[ -f "${CH_MIGRATION}" ]]; then
    info "Applying ClickHouse migration 001_flow_records.sql..."
    clickhouse-client --multiquery < "${CH_MIGRATION}" 2>/dev/null \
        && ok "001_flow_records.sql applied (or already exists)" \
        || warn "ClickHouse migration returned errors (tables may already exist — check manually)"
fi

# ── 8. VictoriaMetrics ────────────────────────────────────────────────────────

hdr "VictoriaMetrics ${VM_VERSION}"
if [[ -x "${VM_INSTALL}" ]]; then
    ok "VictoriaMetrics already installed at ${VM_INSTALL}"
else
    info "Downloading VictoriaMetrics v${VM_VERSION}..."
    TMP_VM=$(mktemp -d)
    curl -fsSL "${VM_URL}" -o "${TMP_VM}/${VM_BINARY}"
    tar -xzf "${TMP_VM}/${VM_BINARY}" -C "${TMP_VM}"
    install -m 755 "${TMP_VM}/victoria-metrics-prod" "${VM_INSTALL}"
    rm -rf "${TMP_VM}"
    ok "VictoriaMetrics binary installed at ${VM_INSTALL}"
fi

mkdir -p "${VM_DATA}"
chown -R "$REAL_USER":"$REAL_USER" "${VM_DATA}"

# Install systemd unit for VictoriaMetrics
cat > /etc/systemd/system/victoria-metrics.service <<EOF
[Unit]
Description=VictoriaMetrics time-series database
After=network.target

[Service]
User=${REAL_USER}
ExecStart=${VM_INSTALL} \\
    -storageDataPath=${VM_DATA} \\
    -httpListenAddr=:8428 \\
    -retentionPeriod=12
Restart=on-failure
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable victoria-metrics
systemctl start victoria-metrics
ok "VictoriaMetrics service running"

# ── 9. Frontend npm install ───────────────────────────────────────────────────

hdr "Frontend — npm install"
FRONTEND_DIR="${REPO_DIR}/frontend/dashboard"
if [[ -f "${FRONTEND_DIR}/package.json" ]]; then
    sudo -u "${REAL_USER}" bash -c "cd '${FRONTEND_DIR}' && npm install --silent"
    ok "npm packages installed"
else
    warn "frontend/dashboard/package.json not found — skipping"
fi

# ── 10. Systemd units for API + Frontend (dev) ────────────────────────────────

hdr "Systemd units (dev)"

# API unit — uses the virtualenv
cat > /etc/systemd/system/anthrimon-api.service <<EOF
[Unit]
Description=Anthrimon FastAPI backend
After=network.target postgresql.service

[Service]
User=${REAL_USER}
WorkingDirectory=${REPO_DIR}/api
Environment="DB_HOST=127.0.0.1"
Environment="DB_USER=${DB_USER}"
Environment="DB_PASSWORD=${DB_PASS}"
Environment="DB_NAME=${DB_NAME}"
ExecStart=${VENV_DIR}/bin/python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable anthrimon-api
systemctl start anthrimon-api
ok "anthrimon-api service started"

# ── Summary ───────────────────────────────────────────────────────────────────

IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  Anthrimon dev environment ready${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  API         ${CYAN}http://${IP}:8000${RESET}"
echo -e "  API docs    ${CYAN}http://${IP}:8000/api/docs${RESET}"
echo -e "  Metrics     ${CYAN}http://${IP}:8428${RESET}"
echo ""
echo -e "  Start frontend (in a terminal as ${REAL_USER}):"
echo -e "    ${BOLD}cd ${REPO_DIR}/frontend/dashboard && npm run dev${RESET}"
echo ""
echo -e "  Python venv for API dev:"
echo -e "    ${BOLD}source ${VENV_DIR}/bin/activate${RESET}"
echo ""
echo -e "  Services managed by systemd:"
echo -e "    ${BOLD}systemctl status anthrimon-api${RESET}"
echo -e "    ${BOLD}systemctl status victoria-metrics${RESET}"
echo -e "    ${BOLD}systemctl status clickhouse-server${RESET}"
echo -e "    ${BOLD}systemctl status postgresql${RESET}"
echo ""
