"""Config rollback via device-pulls-from-HTTP.

Why this exists:
  The previous implementation pasted the saved config back to the device
  through SSH config mode, line by line.  That broke whenever a vendor
  prompted for confirmation mid-paste ("Do you want to continue (y/n)?",
  "% Warning: this will restart BGP sessions ...", etc.) because Netmiko
  has no way to know which prompt belongs to which line.  It was also
  slow — Aruba CX takes a minute or more for a few hundred lines.

How this works:
  1. The hub starts a one-shot HTTP server on the device-facing IP (a fixed
     high-port range, default 5050-5054) with a random token in the URL path,
     IP-locked to the target device.  See serve_rollback() below for why this
     beats serving through the main API / nginx.
  2. The hub SSHes to the device and runs a *vendor-specific* one-or-two
     command recipe that tells the device "fetch this config from the hub
     over HTTP and apply it" (the vendor's own replace semantics).
  3. The device does a single HTTP GET to http://<hub-ip>:<port>/<token>.
     The server serves the backup text exactly once to that source IP, flips
     its served flag, and shuts down — no second fetch is possible.
  4. The device applies the config atomically using vendor commands like
     `configure replace` (Cisco/Arista), `copy <url> running-config` (Aruba CX),
     `load override` + `commit` (Juniper).  Prompts are handled in the recipe.

This is the pattern every NMS uses for this kind of thing.  It works in
seconds, handles interactive prompts on the device side (the device
prompts itself, not Netmiko), and gives us real vendor replace semantics
on most platforms.
"""
from __future__ import annotations

import http.server
import socket
import socketserver
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)


# ── Hub-facing IP for the device ──────────────────────────────────────────────

def _hub_ip_for_device(device_ip: str) -> str:
    """Pick the local IP that's on the same routable path as the device.
    Uses a UDP 'connect' to a discard port — no packets are actually sent
    but the kernel resolves which interface/source IP would be used."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((device_ip, 9))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception as exc:
        logger.warning("hub_ip_autodetect_failed", device_ip=device_ip, error=str(exc))
        return "0.0.0.0"


# ── One-shot HTTP server bound to a high port on the device-facing IP ─────────
#
# Why not the main API listener?  Because the main API is bound to 127.0.0.1
# and only nginx exposes it externally.  Devices doing `copy http://...`
# generally don't trust self-signed certs and don't want to deal with nginx
# proxy quirks.  An ephemeral plain-HTTP server bound to the device-facing
# IP, serving exactly one request, IP-locked to the device, is the simplest
# correct shape — no exposure window, no firewall config, no cert dance.

@dataclass
class RollbackFetcher:
    """Holds the live one-shot HTTP server + the URL the device should use."""
    url:           str
    served_event:  threading.Event
    server:        socketserver.TCPServer
    thread:        threading.Thread
    token:         str

    def url_for_device(self) -> str:
        return self.url

    def wait_served(self, timeout: float) -> bool:
        return self.served_event.wait(timeout)

    def shutdown(self) -> None:
        try:
            self.server.shutdown()
            self.server.server_close()
        except Exception:
            pass


import os

# Fixed port range, so firewall rules can be installer-managed.  The hub
# picks the first free port in this range when a rollback fires.  Operators
# can override via the ANTHRIMON_ROLLBACK_PORTS env var (e.g. "5050-5054").
_ROLLBACK_PORT_RANGE_DEFAULT = (5050, 5054)


def _rollback_port_range() -> tuple[int, int]:
    raw = os.environ.get("ANTHRIMON_ROLLBACK_PORTS", "")
    if raw and "-" in raw:
        try:
            lo, hi = raw.split("-", 1)
            return int(lo), int(hi)
        except ValueError:
            pass
    return _ROLLBACK_PORT_RANGE_DEFAULT


def _find_free_port(bind_ip: str) -> int:
    """Pick the first port in the configured range that's free to bind."""
    lo, hi = _rollback_port_range()
    for p in range(lo, hi + 1):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((bind_ip, p))
                return p
        except OSError:
            continue
    raise RuntimeError(
        f"No free rollback port in range {lo}-{hi}.  "
        f"Increase the range via ANTHRIMON_ROLLBACK_PORTS or kill stale rollback jobs."
    )


def serve_rollback(
    config_text: str, expected_source_ip: str, timeout: float = 120.0,
) -> RollbackFetcher:
    """Start a one-shot HTTP server on the device-facing IP that will serve
    `config_text` exactly once to a request coming FROM `expected_source_ip`.
    Returns the URL the device should fetch (token-embedded path).

    Uses a fixed port range (default 5050-5054) so the installer can open the
    firewall once.  Thread is daemonized — if the caller crashes, the server
    dies with it.
    """
    bind_ip = _hub_ip_for_device(expected_source_ip)
    port    = _find_free_port(bind_ip)
    token   = uuid.uuid4().hex
    served  = threading.Event()
    served_payload = {"text": config_text}

    class _Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # Silence the default stderr logging
            return
        def _peer_ip(self) -> str:
            xff = self.headers.get("X-Forwarded-For", "")
            return xff.split(",")[0].strip() if xff else self.client_address[0]
        def do_GET(self):
            peer = self._peer_ip()
            if not self.path.endswith(f"/{token}"):
                self.send_response(404); self.end_headers(); return
            if peer != expected_source_ip:
                logger.warning("rollback_fetch_ip_mismatch", expected=expected_source_ip, got=peer)
                self.send_response(403); self.end_headers(); return
            if served.is_set():
                self.send_response(404); self.end_headers(); return
            served.set()
            data = served_payload["text"].encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            logger.info("rollback_fetch_served", source_ip=peer, bytes=len(data))

    # Bind to the port we chose from the configured range.  Use ThreadingTCPServer
    # so each request gets its own handler, but practically there's only ever one
    # request before the served flag flips.
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    server = socketserver.ThreadingTCPServer((bind_ip, port), _Handler)
    url = f"http://{bind_ip}:{port}/{token}"

    def _serve_until_done():
        deadline = time.time() + timeout
        server.timeout = 1
        while not served.is_set() and time.time() < deadline:
            server.handle_request()
        try:
            server.server_close()
        except Exception:
            pass

    t = threading.Thread(target=_serve_until_done, daemon=True)
    t.start()
    logger.info("rollback_server_started", bind=bind_ip, port=port,
                expected_ip=expected_source_ip, timeout_s=timeout)

    return RollbackFetcher(url=url, served_event=served,
                           server=server, thread=t, token=token)


# ── Vendor recipes ────────────────────────────────────────────────────────────

@dataclass
class RecipeStep:
    """One step in a rollback recipe.

    - `command`: the line to send.
    - `expect`: if set, regex the device output is expected to land on before
      the next step.  Used for confirmation prompts.
    - `response`: what to send when `expect` matches.
    - `delay`: extra wait (seconds) after sending, for slow commands like
      `configure replace`.
    """
    command:  str
    expect:   Optional[str] = None
    response: Optional[str] = None
    delay:    float = 1.0


@dataclass
class Recipe:
    """A complete vendor rollback recipe.

    `steps` runs inside the device's current mode (we don't pre-enter
    configure terminal — the recipe decides whether it needs to).
    """
    steps:     list[RecipeStep] = field(default_factory=list)
    # Whether the device exposes the result of the apply on the next prompt
    # (operator wants to see this for the audit trail).
    show_running_after: bool = False


# ── VRF handling for the HTTP transfer ────────────────────────────────────────
#
# The device pulls the rollback config over HTTP from the hub.  Which routing
# table (global vs a VRF) it uses for that fetch is decided by the device, not
# the hub.  We resolve the VRF that the device's *monitored* IP actually lives
# in (from the polled interface table — see _resolve_mgmt_vrf in the router) and
# steer the transfer onto that table so the fetch is reliable instead of
# silently egressing the wrong interface.
#
#   - Aruba CX / NX-OS / Arista:  `copy` takes an inline `vrf <name>` token.
#   - Cisco IOS/IOS-XE:           `copy http` has no inline VRF — we point the
#                                 HTTP client at the monitored interface so it
#                                 inherits that interface's VRF.
#   - IOS-XR / Juniper:           best-effort; their mgmt fetch uses the mgmt
#                                 plane / default instance.  We surface the
#                                 detected VRF in logs for the audit trail.

def _is_global_vrf(vrf: Optional[str]) -> bool:
    """True when the monitored IP is in the global table (no VRF token needed).
    Treats the common 'global table' aliases as global."""
    return vrf is None or vrf.strip().lower() in {"", "default", "global"}


def _aruba_cx_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str]) -> Recipe:
    # AOS-CX `copy <url> running-config` MERGES (applies the file as commands) —
    # it does NOT remove config absent from the file, so it can't faithfully
    # restore a snapshot.  Use the checkpoint primitive instead: download the
    # snapshot into a named checkpoint, then replace running-config with that
    # checkpoint — a true atomic replace that removes extra config.
    #
    # `copy` ALWAYS requires an explicit VRF token; use the VRF the monitored IP
    # lives in (from the polled interface table), falling back to 'mgmt' — the
    # CX out-of-band mgmt port (where the monitored IP usually lives) isn't in
    # ifTable, so detection commonly returns nothing for CX.
    vrf_name = vrf.strip() if (vrf and vrf.strip()) else "mgmt"
    ckpt = "anthrimon_rb"
    steps = [
        # Download the snapshot into a checkpoint (over the mgmt VRF).
        RecipeStep(
            command=f"copy {url} checkpoint {ckpt} vrf {vrf_name}",
            expect=r"(y/n)|overwrite|exists|Press any key|continue",
            response="y", delay=8.0,
        ),
        # Replace running-config with the checkpoint — true replace.
        RecipeStep(
            command=f"copy checkpoint {ckpt} running-config",
            expect=r"(y/n)|overwrite|continue|proceed",
            response="y", delay=10.0,
        ),
    ]
    if save:
        steps.append(RecipeStep(command="write memory", delay=2.0))
    # Best-effort cleanup so the checkpoint name is reusable next time.
    steps.append(RecipeStep(command=f"erase checkpoint {ckpt}",
                            expect=r"(y/n)|continue|confirm", response="y", delay=2.0))
    return Recipe(steps=steps, show_running_after=True)


def _arista_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str]) -> Recipe:
    # EOS implements the same `configure replace` UX as Cisco IOS — uses
    # smart-diff and applies only the deltas atomically.  `force` skips the
    # confirmation prompt.  Runs from privileged exec.  EOS `copy` accepts an
    # inline `vrf <name>` token when the monitored IP is in a VRF.
    copy_cmd = f"copy {url} flash:anthrimon-rb.cfg"
    if not _is_global_vrf(vrf):
        copy_cmd += f" vrf {vrf.strip()}"
    return Recipe(steps=[
        RecipeStep(command=copy_cmd, delay=3.0),
        RecipeStep(command="configure replace flash:anthrimon-rb.cfg force", delay=8.0),
        RecipeStep(command="delete flash:anthrimon-rb.cfg",
                   expect=r"(y/n)|confirm|Proceed", response="y", delay=1.0),
        *([RecipeStep(command="write memory", delay=2.0)] if save else []),
    ])


def _cisco_ios_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str]) -> Recipe:
    # IOS' configure replace runs from privileged exec.  `force` is supposed
    # to skip the confirmation, but some platforms (older 15.x) still ask —
    # we expect the prompt and answer y just in case.
    #
    # IOS `copy http` has no inline VRF keyword.  When the monitored IP is in a
    # VRF, point the HTTP client at the monitored interface so the fetch uses
    # that interface's VRF.  (This leaves `ip http client source-interface` set
    # — it reflects the real mgmt path and is harmless, but will show in the
    # next config diff.)
    pre: list[RecipeStep] = []
    if not _is_global_vrf(vrf) and source_if:
        pre = [
            RecipeStep(command="configure terminal", delay=1.0),
            RecipeStep(command=f"ip http client source-interface {source_if}", delay=1.0),
            RecipeStep(command="end", delay=1.0),
        ]
    return Recipe(steps=[
        *pre,
        RecipeStep(
            command=f"copy {url} flash:anthrimon-rb.cfg",
            expect=r"Destination filename|filename", response="", delay=3.0,
        ),
        RecipeStep(
            command="configure replace flash:anthrimon-rb.cfg force",
            expect=r"(want to proceed|Enter Y|sure you want)", response="y",
            delay=10.0,
        ),
        RecipeStep(command="delete /force flash:anthrimon-rb.cfg", delay=1.0),
        *([RecipeStep(command="write memory", delay=2.0)] if save else []),
    ])


def _cisco_nxos_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str]) -> Recipe:
    # NX-OS doesn't have a `force` keyword for `configure replace`; it always
    # prompts.  The prompt text is "Do you want to proceed?".  NX-OS `copy`
    # accepts an inline `vrf <name>` token (mgmt typically uses 'management').
    copy_cmd = f"copy {url} bootflash:anthrimon-rb.cfg"
    if not _is_global_vrf(vrf):
        copy_cmd += f" vrf {vrf.strip()}"
    return Recipe(steps=[
        RecipeStep(command=copy_cmd, delay=3.0),
        RecipeStep(command="configure replace bootflash:anthrimon-rb.cfg",
                   expect=r"(y/n|want to proceed|continue)",
                   response="y", delay=12.0),
        RecipeStep(command="delete bootflash:anthrimon-rb.cfg no-prompt", delay=1.0),
        *([RecipeStep(command="copy running-config startup-config", delay=2.0)] if save else []),
    ])


def _cisco_iosxr_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str]) -> Recipe:
    # IOS-XR uses a candidate-then-commit model.  `load` stages the URL into
    # candidate; `commit replace` swaps running atomically.
    # `commit replace` prompts: "This commit will replace or remove the entire
    # running configuration.  This operation can take a long time...
    # Do you wish to proceed? [no]:" — respond `yes`.
    # IOS-XR fetches over the management plane; `load` takes no inline VRF.
    # The detected VRF is logged for the audit trail by the caller.
    return Recipe(steps=[
        RecipeStep(command="configure terminal", delay=1.0),
        RecipeStep(command=f"load {url}", delay=5.0),
        RecipeStep(command="commit replace",
                   expect=r"(y/n|yes/no|Proceed|wish to proceed)",
                   response="yes", delay=15.0),
        RecipeStep(command="exit", delay=1.0),
    ])


def _juniper_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str]) -> Recipe:
    # Junos has one unified config — no separate startup save needed.
    # `commit` writes to both candidate AND active simultaneously.
    # Must enter config mode (`configure`) before `load`.
    # Junos fetches over its default routing instance; `load override` takes no
    # inline routing-instance.  The detected VRF is logged for the audit trail.
    return Recipe(steps=[
        RecipeStep(command="configure exclusive", delay=2.0),  # exclusive lock prevents concurrent edits
        RecipeStep(command=f"load override {url}", delay=5.0),
        RecipeStep(command="commit and-quit", delay=15.0),
    ])


def _procurve_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str]) -> Recipe:
    # ProCurve's HTTP support is limited to firmware download, not config.
    # Force the operator to use TFTP for ProCurve — set up via platform
    # settings, since the URL shape is different.
    raise NotImplementedError(
        "ProCurve rollback requires TFTP server setup; HTTP copy isn't supported "
        "by ProCurve firmware. This vendor needs a separate implementation."
    )


# ── Dispatcher ────────────────────────────────────────────────────────────────

_VENDOR_RECIPES = {
    "aruba_cx":     _aruba_cx_recipe,
    "arista":       _arista_recipe,
    "cisco_ios":    _cisco_ios_recipe,
    "cisco_iosxe":  _cisco_ios_recipe,
    "cisco_iosxr":  _cisco_iosxr_recipe,
    "cisco_nxos":   _cisco_nxos_recipe,
    "juniper":      _juniper_recipe,
    # procurve omitted on purpose — see _procurve_recipe
}


def supported_vendors() -> set[str]:
    return set(_VENDOR_RECIPES.keys())


def build_recipe(
    vendor_key: str, url: str, save: bool,
    vrf: Optional[str] = None, source_if: Optional[str] = None,
) -> Recipe:
    """Build the vendor rollback recipe.

    `vrf` / `source_if` describe the routing context of the device's monitored
    IP (resolved from the polled interface table).  They steer the device's
    HTTP fetch onto the correct table so the transfer is reliable — see the
    per-vendor recipes and _is_global_vrf above.
    """
    builder = _VENDOR_RECIPES.get(vendor_key)
    if builder is None:
        raise ValueError(
            f"Rollback is not implemented for vendor '{vendor_key}'. "
            f"Supported: {sorted(supported_vendors())}.  "
            f"ProCurve and FortiOS would need different protocols (TFTP for ProCurve, "
            f"vendor API for FortiOS) and aren't yet supported."
        )
    return builder(url, save, vrf, source_if)


# ── Recipe execution (Netmiko) ────────────────────────────────────────────────

def run_recipe(
    host: str, port: int, vendor_key: str, cred_data: dict, recipe: Recipe,
) -> str:
    """Run the recipe over SSH using Netmiko.  Handles per-step expect prompts
    so device-side confirmations don't deadlock the session."""
    from netmiko import ConnectHandler

    # Reuse the existing deploy's vendor → netmiko driver map.
    from .collector import _NETMIKO_TYPE
    device_type = _NETMIKO_TYPE.get(vendor_key, "cisco_ios")
    is_procurve = vendor_key in {"hp_procurve", "procurve"}

    conn_params = {
        "device_type":         device_type,
        "host":                host,
        "port":                port,
        "username":            cred_data.get("username", ""),
        "password":            cred_data.get("password", ""),
        "timeout":             60 if is_procurve else 60,
        "conn_timeout":        30,
        "auth_timeout":        30,
        "banner_timeout":      30,
        "fast_cli":            False,
        "global_delay_factor": 2,
    }
    if cred_data.get("enable_secret"):
        conn_params["secret"] = cred_data["enable_secret"]
    elif vendor_key in {"arista", "cisco_ios", "cisco_iosxe", "cisco_iosxr",
                        "cisco_nxos", "aruba_cx"}:
        conn_params["secret"] = cred_data.get("password", "")

    output_parts: list[str] = []
    with ConnectHandler(**conn_params) as conn:
        # Enable / privileged exec — recipes don't enter config mode explicitly;
        # most vendors' replace commands are run from exec.
        try:
            conn.enable()
        except Exception:
            pass

        for step in recipe.steps:
            line_prefix = f"$ {step.command}"
            try:
                if step.expect:
                    out = conn.send_command_timing(
                        step.command,
                        strip_prompt=False, strip_command=False,
                        last_read=step.delay,
                    )
                    # If the expected prompt appeared, send the response.
                    import re as _re
                    if _re.search(step.expect, out or "", _re.IGNORECASE):
                        out2 = conn.send_command_timing(
                            step.response or "",
                            strip_prompt=False, strip_command=False,
                            last_read=step.delay,
                        )
                        out = (out or "") + (out2 or "")
                else:
                    out = conn.send_command_timing(
                        step.command,
                        strip_prompt=False, strip_command=False,
                        last_read=step.delay,
                    )
            except Exception as exc:
                output_parts.append(f"{line_prefix}\n!! step failed: {exc}")
                raise
            output_parts.append(f"{line_prefix}\n{out or ''}")
            if step.delay > 0:
                time.sleep(min(step.delay, 0.5))  # tiny safety pause; main wait is in send_command_timing

        if recipe.show_running_after:
            try:
                out = conn.send_command("show running-config",
                                        read_timeout=30, strip_prompt=False)
                output_parts.append(f"$ show running-config\n{out[:4000]}")
            except Exception:
                pass

    return "\n".join(output_parts).strip()
