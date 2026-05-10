#!/usr/bin/env bash
# Anthrimon dev startup script
# Usage:  ./start.sh          — start everything
#         ./start.sh stop     — kill app processes (postgres/clickhouse left running)
#         ./start.sh status   — show what is up

set -euo pipefail

# When invoked via sudo, run app processes as the original user so that
# user-installed packages (uvicorn, node_modules, etc.) are on the path.
APP_USER="${SUDO_USER:-$USER}"
APP_HOME=$(eval echo "~${APP_USER}")

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/tmp/anthrimon-logs"
PID_DIR="/tmp/anthrimon-pids"

API_LOG="$LOG_DIR/api.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
VM_LOG="$LOG_DIR/victoriametrics.log"
API_PID="$PID_DIR/api.pid"
FRONTEND_PID="$PID_DIR/frontend.pid"
VM_PID="$PID_DIR/victoriametrics.pid"

# ── DB settings (match api/backend/config.py defaults) ────────────────────────
DB_NAME="anthrimon"
DB_USER="anthrimon"
DB_PASS="changeme"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()  { echo -e "  ${RED}✘${RESET}  $*" >&2; }
hdr()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── Helpers ───────────────────────────────────────────────────────────────────

is_running() {
    local pid_file="$1"
    [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

port_listening() {
    ss -tlnp 2>/dev/null | grep -q ":$1 "
}

kill_port() {
    local port="$1"
    local pid
    pid=$(ss -tlnp 2>/dev/null | awk -v p=":$port " '$0 ~ p {match($0,/pid=([0-9]+)/,a); print a[1]}')
    if [[ -n "$pid" ]]; then
        info "Killing orphan on port $port (PID $pid)..."
        kill "$pid" 2>/dev/null
        sleep 1
    fi
}

pg_running() {
    pg_ctlcluster 14 main status &>/dev/null
}

clickhouse_running() {
    pgrep -x clickhouse-serv &>/dev/null || \
    pgrep -f "clickhouse-server" &>/dev/null
}

vm_running() {
    pgrep -f "victoria-metrics-prod" &>/dev/null
}

get_ip() {
    hostname -I | awk '{print $1}'
}

# ── Stop ──────────────────────────────────────────────────────────────────────

cmd_stop() {
    hdr "Stopping Anthrimon app processes..."

    for name_pid_port in "API:$API_PID:8000" "Frontend:$FRONTEND_PID:5173" "VictoriaMetrics:$VM_PID:8428"; do
        local name="${name_pid_port%%:*}"
        local rest="${name_pid_port#*:}"
        local pf="${rest%%:*}"
        local port="${rest##*:}"
        if is_running "$pf"; then
            kill "$(cat "$pf")" 2>/dev/null && ok "$name stopped" || warn "$name: kill failed"
            rm -f "$pf"
        elif port_listening "$port"; then
            kill_port "$port"
            ok "$name stopped (orphan on port $port)"
        else
            info "$name was not running"
        fi
    done

    echo ""
    warn "PostgreSQL and ClickHouse are left running (stop manually if needed)."
    warn "  sudo pg_ctlcluster 14 main stop"
    warn "  sudo pkill -f clickhouse-server"
}

# ── Status ────────────────────────────────────────────────────────────────────

cmd_status() {
    local ip; ip=$(get_ip)
    hdr "Anthrimon service status"

    if pg_running;          then ok "PostgreSQL 14"; else err "PostgreSQL 14 — DOWN"; fi
    if clickhouse_running;  then ok "ClickHouse";    else err "ClickHouse — DOWN";    fi
    if vm_running;          then ok "VictoriaMetrics"; else err "VictoriaMetrics — DOWN"; fi

    if port_listening 8000; then
        ok "FastAPI backend   → http://${ip}:8000  (docs: http://${ip}:8000/api/docs)"
    else
        err "FastAPI backend — DOWN"
    fi

    if port_listening 5173; then
        ok "React frontend    → http://${ip}:5173"
    else
        err "React frontend — DOWN"
    fi
}

# ── Start ─────────────────────────────────────────────────────────────────────

cmd_start() {
    local ip; ip=$(get_ip)
    mkdir -p "$LOG_DIR" "$PID_DIR"

    # ── 1. PostgreSQL ─────────────────────────────────────────────────────────
    hdr "PostgreSQL 14"
    if pg_running; then
        ok "Already running"
    else
        info "Creating /var/run/postgresql..."
        sudo mkdir -p /var/run/postgresql
        sudo chown postgres:postgres /var/run/postgresql
        sudo chmod 775 /var/run/postgresql

        info "Starting cluster..."
        if sudo pg_ctlcluster 14 main start; then
            ok "Started"
        else
            err "Failed to start PostgreSQL — check: sudo pg_ctlcluster 14 main start"
            exit 1
        fi
    fi

    # ── 2. Ensure anthrimon DB + user exist ───────────────────────────────────
    hdr "PostgreSQL — role + database"
    # Run psql as postgres superuser. Avoids /home permission issues by running
    # from /tmp; file content is piped via stdin rather than -f flags.
    pg_su() { sudo -u postgres bash -c 'cd /tmp && psql "$@"' -- "$@"; }

    if pg_su -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null | grep -q 1; then
        ok "Role '${DB_USER}' exists"
    else
        info "Creating role '${DB_USER}'..."
        pg_su -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';" -o /dev/null && ok "Role created"
    fi

    if pg_su -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | grep -q 1; then
        ok "Database '${DB_NAME}' exists"
    else
        info "Creating database '${DB_NAME}'..."
        pg_su -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" -o /dev/null && ok "Database created"
    fi

    # ── 3. ClickHouse ─────────────────────────────────────────────────────────
    hdr "ClickHouse"
    if clickhouse_running; then
        ok "Already running"
    else
        info "Creating /var/run/clickhouse-server..."
        mkdir -p /var/run/clickhouse-server
        chown clickhouse:clickhouse /var/run/clickhouse-server
        chmod 755 /var/run/clickhouse-server

        info "Starting ClickHouse server..."
        sudo -u clickhouse clickhouse-server --config-file=/etc/clickhouse-server/config.xml \
            >> "$LOG_DIR/clickhouse.log" 2>&1 &
        # Give it a moment to bind ports
        sleep 3
        if clickhouse_running; then
            ok "Started (log: $LOG_DIR/clickhouse.log)"
        else
            err "ClickHouse failed to start — check $LOG_DIR/clickhouse.log"
            exit 1
        fi
    fi

    # ── 4. VictoriaMetrics ────────────────────────────────────────────────────
    hdr "VictoriaMetrics"
    if vm_running; then
        ok "Already running"
    else
        info "Starting VictoriaMetrics..."
        /usr/local/bin/victoria-metrics-prod \
            -storageDataPath=/var/lib/victoria-metrics \
            -httpListenAddr=:8428 \
            -retentionPeriod=12 \
            >> "$VM_LOG" 2>&1 &
        echo $! > "$VM_PID"
        sleep 1
        if vm_running; then
            ok "Started (log: $VM_LOG)"
        else
            err "VictoriaMetrics failed — check $VM_LOG"
            exit 1
        fi
    fi

    # ── 5. FastAPI backend ────────────────────────────────────────────────────
    hdr "FastAPI backend"
    if port_listening 8000; then
        ok "Already running"
    else
        kill_port 8000
        info "Starting uvicorn on 0.0.0.0:8000..."
        # Run as the original (non-root) user so user-installed uvicorn is on PATH
        sudo -u "$APP_USER" bash -c "
            export HOME='${APP_HOME}'
            export PATH='${APP_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin'
            export DB_HOST=127.0.0.1
            export DB_USER='${DB_USER}'
            export DB_PASSWORD='${DB_PASS}'
            export DB_NAME='${DB_NAME}'
            cd '${REPO_DIR}/api'
            exec python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
        " >> "$API_LOG" 2>&1 &
        disown $!
        sleep 5
        if port_listening 8000; then
            ok "Started (log: $API_LOG)"
        else
            err "API failed to start — check $API_LOG"
            tail -20 "$API_LOG" >&2
            exit 1
        fi
    fi

    # ── 6. React frontend ─────────────────────────────────────────────────────
    hdr "React frontend"
    if port_listening 5173; then
        ok "Already running"
    else
        kill_port 5173
        info "Starting Vite dev server on 0.0.0.0:5173..."
        # Resolve the nvm node bin dir at start time so PATH is correct.
        # Must use double quotes so APP_HOME expands here (sudo strips HOME).
        NODE_BIN=$(sudo -u "$APP_USER" bash -c "
            export HOME='${APP_HOME}'
            export NVM_DIR=\"\${HOME}/.nvm\"
            [ -s \"\${NVM_DIR}/nvm.sh\" ] && . \"\${NVM_DIR}/nvm.sh\"
            dirname \"\$(which node 2>/dev/null)\" 2>/dev/null || echo ''
        ")
        sudo -u "$APP_USER" bash -c "
            export HOME='${APP_HOME}'
            export PATH='${NODE_BIN}:${APP_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin'
            cd '${REPO_DIR}/frontend/dashboard'
            exec npm run dev
        " >> "$FRONTEND_LOG" 2>&1 &
        disown $!
        sleep 4
        if port_listening 5173; then
            ok "Started (log: $FRONTEND_LOG)"
        else
            err "Frontend failed to start — check $FRONTEND_LOG"
            tail -20 "$FRONTEND_LOG" >&2
            exit 1
        fi
    fi

    # ── Summary ───────────────────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${GREEN}${BOLD}  Anthrimon is up${RESET}"
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "  Dashboard   ${CYAN}http://${ip}:5173${RESET}"
    echo -e "  API         ${CYAN}http://${ip}:8000${RESET}"
    echo -e "  API docs    ${CYAN}http://${ip}:8000/api/docs${RESET}"
    echo -e "  Metrics     ${CYAN}http://${ip}:8428${RESET}"
    echo ""
    echo -e "  Logs in: ${LOG_DIR}/"
    echo -e "  Stop:    ${BOLD}./start.sh stop${RESET}"
    echo ""
}

# ── Entrypoint ────────────────────────────────────────────────────────────────

case "${1:-start}" in
    start)  cmd_start  ;;
    stop)   cmd_stop   ;;
    status) cmd_status ;;
    restart)
        cmd_stop
        sleep 1
        cmd_start
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
