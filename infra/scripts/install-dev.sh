#!/usr/bin/env bash
# Anthrimon — full-stack installer
# Targets Ubuntu 22.04 / 24.04 LTS (bare metal or VM)
# Usage: sudo bash infra/scripts/install-dev.sh
#
# What this script does:
#   1.  Installs system packages (nginx, build tools, etc.)
#   2.  Installs Go 1.22.3
#   3.  Installs Node.js 20.x (via NodeSource)
#   4.  Installs Python virtualenv + API requirements
#   5.  Installs PostgreSQL 14, creates role/database
#   6.  Runs all PostgreSQL migrations
#   7.  Installs ClickHouse, runs all ClickHouse migrations
#   8.  Installs VictoriaMetrics as a systemd service
#   9.  Builds the SNMP collector (Go)
#   10. Builds the flow collector (Go)
#   11. Builds the frontend production bundle (npm)
#   12. Configures nginx to serve the frontend and proxy the API
#   13. Installs systemd units for all services
#   14. Starts everything and prints a summary

set -euo pipefail

# ── Fixed constants ───────────────────────────────────────────────────────────

GO_VERSION="1.22.3"
GO_ARCHIVE="go${GO_VERSION}.linux-amd64.tar.gz"
GO_URL="https://go.dev/dl/${GO_ARCHIVE}"
GO_INSTALL_DIR="/usr/local"

VM_VERSION="1.96.0"
VM_BINARY="victoria-metrics-linux-amd64-v${VM_VERSION}.tar.gz"
VM_URL="https://github.com/VictoriaMetrics/VictoriaMetrics/releases/download/v${VM_VERSION}/${VM_BINARY}"
VM_INSTALL="/usr/local/bin/victoria-metrics-prod"
VM_DATA="/var/lib/victoria-metrics"

API_PORT="8001"

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

# ── Prompt helpers ────────────────────────────────────────────────────────────

# ask VAR "Prompt text" "default"  — shows default, uses it on empty input
ask() {
    local _var="$1" _prompt="$2" _default="$3" _input
    read -rp "$(echo -e "  ${CYAN}?${RESET}  ${_prompt} [${BOLD}${_default}${RESET}]: ")" _input </dev/tty
    printf -v "${_var}" '%s' "${_input:-${_default}}"
}

# ask_secret VAR "Prompt text"  — no echo, no default shown, confirms match
ask_secret() {
    local _var="$1" _prompt="$2" _a _b
    while true; do
        read -rsp "$(echo -e "  ${CYAN}?${RESET}  ${_prompt}: ")" _a </dev/tty; echo
        read -rsp "$(echo -e "  ${CYAN}?${RESET}  Confirm ${_prompt}: ")" _b </dev/tty; echo
        if [[ "$_a" == "$_b" ]]; then
            printf -v "${_var}" '%s' "${_a}"
            break
        fi
        warn "Passwords do not match, try again."
    done
}

# ask_yn VAR "Question?" — returns 'y' or 'n'
ask_yn() {
    local _var="$1" _prompt="$2" _input
    read -rp "$(echo -e "  ${CYAN}?${RESET}  ${_prompt} [y/N]: ")" _input </dev/tty
    printf -v "${_var}" '%s' "${_input,,}"
}

# ── Preflight ─────────────────────────────────────────────────────────────────

hdr "Preflight"

[[ $EUID -eq 0 ]] || die "Run with sudo: sudo bash $0"

REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(eval echo "~${REAL_USER}")
info "Installing for user: ${REAL_USER} (home: ${REAL_HOME})"

if ! grep -qE 'Ubuntu (22|24)\.04' /etc/os-release 2>/dev/null; then
    warn "This script targets Ubuntu 22.04 / 24.04 LTS. Continuing anyway."
fi
ok "Preflight passed"

# ── Configuration prompts ─────────────────────────────────────────────────────

hdr "Configuration"
echo -e "  Press Enter to accept the ${BOLD}default${RESET} shown in brackets.\n"

DETECTED_IP=$(hostname -I | awk '{print $1}')

ask    DB_USER     "PostgreSQL role name"      "anthrimon"
ask    DB_NAME     "PostgreSQL database name"  "anthrimon"

echo -e "  ${CYAN}→${RESET}  Leave the database password blank to generate a random one."
ask_secret DB_PASS "Database password"
if [[ -z "${DB_PASS}" ]]; then
    DB_PASS=$(openssl rand -base64 18 | tr -dc 'a-zA-Z0-9' | head -c 24)
    ok "Generated random database password"
fi

ask    BASE_URL    "Public base URL (used in alert emails)" \
                   "http://${DETECTED_IP}"
# Strip trailing slash
BASE_URL="${BASE_URL%/}"

ask    NETFLOW_PORT "NetFlow / IPFIX UDP listen port" "2055"
ask    SFLOW_PORT   "sFlow UDP listen port"           "6343"

# Confirm before installing
echo ""
echo -e "  ${BOLD}Summary of configuration:${RESET}"
echo -e "  DB role/database  : ${CYAN}${DB_USER}${RESET} / ${CYAN}${DB_NAME}${RESET}"
echo -e "  DB password       : ${CYAN}(set)${RESET}"
echo -e "  Public URL        : ${CYAN}${BASE_URL}${RESET}"
echo -e "  NetFlow port      : ${CYAN}${NETFLOW_PORT}${RESET}"
echo -e "  sFlow port        : ${CYAN}${SFLOW_PORT}${RESET}"
echo -e "  Repo directory    : ${CYAN}${REPO_DIR}${RESET}"
echo ""
ask_yn _CONFIRM "Proceed with installation?"
[[ "${_CONFIRM}" == "y" ]] || die "Aborted."

# ── 1. System packages ────────────────────────────────────────────────────────

hdr "System packages"
apt-get update -qq
apt-get install -y -qq \
    curl wget gnupg2 ca-certificates lsb-release apt-transport-https \
    git build-essential openssl \
    python3 python3-pip python3-venv python3-dev \
    libpq-dev \
    nginx \
    net-tools iproute2 \
    jq unzip
ok "System packages installed"

# ── 2. Go ─────────────────────────────────────────────────────────────────────

hdr "Go ${GO_VERSION}"
export PATH="$PATH:/usr/local/go/bin"
if go version 2>/dev/null | grep -q "${GO_VERSION}"; then
    ok "Go ${GO_VERSION} already installed"
else
    info "Downloading ${GO_ARCHIVE}..."
    TMP_GO=$(mktemp -d)
    curl -fsSL "${GO_URL}" -o "${TMP_GO}/${GO_ARCHIVE}"
    rm -rf "${GO_INSTALL_DIR}/go"
    tar -C "${GO_INSTALL_DIR}" -xzf "${TMP_GO}/${GO_ARCHIVE}"
    rm -rf "${TMP_GO}"
    cat > /etc/profile.d/go.sh <<'EOF'
export PATH=$PATH:/usr/local/go/bin
EOF
    chmod 644 /etc/profile.d/go.sh
    ok "Go ${GO_VERSION} installed"
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
sudo -u "${REAL_USER}" "${VENV_DIR}/bin/pip" install --quiet \
    -r "${API_DIR}/backend/requirements.txt"
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

pg_su -d "${DB_NAME}" -c "
    CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
    );
" 2>/dev/null

for f in "${PG_MIGRATIONS}"/*.sql; do
    [[ -f "$f" ]] || continue
    fname=$(basename "$f")
    if pg_su -d "${DB_NAME}" -tAc \
        "SELECT 1 FROM schema_migrations WHERE filename='${fname}'" 2>/dev/null | grep -q 1; then
        ok "${fname} — already applied"
    else
        info "Applying ${fname}..."
        pg_su -d "${DB_NAME}" < "$f"
        pg_su -d "${DB_NAME}" -c \
            "INSERT INTO schema_migrations(filename) VALUES ('${fname}');"
        pg_su -d "${DB_NAME}" -c "
            GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO ${DB_USER};
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
    curl -fsSL 'https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key' \
        | gpg --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=amd64] \
https://packages.clickhouse.com/deb stable main" \
        > /etc/apt/sources.list.d/clickhouse.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
        clickhouse-server clickhouse-client
    ok "ClickHouse installed"
else
    ok "ClickHouse already installed"
fi

systemctl enable clickhouse-server
systemctl start clickhouse-server
# Wait for ClickHouse to be ready
for i in $(seq 1 10); do
    clickhouse-client --query "SELECT 1" &>/dev/null && break || sleep 2
done

info "Applying ClickHouse migrations..."
CH_MIGRATIONS="${REPO_DIR}/storage/migrations/clickhouse"
for f in "${CH_MIGRATIONS}"/*.sql; do
    [[ -f "$f" ]] || continue
    fname=$(basename "$f")
    info "  ${fname}..."
    clickhouse-client --multiquery < "$f" 2>/dev/null \
        && ok "${fname} applied (or already exists)" \
        || warn "${fname} returned errors (tables may already exist)"
done

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
    ok "VictoriaMetrics installed at ${VM_INSTALL}"
fi

mkdir -p "${VM_DATA}"
chown -R "${REAL_USER}":"${REAL_USER}" "${VM_DATA}"

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
systemctl restart victoria-metrics
ok "VictoriaMetrics service running"

# ── 9. SNMP collector (Go) ────────────────────────────────────────────────────

hdr "SNMP collector"
SNMP_DIR="${REPO_DIR}/collectors/snmp"
info "Building snmp-collector..."
sudo -u "${REAL_USER}" bash -c "cd '${SNMP_DIR}' && /usr/local/go/bin/go build -o snmp-collector ./cmd/snmp-collector/"
ok "snmp-collector binary built"

# Write config if it doesn't exist
SNMP_YAML="${SNMP_DIR}/snmp-collector.yaml"
if [[ ! -f "${SNMP_YAML}" ]]; then
    cat > "${SNMP_YAML}" <<EOF
log:
  level: info

database:
  dsn: "postgres://${DB_USER}:${DB_PASS}@127.0.0.1/${DB_NAME}?sslmode=disable"
  max_conns: 5
  min_conns: 1

snmp:
  timeout_seconds: 10
  retries: 3

polling:
  default_interval_s: 60
  health_multiplier: 1
  device_refresh_s: 60
  max_concurrent_devices: 500

metrics:
  victoriametrics_url: "http://localhost:8428"
  flush_interval: 10s
  batch_size: 500
EOF
    chown "${REAL_USER}":"${REAL_USER}" "${SNMP_YAML}"
    ok "snmp-collector.yaml written"
else
    ok "snmp-collector.yaml already exists"
fi

cat > /etc/systemd/system/snmp-collector.service <<EOF
[Unit]
Description=Anthrimon SNMP collector
After=network.target postgresql.service victoria-metrics.service

[Service]
User=${REAL_USER}
ExecStart=${SNMP_DIR}/snmp-collector --config ${SNMP_YAML}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable snmp-collector
systemctl restart snmp-collector
ok "snmp-collector service running"

# ── 10. Flow collector (Go) ───────────────────────────────────────────────────

hdr "Flow collector"
FLOW_DIR="${REPO_DIR}/collectors/flow"
info "Building flow-collector..."
sudo -u "${REAL_USER}" bash -c "cd '${FLOW_DIR}' && /usr/local/go/bin/go build -o flow-collector ./cmd/flow-collector/"
ok "flow-collector binary built"

# Write config if it doesn't exist
FLOW_YAML="${FLOW_DIR}/flow-collector.yaml"
if [[ ! -f "${FLOW_YAML}" ]]; then
    cat > "${FLOW_YAML}" <<EOF
log:
  level: info

database:
  dsn: "postgres://${DB_USER}:${DB_PASS}@127.0.0.1/${DB_NAME}?sslmode=disable"
  max_conns: 3

clickhouse:
  dsn: "clickhouse://localhost:9000/default"
  max_conns: 5

listener:
  netflow_addr: ":${NETFLOW_PORT}"
  sflow_addr:   ":${SFLOW_PORT}"
  buffer_size:  65535

writer:
  batch_size:      2000
  flush_interval_s: 5

lookup:
  device_refresh_s: 300
EOF
    chown "${REAL_USER}":"${REAL_USER}" "${FLOW_YAML}"
    ok "flow-collector.yaml written"
else
    ok "flow-collector.yaml already exists"
fi

cat > /etc/systemd/system/flow-collector.service <<EOF
[Unit]
Description=Anthrimon flow collector (NetFlow v5/v9, IPFIX, sFlow v5)
After=network.target postgresql.service clickhouse-server.service

[Service]
User=${REAL_USER}
ExecStart=${FLOW_DIR}/flow-collector --config ${FLOW_YAML}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable flow-collector
systemctl restart flow-collector
ok "flow-collector service running"

# ── 11. Frontend production build ─────────────────────────────────────────────

hdr "Frontend production build"
FRONTEND_DIR="${REPO_DIR}/frontend/dashboard"
info "Installing npm dependencies..."
sudo -u "${REAL_USER}" bash -c "cd '${FRONTEND_DIR}' && npm install --silent"
info "Building production bundle..."
sudo -u "${REAL_USER}" bash -c "cd '${FRONTEND_DIR}' && npm run build"
ok "Frontend built to ${FRONTEND_DIR}/dist"

# ── 12. nginx ─────────────────────────────────────────────────────────────────

hdr "nginx"

# Grant nginx (www-data) traversal access to the dist directory
chmod o+x "${REAL_HOME}" \
          "${REPO_DIR}" \
          "${REPO_DIR}/frontend" \
          "${FRONTEND_DIR}" \
          "${FRONTEND_DIR}/dist"

cat > /etc/nginx/sites-available/anthrimon <<NGINX
server {
    listen 80 default_server;
    server_name _;

    root ${FRONTEND_DIR}/dist;
    index index.html;

    # SPA — all non-file routes serve index.html
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Immutable static assets — cache for 1 year
    location ~* \\.(?:js|css|woff2?|ttf|eot|svg|png|jpg|ico)\$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API proxy → uvicorn
    location /api/ {
        proxy_pass         http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Connection        '';
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/anthrimon /etc/nginx/sites-enabled/anthrimon
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl restart nginx
ok "nginx configured and running"

# ── 13. API systemd unit ──────────────────────────────────────────────────────

hdr "Anthrimon API"

# Preserve or generate secrets
if grep -q "ANTHRIMON_ENCRYPTION_KEY" /etc/systemd/system/anthrimon-api.service 2>/dev/null; then
    ENCRYPTION_KEY=$(grep ANTHRIMON_ENCRYPTION_KEY /etc/systemd/system/anthrimon-api.service \
        | sed 's/.*ANTHRIMON_ENCRYPTION_KEY=//')
    JWT_SECRET=$(grep JWT_SECRET_KEY /etc/systemd/system/anthrimon-api.service 2>/dev/null \
        | sed 's/.*JWT_SECRET_KEY=//' || openssl rand -hex 32)
    ok "Reusing existing secrets"
else
    ENCRYPTION_KEY=$(openssl rand -hex 32)
    JWT_SECRET=$(openssl rand -hex 32)
    ok "Generated new encryption and JWT secrets"
fi

cat > /etc/systemd/system/anthrimon-api.service <<EOF
[Unit]
Description=Anthrimon FastAPI backend
After=network.target postgresql.service

[Service]
User=${REAL_USER}
WorkingDirectory=${REPO_DIR}/api
Environment="ANTHRIMON_ENCRYPTION_KEY=${ENCRYPTION_KEY}"
Environment="JWT_SECRET_KEY=${JWT_SECRET}"
Environment="DB_HOST=127.0.0.1"
Environment="DB_USER=${DB_USER}"
Environment="DB_PASSWORD=${DB_PASS}"
Environment="DB_NAME=${DB_NAME}"
ExecStart=${VENV_DIR}/bin/python3 -m uvicorn backend.main:app --host 127.0.0.1 --port ${API_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable anthrimon-api
systemctl restart anthrimon-api
ok "anthrimon-api service running"

# Seed base_url into platform settings so alert emails contain correct links
info "Setting platform base_url to ${BASE_URL}..."
pg_su -d "${DB_NAME}" -c "
    INSERT INTO system_settings (key, value)
    VALUES ('platform', jsonb_build_object('base_url', '${BASE_URL}'))
    ON CONFLICT (key) DO UPDATE
        SET value = system_settings.value || jsonb_build_object('base_url', '${BASE_URL}');
" 2>/dev/null && ok "Platform base_url set" || warn "Could not set platform base_url (run manually later)"

# ── Summary ───────────────────────────────────────────────────────────────────

IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  Anthrimon is live${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Dashboard   ${CYAN}${BASE_URL}/${RESET}"
echo -e "  API docs    ${CYAN}${BASE_URL}/api/docs${RESET}"
echo ""
echo -e "  Services:"
echo -e "    ${BOLD}systemctl status anthrimon-api${RESET}"
echo -e "    ${BOLD}systemctl status snmp-collector${RESET}"
echo -e "    ${BOLD}systemctl status flow-collector${RESET}"
echo -e "    ${BOLD}systemctl status nginx${RESET}"
echo -e "    ${BOLD}systemctl status victoria-metrics${RESET}"
echo -e "    ${BOLD}systemctl status clickhouse-server${RESET}"
echo -e "    ${BOLD}systemctl status postgresql${RESET}"
echo ""
echo -e "  Flow export targets:"
echo -e "    NetFlow / IPFIX  ${BOLD}${IP}:${NETFLOW_PORT}${RESET} (UDP)"
echo -e "    sFlow            ${BOLD}${IP}:${SFLOW_PORT}${RESET} (UDP)"
echo ""
echo -e "  Encryption key stored in /etc/systemd/system/anthrimon-api.service"
echo ""
