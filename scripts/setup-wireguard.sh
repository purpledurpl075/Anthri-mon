#!/bin/bash
# Anthrimon — WireGuard hub interface setup
#
# Creates the wg0 overlay interface that remote collectors tunnel through.
#
#   Hub IP:       10.100.0.1/24
#   Listen port:  51820 (UDP)
#   Collectors:   10.100.0.2 – 10.100.0.254 (assigned by bootstrap API)
#
# Usage: sudo bash scripts/setup-wireguard.sh
#
# Safe to re-run — skips key generation if wg0.conf already exists.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo"; exit 1; }

WG_IF=wg0
WG_DIR=/etc/wireguard
WG_CONF="$WG_DIR/$WG_IF.conf"
WG_IP="10.100.0.1/24"
WG_PORT=51820

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
warn() { echo -e "  ${YELLOW:-\033[1;33m}!${RESET}  $*"; }

echo -e "\n${BOLD}━━━  Anthrimon WireGuard hub setup  ━━━${RESET}"

# ── 1. Install wireguard if missing ──────────────────────────────────────────

if ! command -v wg &>/dev/null; then
    info "Installing wireguard-tools..."
    apt-get install -y -qq wireguard wireguard-tools
    ok "WireGuard installed"
else
    ok "WireGuard already installed ($(wg --version 2>&1 | head -1))"
fi

# ── 2. Generate keys or reuse existing ───────────────────────────────────────

mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"

if [[ -f "$WG_CONF" ]]; then
    ok "wg0.conf already exists — skipping key generation (re-run will not overwrite)"
    HUB_PUBKEY=$(wg show $WG_IF public-key 2>/dev/null || \
        wg pubkey < <(grep PrivateKey "$WG_CONF" | awk '{print $3}'))
    echo -e "\n  ${BOLD}Existing hub public key:${RESET}"
    echo -e "  ${CYAN}$HUB_PUBKEY${RESET}"
else
    info "Generating hub WireGuard keypair..."
    PRIVATE_KEY=$(wg genkey)
    PUBLIC_KEY=$(echo "$PRIVATE_KEY" | wg pubkey)

    info "Writing $WG_CONF..."
    cat > "$WG_CONF" <<EOF
[Interface]
# Hub address in the collector overlay network
Address    = $WG_IP
# Collectors connect to this port
ListenPort = $WG_PORT
PrivateKey = $PRIVATE_KEY

# SaveConfig = true persists dynamically added peers (via 'wg set') across
# 'wg-quick save' calls made by the bootstrap API.
SaveConfig = true

# Peers are added automatically by the Anthrimon bootstrap endpoint:
#   wg set wg0 peer <collector_pubkey> allowed-ips 10.100.0.X/32
# Do not edit peer sections by hand — they will be overwritten by SaveConfig.
EOF
    chmod 600 "$WG_CONF"
    ok "wg0.conf written"

    echo -e "\n  ${BOLD}Hub public key (store this):${RESET}"
    echo -e "  ${CYAN}$PUBLIC_KEY${RESET}"
    HUB_PUBKEY=$PUBLIC_KEY
fi

# ── 3. Enable IP forwarding ───────────────────────────────────────────────────

info "Enabling IP forwarding..."
SYSCTL_CONF=/etc/sysctl.d/99-anthrimon-wg.conf
cat > "$SYSCTL_CONF" <<EOF
# Allow WireGuard overlay traffic to reach hub services
net.ipv4.ip_forward = 1
EOF
sysctl -p "$SYSCTL_CONF" >/dev/null
ok "IP forwarding enabled"

# ── 4. Bring up wg0 and enable on boot ───────────────────────────────────────

if wg show "$WG_IF" &>/dev/null; then
    info "wg0 already up — reloading..."
    wg syncconf "$WG_IF" <(wg-quick strip "$WG_IF")
    ok "wg0 reloaded"
else
    info "Bringing up wg0..."
    wg-quick up "$WG_IF"
    ok "wg0 is up"
fi

systemctl enable wg-quick@"$WG_IF" >/dev/null 2>&1
ok "wg-quick@wg0 enabled on boot"

# ── 5. Verify ─────────────────────────────────────────────────────────────────

echo ""
info "Interface status:"
wg show "$WG_IF"

# ── 6. Summary ────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  WireGuard hub ready${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Interface   ${CYAN}wg0 @ $WG_IP${RESET}"
echo -e "  Listen      ${CYAN}UDP $WG_PORT${RESET}"
echo -e "  Hub pubkey  ${CYAN}$HUB_PUBKEY${RESET}"
echo ""
echo -e "  Ensure UDP $WG_PORT is open in your firewall/cloud security group."
echo ""
echo -e "  Peers are added automatically when collectors bootstrap."
echo -e "  To inspect active peers at any time:"
echo -e "    ${BOLD}wg show wg0${RESET}"
echo ""
