from __future__ import annotations

import smtplib
from email.message import EmailMessage
from typing import Any

import aiohttp
import structlog

from .config import NotificationsConfig

logger = structlog.get_logger(__name__)


async def send_alert_notification(
    cfg: NotificationsConfig,
    title: str,
    message: str,
    severity: str,
    context: dict[str, Any],
    channels: list[dict],  # rows from notification_channels for this alert
) -> None:
    """Send to every configured channel. Falls back to global config if no channels."""
    sent = False

    for ch in channels:
        ch_type = ch["type"]
        ch_cfg = ch["config"] or {}
        try:
            if ch_type == "slack":
                await _slack(ch_cfg.get("webhook_url", ""), title, message, severity)
                sent = True
            elif ch_type == "email":
                _email_sync(ch_cfg, title, message, severity)
                sent = True
            elif ch_type == "webhook":
                await _webhook(ch_cfg.get("url", ""), title, message, severity, context)
                sent = True
        except Exception as exc:
            logger.error("notification_failed", channel=ch.get("name"), type=ch_type, error=str(exc))

    if sent:
        return

    # Fall back to global SMTP/Slack config when rule has no channels.
    if cfg.slack.enabled and cfg.slack.webhook_url:
        try:
            await _slack(cfg.slack.webhook_url, title, message, severity)
        except Exception as exc:
            logger.error("slack_fallback_failed", error=str(exc))

    if cfg.smtp.enabled and cfg.smtp.to_addr:
        try:
            _email_sync(
                {"host": cfg.smtp.host, "port": cfg.smtp.port,
                 "from": cfg.smtp.from_addr, "to": cfg.smtp.to_addr,
                 "username": cfg.smtp.username, "password": cfg.smtp.password},
                title, message, severity,
            )
        except Exception as exc:
            logger.error("smtp_fallback_failed", error=str(exc))


async def send_resolve_notification(
    cfg: NotificationsConfig,
    title: str,
    channels: list[dict],
) -> None:
    msg = f"RESOLVED: {title}"
    await send_alert_notification(cfg, msg, msg, "info", {}, channels)


# ── Transport implementations ─────────────────────────────────────────────────

_SEV_COLOUR = {
    "critical": "#d32f2f",
    "major":    "#f57c00",
    "minor":    "#fbc02d",
    "warning":  "#1976d2",
    "info":     "#388e3c",
}


async def _slack(webhook_url: str, title: str, message: str, severity: str) -> None:
    colour = _SEV_COLOUR.get(severity, "#888")
    payload = {
        "attachments": [{
            "color":    colour,
            "title":    f"[{severity.upper()}] {title}",
            "text":     message,
            "fallback": f"[{severity.upper()}] {title}: {message}",
        }]
    }
    async with aiohttp.ClientSession() as session:
        resp = await session.post(webhook_url, json=payload, timeout=aiohttp.ClientTimeout(total=10))
        resp.raise_for_status()


def _email_sync(cfg: dict, title: str, message: str, severity: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = f"[Anthrimon {severity.upper()}] {title}"
    msg["From"]    = cfg.get("from", "anthrimon@localhost")
    msg["To"]      = cfg.get("to", "")
    msg.set_content(f"{title}\n\n{message}")

    host = cfg.get("host", "localhost")
    port = int(cfg.get("port", 25))
    username = cfg.get("username", "")
    password = cfg.get("password", "")

    with smtplib.SMTP(host, port, timeout=10) as s:
        if username:
            s.login(username, password)
        s.send_message(msg)


async def _webhook(url: str, title: str, message: str, severity: str, context: dict) -> None:
    payload = {"title": title, "message": message, "severity": severity, "context": context}
    async with aiohttp.ClientSession() as session:
        resp = await session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10))
        resp.raise_for_status()
