"""Golden config drift evaluator.

A golden config is a template of expected config lines for a vendor/site.
Each enabled golden config is matched against devices via `device_selector`
(same format as compliance policies: `device_ids` / `vendors`). On every
config backup, matching devices are scored against the template:

  score = (template lines found in the device's config) / (total template lines) * 100

`{{var}}` placeholders in the template are substituted with per-device
values (hostname, mgmt_ip, vendor, device_type, fqdn) before comparison.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.config import ConfigBackup, GoldenConfig, GoldenConfigResult
from ..models.device import Device

logger = structlog.get_logger(__name__)


def _normalize_lines(text: str) -> list[str]:
    """Split into stripped, non-blank, non-comment-only lines."""
    lines = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("!") or line.startswith("#"):
            continue
        lines.append(line)
    return lines


def _device_vars(dev: Device) -> dict:
    """Built-in per-device template variables (mirrors routers/config_mgmt.py)."""
    return {
        "hostname":    dev.display_name,
        "mgmt_ip":     dev.mgmt_ip_str,
        "vendor":      dev.vendor or "",
        "device_type": dev.device_type or "",
        "fqdn":        dev.display_name,
    }


def _substitute_text(text: str, variables: dict) -> str:
    """Replace {{var}} placeholders in text with values from the variables dict."""
    for k, v in variables.items():
        text = text.replace(f"{{{{{k}}}}}", str(v))
    return text


def score_against_golden(
    template_text: str, config_text: str, variables: dict
) -> tuple[float, int, int, list[str]]:
    """Return (score, matched_lines, total_lines, missing_lines)."""
    template_lines = _normalize_lines(_substitute_text(template_text, variables))
    config_lines = set(_normalize_lines(config_text))

    total = len(template_lines)
    if total == 0:
        return 100.0, 0, 0, []

    missing = [line for line in template_lines if line not in config_lines]
    matched = total - len(missing)
    score = round(matched / total * 100, 2)
    return score, matched, total, missing


async def evaluate_golden_config(
    golden: GoldenConfig,
    device: Device,
    config_text: str,
    backup_id: Optional[str],
    db: AsyncSession,
) -> GoldenConfigResult:
    """Score a device's config against a golden config and store the result."""
    score, matched, total, missing = score_against_golden(
        golden.template_text, config_text, _device_vars(device)
    )

    result = GoldenConfigResult(
        device_id=device.id,
        golden_config_id=golden.id,
        backup_id=backup_id,
        checked_at=datetime.now(timezone.utc),
        score=score,
        matched_lines=matched,
        total_lines=total,
        missing_lines=missing,
    )
    db.add(result)
    await db.commit()
    return result


async def run_golden_configs_for_device(device_id: str, db: AsyncSession) -> list[GoldenConfigResult]:
    """Evaluate all enabled golden configs that match a device against its latest backup."""
    dev = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if dev is None:
        return []

    backup = (await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id, ConfigBackup.is_latest == True)  # noqa: E712
    )).scalar_one_or_none()
    if backup is None:
        logger.debug("golden_config_skip_no_backup", device=str(device_id))
        return []

    goldens = (await db.execute(
        select(GoldenConfig)
        .where(
            GoldenConfig.tenant_id == dev.tenant_id,
            GoldenConfig.is_enabled == True,  # noqa: E712
        )
    )).scalars().all()

    results = []
    for golden in goldens:
        sel = golden.device_selector
        if sel:
            if "device_ids" in sel and str(device_id) not in (sel["device_ids"] or []):
                continue
            if "vendors" in sel and dev.vendor not in (sel["vendors"] or []):
                continue

        r = await evaluate_golden_config(golden, dev, backup.config_text, str(backup.id), db)
        results.append(r)
        if r.score < 100:
            logger.info("golden_config_drift", device=dev.hostname, golden=golden.name, score=float(r.score))

    return results
