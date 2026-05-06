from __future__ import annotations

import asyncio
import smtplib
import ssl
from email.mime.text import MIMEText
from typing import TYPE_CHECKING

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models.alert import NotificationChannel

if TYPE_CHECKING:
    from ..models.alert import Alert, AlertRule

logger = structlog.get_logger(__name__)
_settings = get_settings()


async def dispatch(alert: Alert, rule: AlertRule, db: AsyncSession, *, resolved: bool = False) -> None:
    if not rule.channel_ids:
        return

    channels = (await db.execute(
        select(NotificationChannel).where(
            NotificationChannel.id.in_([str(c) for c in rule.channel_ids]),
            NotificationChannel.is_enabled == True,  # noqa: E712
        )
    )).scalars().all()

    loop = asyncio.get_running_loop()
    for channel in channels:
        try:
            if channel.type == "email":
                subject, body = _build_email(alert, rule, resolved)
                await loop.run_in_executor(None, _send_smtp, channel.config, subject, body)
                logger.info("notify_sent", channel_id=str(channel.id), type="email",
                            alert_id=str(alert.id), resolved=resolved)
            else:
                logger.debug("notify_channel_type_not_implemented", type=channel.type)
        except Exception as exc:
            logger.error("notify_dispatch_error", channel_id=str(channel.id),
                         type=channel.type, alert_id=str(alert.id), error=str(exc))


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


def _send_smtp(config: dict, subject: str, body: str) -> None:
    """Blocking SMTP send — always run via run_in_executor."""
    s = _settings
    if not s.smtp_host:
        logger.warning("notify_smtp_not_configured")
        return

    recipients: list[str] = config.get("to", [])
    if not recipients:
        return

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = s.smtp_from
    msg["To"] = ", ".join(recipients)

    if s.smtp_ssl:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, context=ctx) as srv:
            if s.smtp_user:
                srv.login(s.smtp_user, s.smtp_password)
            srv.sendmail(s.smtp_from, recipients, msg.as_string())
    else:
        with smtplib.SMTP(s.smtp_host, s.smtp_port) as srv:
            srv.ehlo()
            if srv.has_extn("STARTTLS"):
                srv.starttls()
                srv.ehlo()
            if s.smtp_user:
                srv.login(s.smtp_user, s.smtp_password)
            srv.sendmail(s.smtp_from, recipients, msg.as_string())
