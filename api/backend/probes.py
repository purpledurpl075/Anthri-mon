"""In-platform ping / traceroute / mtr — runnable from the hub or any registered
remote collector.

The hub-side path is a thin wrapper around the OS commands, streamed line-by-line
through an asyncio subprocess.  The remote-collector path opens a chunked HTTP
connection to the collector's WireGuard control server and forwards newline-
delimited JSON events back to the WebSocket caller verbatim.

Caller protocol (WebSocket / generator):
    {"event": "start",   "command": "ping -c 5 8.8.8.8", "source": "hub"}
    {"event": "line",    "data": "PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data."}
    {"event": "line",    "data": "64 bytes from 8.8.8.8: icmp_seq=1 ttl=119 time=2.50 ms"}
    ...
    {"event": "complete", "exit_code": 0}

Any error from the runner produces:
    {"event": "error",   "detail": "..."}
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import shutil
from dataclasses import dataclass
from typing import AsyncIterator, Optional

import httpx
import structlog

logger = structlog.get_logger(__name__)

# Hard caps applied no matter what the caller asks for.
_MAX_COUNT     = 60
_MAX_MAX_HOPS  = 32
_MAX_TIMEOUT_S = 10


PROBE_TYPES = ("ping", "traceroute", "mtr")


@dataclass
class ProbeRequest:
    target:    str            # hostname or IP
    type:      str            # "ping" | "traceroute" | "mtr"
    source:    str            # "hub" or a remote collector ID (UUID string)
    count:     int = 5
    timeout_s: int = 3
    max_hops:  int = 24

    def sanitize(self) -> None:
        if self.type not in PROBE_TYPES:
            raise ValueError(f"type must be one of {PROBE_TYPES}")
        if not _valid_target(self.target):
            raise ValueError("target must be a hostname or IP without shell metacharacters")
        self.count     = max(1, min(self.count,     _MAX_COUNT))
        self.timeout_s = max(1, min(self.timeout_s, _MAX_TIMEOUT_S))
        self.max_hops  = max(1, min(self.max_hops,  _MAX_MAX_HOPS))


# Targets are validated with a whitelist regex — we explicitly REFUSE shell
# metacharacters even though we use exec (not shell).  Belt + braces.
_TARGET_RE = re.compile(r"^[A-Za-z0-9._:-]{1,253}$")
def _valid_target(s: str) -> bool:
    if not _TARGET_RE.match(s):
        return False
    # Reject targets that look like CLI options
    if s.startswith("-"):
        return False
    # If it parses as an IP, accept.  Otherwise treat as DNS name (validated by the regex).
    try:
        ipaddress.ip_address(s)
    except ValueError:
        pass
    return True


def _build_command(req: ProbeRequest) -> list[str]:
    """Compose the OS command for a probe request.

    Resolves to the absolute path via `which` so we don't depend on $PATH
    being set in the systemd service environment.
    """
    if req.type == "ping":
        ping = shutil.which("ping") or "/bin/ping"
        # Compatible with both iputils-ping and busybox ping.
        return [ping, "-n", "-c", str(req.count), "-W", str(req.timeout_s), req.target]
    if req.type == "traceroute":
        tr = shutil.which("traceroute") or "/usr/sbin/traceroute"
        # inetutils-traceroute (often shipped on minimal Debian installs)
        # doesn't accept -n.  Use only flags both implementations support:
        # -w (wait), -q (queries), -m (max hops).  Without -n you get DNS
        # names, which our parser already handles (it reads either IP or host).
        return [tr, "-w", str(req.timeout_s), "-q", "1", "-m", str(req.max_hops), req.target]
    if req.type == "mtr":
        mtr = shutil.which("mtr") or "/usr/sbin/mtr"
        # Long-form flags work across mtr (full) and mtr-tiny.  Some Ubuntu
        # mtr-tiny 0.95 builds STILL abort with "buffer overflow detected" —
        # the runner watches stderr/stdout for that string and surfaces a
        # cleaner error pointing to the apt-get fix.
        return [mtr, "--report", "--report-cycles", str(req.count), "--no-dns", req.target]
    raise ValueError(f"unsupported probe type {req.type!r}")


async def run_local(req: ProbeRequest) -> AsyncIterator[dict]:
    """Run a probe on this host (the hub) and yield protocol events.

    Caller owns lifecycle — if the iterator is closed, the subprocess is
    terminated.  Stops yielding once the subprocess exits.
    """
    req.sanitize()
    cmd = _build_command(req)
    # Strip leading paths from the displayed command — operators don't need
    # to know we resolved `ping` to /usr/bin/ping.
    display_cmd = [cmd[0].rsplit("/", 1)[-1], *cmd[1:]]
    yield {"event": "start", "command": " ".join(display_cmd), "source": "hub"}

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        assert proc.stdout is not None
        glibc_abort = False
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip("\n")
            if not text:
                continue
            # Catch glibc fortify-check aborts — common on Ubuntu's mtr-tiny.
            if "buffer overflow detected" in text or "stack smashing detected" in text:
                glibc_abort = True
                continue   # don't show the abort message itself
            yield {"event": "line", "data": text}
        rc = await proc.wait()
        if glibc_abort and req.type == "mtr":
            yield {
                "event":  "error",
                "detail": ("mtr crashed with a glibc fortify abort — the installed "
                           "mtr-tiny package has a known bug.  Install the full mtr "
                           "package: `sudo apt-get install -y mtr`."),
            }
            return
        yield {"event": "complete", "exit_code": rc}
    except asyncio.CancelledError:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            proc.kill()
        raise
    except Exception as exc:
        logger.error("probe_runner_error", source="hub", error=str(exc))
        yield {"event": "error", "detail": str(exc)}
        try:
            proc.terminate()
        except ProcessLookupError:
            pass


async def run_remote(req: ProbeRequest, collector_wg_ip: str, api_key_hash: str,
                     hub_token_signer) -> AsyncIterator[dict]:
    """Forward a probe request to a remote collector and stream its output.

    The collector exposes /probe-icmp on its WireGuard control port (9090) —
    we POST our request and read newline-delimited JSON back.

    `hub_token_signer` is the same `_collector_token` helper the rest of the
    devices router uses; passing it in avoids a circular import.
    """
    req.sanitize()
    url = f"http://{collector_wg_ip}:9090/probe-icmp"
    headers = {
        "Authorization": f"Bearer {hub_token_signer(api_key_hash)}",
        "Content-Type":  "application/json",
    }
    payload = {
        "type":      req.type,
        "target":    req.target,
        "count":     req.count,
        "timeout_s": req.timeout_s,
        "max_hops":  req.max_hops,
    }
    # Total expected duration is bounded by count × timeout per probe type.
    overall_timeout = max(30.0, req.count * (req.timeout_s + 1) + 10.0)
    yield {"event": "start", "source": collector_wg_ip,
           "command": f"{req.type} {req.target} (remote)"}

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(overall_timeout, read=overall_timeout)) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    detail = await resp.aread()
                    yield {"event": "error",
                           "detail": f"collector HTTP {resp.status_code}: {detail.decode('utf-8','replace')[:300]}"}
                    return
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        # Treat unparsable lines as raw output
                        yield {"event": "line", "data": line}
                        continue
                    yield ev
    except httpx.TimeoutException:
        yield {"event": "error", "detail": "probe timed out talking to remote collector"}
    except httpx.RequestError as exc:
        yield {"event": "error", "detail": f"connect to collector failed: {exc}"}
    except asyncio.CancelledError:
        # WebSocket disconnected — httpx will close its connection on exit.
        raise
    except Exception as exc:
        logger.error("probe_remote_error", error=str(exc))
        yield {"event": "error", "detail": str(exc)}
