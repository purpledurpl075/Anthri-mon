"""Config backup collector.

Runs as a background task inside the FastAPI process.  Every
`interval_s` seconds it iterates all active devices that have an SSH
credential assigned, connects via Netmiko, fetches the running-config,
and stores it if the hash changed.
"""
from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Optional

import structlog
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models.config import ConfigBackup, ConfigDiff
from ..models.credential import Credential, DeviceCredential
from ..models.device import Device

logger = structlog.get_logger(__name__)

# Netmiko device_type per vendor string
_NETMIKO_TYPE: dict[str, str] = {
    "arista":           "arista_eos",
    "cisco_ios":        "cisco_ios",
    "cisco_iosxe":      "cisco_ios",
    "cisco_iosxr":      "cisco_xr",
    "cisco_nxos":       "cisco_nxos",
    "juniper":          "juniper_junos",
    "procurve":         "hp_procurve",
    "hp_procurve":      "hp_procurve",
    "aruba_cx":         "aruba_aoscx",
    "fortios":          "fortinet",
    "ubiquiti":         "linux",
}

# Command to retrieve running config per vendor
_SHOW_RUN: dict[str, str] = {
    "arista":           "show running-config",
    "cisco_ios":        "show running-config",
    "cisco_iosxe":      "show running-config",
    "cisco_iosxr":      "show running-config all",
    "cisco_nxos":       "show running-config",
    "juniper":          "show configuration | display set",
    "hp_procurve":      "show running-config",
    "aruba_cx":         "show running-config",
    "fortios":          "show full-configuration",
    "ubiquiti":         "cat /tmp/system.cfg",
}

DEFAULT_INTERVAL_S = 3600  # collect every hour


def _vendor_key(device: Device) -> str:
    """Normalise vendor/device-type to a key in the lookup tables."""
    v = (device.vendor or "").lower()
    dt = (device.device_type or "").lower()
    for k in _NETMIKO_TYPE:
        if k in v or k in dt:
            return k
    # EOS / Arista heuristic
    if "eos" in v or "arista" in v:
        return "arista"
    if "ios" in v or "cisco" in v:
        return "cisco_ios"
    return "cisco_ios"  # safe fallback for most gear


_PARAMIKO_VENDORS = {"hp_procurve", "procurve"}  # vendors that need raw paramiko exec_command


def _collect_ssh_paramiko(host: str, port: int, command: str, cred_data: dict) -> str:
    """Use paramiko invoke_shell for devices that don't work with Netmiko's
    interactive session setup (e.g. HP ProCurve which ignores terminal width)."""
    import paramiko, time, socket

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=host, port=port,
        username=cred_data.get("username", ""),
        password=cred_data.get("password", ""),
        timeout=30, look_for_keys=False, allow_agent=False,
    )
    try:
        shell = client.invoke_shell(width=200, height=200)
        shell.settimeout(5)

        def _read_until_prompt(timeout: float = 10.0) -> str:
            """Read until we see a shell prompt (ends with # or >)."""
            buf, deadline = "", time.time() + timeout
            while time.time() < deadline:
                try:
                    chunk = shell.recv(4096).decode("utf-8", errors="replace")
                    buf += chunk
                    # HP ProCurve prompt ends with "# " or "> "
                    stripped = buf.rstrip()
                    if stripped.endswith(("#", ">")):
                        break
                except socket.timeout:
                    if buf.rstrip().endswith(("#", ">")):
                        break
            return buf

        # Wait for initial prompt
        _read_until_prompt(15)

        # Disable paging so the full config comes back without -- MORE --
        shell.send("no page\n")
        _read_until_prompt(5)

        # Request config
        shell.send(command + "\n")
        output = _read_until_prompt(30)

        # Strip the command echo and trailing prompt
        lines = output.splitlines()
        # Remove first line (command echo) and last line (prompt)
        if len(lines) > 2:
            lines = lines[1:-1]
        return "\n".join(lines).strip()
    finally:
        client.close()


def _collect_ssh(host: str, port: int, vendor_key: str, cred_data: dict) -> str:
    """Synchronous SSH collection via Netmiko (runs in a thread pool)."""
    if vendor_key in _PARAMIKO_VENDORS:
        command = _SHOW_RUN.get(vendor_key, "show running-config")
        return _collect_ssh_paramiko(host, port, command, cred_data)

    from netmiko import ConnectHandler

    device_type = _NETMIKO_TYPE.get(vendor_key, "cisco_ios")
    command = _SHOW_RUN.get(vendor_key, "show running-config")

    # ProCurve/ProVision switches are slow to respond during SSH session setup
    is_procurve = vendor_key in {"hp_procurve"}

    conn_params = {
        "device_type":         device_type,
        "host":                host,
        "port":                port,
        "username":            cred_data.get("username", ""),
        "password":            cred_data.get("password", ""),
        "timeout":             60 if is_procurve else 30,
        "conn_timeout":        30 if is_procurve else 15,
        "auth_timeout":        30 if is_procurve else 20,
        "banner_timeout":      30 if is_procurve else 20,
        "fast_cli":            False,
        "global_delay_factor": 4 if is_procurve else 1,
    }
    # Vendors that need privileged EXEC mode to run show running-config
    _NEEDS_ENABLE = {"arista", "cisco_ios", "cisco_iosxe", "cisco_iosxr",
                     "cisco_nxos", "hp_procurve", "aruba_cx"}

    if cred_data.get("enable_secret"):
        conn_params["secret"] = cred_data["enable_secret"]
    elif vendor_key in _NEEDS_ENABLE:
        # Try enable with the login password as the enable secret (common default),
        # then fall back to empty string. Silently ignore failures — some devices
        # have the user already at privilege 15.
        conn_params["secret"] = cred_data.get("password", "")

    with ConnectHandler(**conn_params) as conn:
        if vendor_key in _NEEDS_ENABLE:
            try:
                conn.enable()
            except Exception:
                pass  # already privileged, or device doesn't use enable
        output = conn.send_command(command, read_timeout=60)

    # Guard against collecting an error message instead of a config
    if output and ("Invalid input" in output or "% Error" in output) and len(output) < 200:
        raise RuntimeError(f"Device returned an error: {output[:100]}")

    return output.strip()


async def collect_device(device_id: str, db: AsyncSession) -> Optional[ConfigBackup]:
    """Collect running config for one device.  Returns the new ConfigBackup if
    a change was detected, else None."""
    from .. import crypto

    # Load device
    dev = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if dev is None or not dev.is_active:
        return None

    # Find SSH credential
    cred_row = (await db.execute(
        select(DeviceCredential, Credential)
        .join(Credential, Credential.id == DeviceCredential.credential_id)
        .where(DeviceCredential.device_id == device_id, Credential.type == "ssh")
        .order_by(DeviceCredential.priority)
    )).first()
    if cred_row is None:
        logger.debug("config_collect_skip_no_ssh", device=str(device_id))
        return None

    _, cred = cred_row
    cred_data = cred.data if isinstance(cred.data, dict) else json.loads(cred.data)

    # Decrypt password
    if cred_data.get("password") and crypto.is_configured():
        try:
            cred_data["password"] = crypto.decrypt(cred_data["password"])
        except Exception:
            pass

    host    = str(dev.mgmt_ip).split("/")[0]
    port    = 22
    vendor  = _vendor_key(dev)

    loop = asyncio.get_running_loop()
    try:
        config_text = await loop.run_in_executor(
            None, _collect_ssh, host, port, vendor, cred_data
        )
    except Exception as exc:
        logger.warning("config_collect_failed", device=dev.hostname, error=str(exc))
        return None

    if not config_text:
        return None

    config_hash = hashlib.sha256(config_text.encode()).hexdigest()

    # Load current latest backup
    prev = (await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id, ConfigBackup.is_latest == True)  # noqa: E712
    )).scalar_one_or_none()

    # Skip if unchanged
    if prev and prev.config_hash == config_hash:
        logger.debug("config_collect_unchanged", device=dev.hostname)
        return None

    now = datetime.now(timezone.utc)

    # Create new backup
    backup = ConfigBackup(
        device_id=device_id,
        collected_at=now,
        config_text=config_text,
        config_hash=config_hash,
        collection_method="ssh_show_run",
        is_latest=True,
    )
    db.add(backup)

    # Clear old is_latest
    if prev:
        await db.execute(
            update(ConfigBackup)
            .where(ConfigBackup.id == prev.id)
            .values(is_latest=False)
        )

    await db.flush()  # get backup.id

    # Generate diff
    if prev:
        prev_lines = prev.config_text.splitlines(keepends=True)
        curr_lines = config_text.splitlines(keepends=True)
        diff_lines = list(difflib.unified_diff(
            prev_lines, curr_lines,
            fromfile=f"previous ({prev.collected_at.strftime('%Y-%m-%d %H:%M')})",
            tofile=f"current ({now.strftime('%Y-%m-%d %H:%M')})",
            lineterm="",
        ))
        diff_text     = "".join(diff_lines)
        lines_added   = sum(1 for l in diff_lines if l.startswith("+") and not l.startswith("+++"))
        lines_removed = sum(1 for l in diff_lines if l.startswith("-") and not l.startswith("---"))

        diff = ConfigDiff(
            device_id=device_id,
            prev_backup_id=prev.id,
            curr_backup_id=backup.id,
            diff_text=diff_text,
            lines_added=lines_added,
            lines_removed=lines_removed,
        )
        db.add(diff)

    await db.commit()
    logger.info("config_collected", device=dev.hostname, hash=config_hash[:12],
                changed=prev is not None)
    return backup


class ConfigCollector:
    """Background loop that periodically collects configs for all devices."""

    def __init__(self, interval_s: int = DEFAULT_INTERVAL_S):
        self.interval_s = interval_s

    async def run(self) -> None:
        logger.info("config_collector_started", interval_s=self.interval_s)
        # Stagger startup by 60 s to avoid hammering devices on API restart
        await asyncio.sleep(60)
        while True:
            try:
                await self._collect_all()
            except Exception:
                logger.exception("config_collector_error")
            await asyncio.sleep(self.interval_s)

    async def _collect_all(self) -> None:
        async with AsyncSessionLocal() as db:
            device_rows = (await db.execute(
                select(Device.id, Device.hostname)
                .where(Device.is_active == True)  # noqa: E712
            )).all()

        logger.info("config_collect_cycle_start", devices=len(device_rows))
        for row in device_rows:
            try:
                async with AsyncSessionLocal() as db:
                    await collect_device(str(row.id), db)
            except Exception as exc:
                logger.warning("config_collect_device_error",
                               device=row.hostname, error=str(exc))
            # Brief pause between devices to avoid SSH connection storms
            await asyncio.sleep(2)


def start_config_collector(interval_s: int = DEFAULT_INTERVAL_S) -> asyncio.Task:
    collector = ConfigCollector(interval_s=interval_s)
    return asyncio.create_task(collector.run(), name="config-collector")
