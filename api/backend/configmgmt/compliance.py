"""Compliance policy evaluator.

Each policy holds a list of rules evaluated against a device's latest
config backup.  Rule types:

  regex_present  — pattern must be found somewhere in the config
  regex_absent   — pattern must NOT be found
  contains       — literal substring must be present
  not_contains   — literal substring must be absent
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.config import CompliancePolicy, ComplianceResult, ConfigBackup
from ..models.device import Device

logger = structlog.get_logger(__name__)


def _eval_rule(rule: dict, config_text: str) -> dict:
    """Evaluate a single rule against config text.  Returns a finding dict."""
    rule_type   = rule.get("type", "regex_present")
    pattern     = rule.get("pattern", "")
    description = rule.get("description", pattern)
    finding: dict = {"description": description, "type": rule_type}

    try:
        if rule_type == "regex_present":
            m = re.search(pattern, config_text, re.MULTILINE | re.IGNORECASE)
            if m:
                finding["status"]       = "pass"
                finding["matched_text"] = m.group(0)[:200]
            else:
                finding["status"]       = "fail"
                finding["matched_text"] = None

        elif rule_type == "regex_absent":
            m = re.search(pattern, config_text, re.MULTILINE | re.IGNORECASE)
            if m:
                finding["status"]       = "fail"
                finding["matched_text"] = m.group(0)[:200]
            else:
                finding["status"]       = "pass"
                finding["matched_text"] = None

        elif rule_type == "contains":
            if pattern in config_text:
                finding["status"] = "pass"
            else:
                finding["status"] = "fail"

        elif rule_type == "not_contains":
            if pattern not in config_text:
                finding["status"] = "pass"
            else:
                finding["status"] = "fail"

        else:
            finding["status"] = "error"
            finding["error"]  = f"Unknown rule type: {rule_type}"

    except re.error as exc:
        finding["status"] = "error"
        finding["error"]  = f"Invalid regex: {exc}"

    return finding


async def evaluate_policy(
    policy: CompliancePolicy,
    device: Device,
    config_text: str,
    backup_id: Optional[str],
    db: AsyncSession,
) -> ComplianceResult:
    """Evaluate all rules in a policy against a single device's config."""
    findings = [_eval_rule(rule, config_text) for rule in (policy.rules or [])]
    overall  = "pass" if all(f["status"] == "pass" for f in findings) else "fail"
    if any(f["status"] == "error" for f in findings):
        overall = "error"

    result = ComplianceResult(
        device_id=device.id,
        policy_id=policy.id,
        backup_id=backup_id,
        checked_at=datetime.now(timezone.utc),
        status=overall,
        findings=findings,
    )
    db.add(result)
    await db.commit()
    return result


async def run_compliance_for_device(device_id: str, db: AsyncSession) -> list[ComplianceResult]:
    """Run all enabled policies against a device's latest backup."""
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
        logger.debug("compliance_skip_no_backup", device=str(device_id))
        return []

    policies = (await db.execute(
        select(CompliancePolicy)
        .where(
            CompliancePolicy.tenant_id == dev.tenant_id,
            CompliancePolicy.is_enabled == True,  # noqa: E712
        )
    )).scalars().all()

    results = []
    for policy in policies:
        # Check device selector
        sel = policy.device_selector
        if sel:
            if "device_ids" in sel and str(device_id) not in (sel["device_ids"] or []):
                continue
            if "vendors" in sel and dev.vendor not in (sel["vendors"] or []):
                continue

        r = await evaluate_policy(
            policy, dev, backup.config_text, str(backup.id), db
        )
        results.append(r)
        if r.status == "fail":
            logger.info("compliance_fail", device=dev.hostname, policy=policy.name)

    return results
