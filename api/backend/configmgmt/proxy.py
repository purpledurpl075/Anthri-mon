"""Hub→collector delegation for config operations.

For collector-managed devices the hub can't SSH to the device (it's on a remote
LAN) and the device can't reach the hub.  The collector that owns the device
sits on its LAN, so the hub ships it the SSH recipe — and, for rollback, the
config text — and the collector does the SSH and hosts the one-shot standby HTTP
server (see collectors/remote/internal/server/configexec.go).

All vendor logic stays on the hub; the collector is a generic executor.  This
module is just the authenticated HTTP client to the collector's /config-exec
endpoint, mirroring the auth used for /sweep, /probe, /poll.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import time

import httpx
import structlog

logger = structlog.get_logger(__name__)

_WG_SUBNET = ipaddress.ip_network("10.100.0.0/24")
_COLLECTOR_PORT = 9090

# Vendors that need `enable` (privileged exec) before config commands.  Kept in
# one place so every delegated op agrees with the hub-local Netmiko paths.
# NOT aruba_cx: AOS-CX has no enable mode — SSH lands you at the manager prompt,
# and sending `enable` errors ("Invalid input: enable") and pollutes captures.
ENABLE_VENDORS = {
    "arista", "cisco_ios", "cisco_iosxe", "cisco_iosxr", "cisco_nxos",
}


def _control_token(api_key_hash: str) -> str:
    """HMAC(key=api_key_hash, msg=utc_minute) — matches the collector's
    checkAuth, which accepts the current minute ±1."""
    minute = str(int(time.time()) // 60)
    return hmac.new(api_key_hash.encode(), minute.encode(), hashlib.sha256).hexdigest()


async def api_probe(*, wg_ip: str, api_key_hash: str,
                    device_ip: str, method: str) -> tuple[bool, str | None]:
    """Ask the collector to HTTP-probe a device's REST/eAPI endpoint from its LAN.
    Returns (reachable, error_string_or_None).
    """
    ip = str(wg_ip).split("/")[0]
    try:
        async with httpx.AsyncClient(timeout=15.0) as hc:
            resp = await hc.post(
                f"http://{ip}:{_COLLECTOR_PORT}/api-probe",
                json={"ip": device_ip, "method": method},
                headers={"Authorization": f"Bearer {_control_token(api_key_hash)}"},
            )
        data = resp.json()
        return data.get("reachable", False), data.get("error")
    except Exception as exc:
        return False, str(exc)


async def config_exec(*, wg_ip: str, api_key_hash: str, payload: dict,
                      timeout: float = 300.0) -> dict:
    """POST a config-exec job to a collector and return its JSON result
    ({"output": str, "config_served": bool}).

    Raises RuntimeError on transport/HTTP errors or a device-side failure (the
    collector returns 502 with {"error", "output", "config_served"}).
    """
    ip = str(wg_ip).split("/")[0]
    try:
        in_subnet = ipaddress.ip_address(ip) in _WG_SUBNET
    except ValueError:
        in_subnet = False
    if not in_subnet:
        raise RuntimeError(f"collector wg_ip '{ip}' is not in the WireGuard subnet")

    async with httpx.AsyncClient(timeout=timeout) as hc:
        resp = await hc.post(
            f"http://{ip}:{_COLLECTOR_PORT}/config-exec",
            json=payload,
            headers={"Authorization": f"Bearer {_control_token(api_key_hash)}"},
        )

    if resp.status_code != 200:
        detail = resp.text[:400]
        try:
            detail = resp.json().get("error") or detail
        except Exception:
            pass
        raise RuntimeError(f"collector config-exec HTTP {resp.status_code}: {detail}")
    return resp.json()


def step(command: str, *, delay: float = 1.0, expect: str = "", response: str = "") -> dict:
    """Build a wire-format step dict with all keys present."""
    return {"command": command, "expect": expect, "response": response, "delay": delay}


def steps_from_recipe(recipe) -> list[dict]:
    """Serialise a rollback Recipe's steps for the collector wire format.  The
    recipe is built with '{{URL}}' as the fetch URL; the collector substitutes
    the real one-shot-server URL at exec time."""
    return [
        step(s.command, delay=s.delay, expect=s.expect or "", response=s.response or "")
        for s in recipe.steps
    ]
