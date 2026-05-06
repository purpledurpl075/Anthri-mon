from __future__ import annotations

import asyncio
import smtplib
import ssl
from datetime import datetime, timezone
from email.mime.text import MIMEText
from typing import TYPE_CHECKING, Optional

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crypto
from ..models.alert import NotificationChannel
from ..models.settings import SystemSetting

if TYPE_CHECKING:
    from ..models.alert import Alert, AlertRule

logger = structlog.get_logger(__name__)

_SMTP_KEY = "smtp"


async def _load_smtp(db: AsyncSession) -> Optional[dict]:
    """Load and decrypt SMTP server config from system_settings."""
    try:
        row = (await db.execute(
            select(SystemSetting).where(SystemSetting.key == _SMTP_KEY)
        )).scalar_one_or_none()
    except Exception:
        # Table doesn't exist yet (migration pending) — treat as unconfigured.
        return None
    if row is None or not row.value.get("host"):
        return None
    cfg = dict(row.value)
    if cfg.get("password") and crypto.is_configured():
        try:
            cfg["password"] = crypto.decrypt(cfg["password"])
        except Exception:
            cfg["password"] = ""
    return cfg


async def dispatch(alert: Alert, rule: AlertRule, db: AsyncSession, *, resolved: bool = False) -> None:
    if not rule.channel_ids:
        return

    channels = (await db.execute(
        select(NotificationChannel).where(
            NotificationChannel.id.in_([str(c) for c in rule.channel_ids]),
            NotificationChannel.is_enabled == True,  # noqa: E712
        )
    )).scalars().all()

    email_channels = [c for c in channels if c.type == "email"]
    other_channels = [c for c in channels if c.type != "email"]

    for c in other_channels:
        logger.debug("notify_channel_type_not_implemented", type=c.type)

    if not email_channels:
        return

    smtp = await _load_smtp(db)
    if smtp is None:
        logger.warning("notify_smtp_not_configured", alert_id=str(alert.id))
        return

    subject, body = _build_email(alert, rule, resolved)
    loop = asyncio.get_running_loop()

    for channel in email_channels:
        recipients: list[str] = channel.config.get("to", [])
        if not recipients:
            continue
        try:
            await loop.run_in_executor(None, _send_smtp, smtp, recipients, subject, body)
            logger.info("notify_sent", channel_id=str(channel.id), type="email",
                        alert_id=str(alert.id), resolved=resolved)
        except Exception as exc:
            logger.error("notify_dispatch_error", channel_id=str(channel.id),
                         alert_id=str(alert.id), error=str(exc))


def _build_email(alert: Alert, rule: AlertRule, resolved: bool) -> tuple[str, str]:
    tag = "RESOLVED" if resolved else alert.severity.upper()
    subject = f"[{tag}] {alert.title}"

    lines = [
        f"Alert:     {alert.title}",
        f"Severity:  {alert.severity}",
        f"Status:    {'resolved' if resolved else alert.status}",
        f"Rule:      {rule.name}",
    ]
    if alert.message:
        lines.append(f"Details:   {alert.message}")

    ctx = alert.context or {}
    if ctx.get("value") is not None:
        lines.append(f"Value:     {ctx['value']}")
    if ctx.get("threshold") is not None:
        lines.append(f"Threshold: {ctx['threshold']}")

    lines.append(f"Triggered: {alert.triggered_at.isoformat()}")
    if resolved and alert.resolved_at:
        lines.append(f"Resolved:  {alert.resolved_at.isoformat()}")

    return subject, "\n".join(lines)


def _build_test_email() -> tuple[str, str]:
    subject = "[TEST] Anthrimon notification test"
    body = "\n".join([
        "This is a test notification from Anthrimon.",
        f"Sent at: {datetime.now(timezone.utc).isoformat()}",
        "If you received this, SMTP is configured correctly.",
    ])
    return subject, body


def _send_smtp(smtp: dict, recipients: list[str], subject: str, body: str) -> None:
    """Blocking SMTP send — always call via run_in_executor."""
    host     = smtp.get("host", "")
    port     = int(smtp.get("port", 587))
    user     = smtp.get("user", "")
    password = smtp.get("password", "")
    from_addr = smtp.get("from_addr", "") or smtp.get("user", "anthrimon@localhost")
    use_ssl  = bool(smtp.get("ssl", False))

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"]    = from_addr
    msg["To"]      = ", ".join(recipients)

    if use_ssl:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, context=ctx) as srv:
            if user:
                srv.login(user, password)
            srv.sendmail(from_addr, recipients, msg.as_string())
    else:
        with smtplib.SMTP(host, port) as srv:
            srv.ehlo()
            if srv.has_extn("STARTTLS"):
                srv.starttls()
                srv.ehlo()
            if user:
                srv.login(user, password)
            srv.sendmail(from_addr, recipients, msg.as_string())
