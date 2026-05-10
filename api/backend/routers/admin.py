from __future__ import annotations

import asyncio
from textwrap import dedent

import structlog
from fastapi import APIRouter, Depends, HTTPException
from typing import Optional

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crypto
from ..alerting.notify import _build_test_email, _send_smtp
from ..dependencies import get_db, require_role
from ..models.settings import SystemSetting
from ..models.tenant import User
from ..schemas.admin import SmtpSettingsRead, SmtpSettingsWrite

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/admin", tags=["admin"])

_SMTP_KEY     = "smtp"
_TEMPLATE_KEY = "email_template"
_PLATFORM_KEY = "platform"

PLATFORM_DEFAULTS: dict = {
    # General
    "base_url":                      "",
    "platform_name":                 "Anthrimon",
    "timezone":                      "UTC",
    # Session & security
    "session_timeout_hours":         24,
    # Alerting engine
    "alert_eval_interval_s":         15,
    "default_renotify_s":            3600,
    "max_alerts_per_device_per_hour": 0,
    "auto_close_stale_days":         0,
    # Notifications
    "notifications_paused":          False,
    "notifications_paused_until":    None,
    "business_hours_enabled":        False,
    "business_hours_start":          8,
    "business_hours_end":            18,
    "business_days":                 [0, 1, 2, 3, 4],
    # Data
    "alert_retention_days":          90,
}


class PlatformSettingsRead(BaseModel):
    base_url:                       str
    platform_name:                  str
    timezone:                       str
    session_timeout_hours:          int
    alert_eval_interval_s:          int
    default_renotify_s:             int
    max_alerts_per_device_per_hour: int
    auto_close_stale_days:          int
    notifications_paused:           bool
    notifications_paused_until:     Optional[str]
    business_hours_enabled:         bool
    business_hours_start:           int
    business_hours_end:             int
    business_days:                  list[int]
    alert_retention_days:           int


class PlatformSettingsWrite(BaseModel):
    base_url:                       str        = ""
    platform_name:                  str        = "Anthrimon"
    timezone:                       str        = "UTC"
    session_timeout_hours:          int        = 24
    alert_eval_interval_s:          int        = 15
    default_renotify_s:             int        = 3600
    max_alerts_per_device_per_hour: int        = 0
    auto_close_stale_days:          int        = 0
    notifications_paused:           bool       = False
    notifications_paused_until:     Optional[str] = None
    business_hours_enabled:         bool       = False
    business_hours_start:           int        = 8
    business_hours_end:             int        = 18
    business_days:                  list[int]  = [0, 1, 2, 3, 4]
    alert_retention_days:           int        = 90

DEFAULT_SUBJECT  = "[{{tag}}] {{title}}"

DEFAULT_HTML = dedent("""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr>
    <td style="background:{{severity_color}};padding:28px 32px;">
      <p style="margin:0 0 6px;color:rgba(255,255,255,0.75);font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">{{tag}} &middot; Anthrimon</p>
      <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;line-height:1.35;">{{title}}</h1>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:28px 32px;">

      <!-- Value / threshold card -->
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:20px;">
        <tr>
          <td style="padding:14px 20px;border-right:1px solid #e2e8f0;width:50%;">
            <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1px;color:#94a3b8;text-transform:uppercase;">Value</p>
            <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#0f172a;">{{value}}</p>
          </td>
          <td style="padding:14px 20px;width:50%;">
            <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:1px;color:#94a3b8;text-transform:uppercase;">Threshold</p>
            <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#0f172a;">{{threshold}}</p>
          </td>
        </tr>
      </table>

      <!-- Details table -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;width:110px;vertical-align:top;">Rule</td>
          <td style="font-size:13px;color:#1e293b;font-weight:500;padding:5px 0;">{{rule_name}}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;">Device</td>
          <td style="font-size:13px;color:#1e293b;font-weight:500;padding:5px 0;">{{device_name}}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;">Severity</td>
          <td style="font-size:13px;font-weight:600;padding:5px 0;color:{{severity_color}};">{{severity}}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;">Triggered</td>
          <td style="font-size:13px;color:#1e293b;padding:5px 0;">{{triggered_at}}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#64748b;padding:5px 0;">Resolved</td>
          <td style="font-size:13px;color:#1e293b;padding:5px 0;">{{resolved_at}}</td>
        </tr>
      </table>

      <!-- CTA button -->
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center">
            <a href="{{alert_url}}" style="display:inline-block;background:#1e293b;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:12px 32px;border-radius:8px;letter-spacing:0.2px;">View alert &rarr;</a>
          </td>
        </tr>
      </table>

    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#94a3b8;">{{platform_name}} Network Monitor &middot; <a href="{{alert_url}}" style="color:#94a3b8;text-decoration:underline;">Manage alert</a></p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>
""")


class EmailTemplateRead(BaseModel):
    subject: str
    html:    str


class EmailTemplateWrite(BaseModel):
    subject: str
    html:    str


async def _get_smtp_row(db: AsyncSession) -> SystemSetting | None:
    return (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _SMTP_KEY)
    )).scalar_one_or_none()


@router.get("/settings/smtp", response_model=SmtpSettingsRead)
async def get_smtp_settings(
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> SmtpSettingsRead:
    row = await _get_smtp_row(db)
    if row is None:
        return SmtpSettingsRead()
    v = row.value
    return SmtpSettingsRead(
        host=v.get("host", ""),
        port=v.get("port", 587),
        user=v.get("user", ""),
        from_addr=v.get("from_addr", ""),
        ssl=v.get("ssl", False),
        password_set=bool(v.get("password")),
    )


@router.put("/settings/smtp", response_model=SmtpSettingsRead)
async def update_smtp_settings(
    body: SmtpSettingsWrite,
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> SmtpSettingsRead:
    row = await _get_smtp_row(db)
    existing = row.value if row else {}

    new_value: dict = {
        "host":      body.host,
        "port":      body.port,
        "user":      body.user,
        "from_addr": body.from_addr,
        "ssl":       body.ssl,
    }

    if body.password is None:
        # Keep whatever is stored
        new_value["password"] = existing.get("password", "")
    elif body.password == "":
        new_value["password"] = ""
    else:
        if not crypto.is_configured():
            raise HTTPException(status_code=400,
                                detail="ANTHRIMON_ENCRYPTION_KEY is not set — cannot encrypt password")
        new_value["password"] = crypto.encrypt(body.password)

    if row is None:
        db.add(SystemSetting(key=_SMTP_KEY, value=new_value))
    else:
        row.value = new_value
        from sqlalchemy import func
        row.updated_at = func.now()

    await db.commit()
    logger.info("smtp_settings_updated", host=body.host, port=body.port)

    return SmtpSettingsRead(
        host=new_value["host"],
        port=new_value["port"],
        user=new_value["user"],
        from_addr=new_value["from_addr"],
        ssl=new_value["ssl"],
        password_set=bool(new_value.get("password")),
    )


@router.post("/settings/smtp/test", status_code=204, response_model=None,
             summary="Send a test email using the current SMTP settings")
async def test_smtp_settings(
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    row = await _get_smtp_row(db)
    if row is None or not row.value.get("host"):
        raise HTTPException(status_code=400, detail="SMTP is not configured")

    smtp_cfg = await _smtp_config_from_row(row)
    recipient = smtp_cfg.get("from_addr") or smtp_cfg.get("user")
    if not recipient:
        raise HTTPException(status_code=400, detail="Set a From address before sending a test")
    subject, body_text = _build_test_email()
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, _send_smtp, smtp_cfg, [recipient], subject, body_text, "")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"SMTP error: {exc}") from exc


async def _smtp_config_from_row(row: SystemSetting) -> dict:
    """Resolve the stored SMTP config, decrypting the password if needed."""
    v = dict(row.value)
    if v.get("password") and crypto.is_configured():
        try:
            v["password"] = crypto.decrypt(v["password"])
        except Exception:
            v["password"] = ""
    return v


@router.get("/settings/email-template", response_model=EmailTemplateRead,
            summary="Get the HTML email alert template")
async def get_email_template(
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> EmailTemplateRead:
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _TEMPLATE_KEY)
    )).scalar_one_or_none()
    if row:
        return EmailTemplateRead(subject=row.value.get("subject", DEFAULT_SUBJECT),
                                 html=row.value.get("html", DEFAULT_HTML))
    return EmailTemplateRead(subject=DEFAULT_SUBJECT, html=DEFAULT_HTML)


@router.put("/settings/email-template", response_model=EmailTemplateRead,
            summary="Save the HTML email alert template")
async def save_email_template(
    body: EmailTemplateWrite,
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> EmailTemplateRead:
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _TEMPLATE_KEY)
    )).scalar_one_or_none()
    value = {"subject": body.subject, "html": body.html}
    if row:
        row.value = value
    else:
        db.add(SystemSetting(key=_TEMPLATE_KEY, value=value))
    await db.commit()
    return EmailTemplateRead(**value)


@router.delete("/settings/email-template", status_code=204, response_model=None,
               summary="Reset the HTML email template to default")
async def reset_email_template(
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _TEMPLATE_KEY)
    )).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()


# ── Platform settings ──────────────────────────────────────────────────────────

async def load_platform_settings(db: AsyncSession) -> dict:
    """Return merged platform settings (stored overrides + defaults)."""
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _PLATFORM_KEY)
    )).scalar_one_or_none()
    stored = row.value if row else {}
    return {**PLATFORM_DEFAULTS, **stored}


@router.get("/settings/platform", response_model=PlatformSettingsRead,
            summary="Get platform-wide configuration")
async def get_platform_settings(
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> PlatformSettingsRead:
    cfg = await load_platform_settings(db)
    return PlatformSettingsRead(**cfg)


@router.put("/settings/platform", response_model=PlatformSettingsRead,
            summary="Save platform-wide configuration")
async def save_platform_settings(
    body: PlatformSettingsWrite,
    _: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> PlatformSettingsRead:
    value = body.model_dump()
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == _PLATFORM_KEY)
    )).scalar_one_or_none()
    if row:
        row.value = value
    else:
        db.add(SystemSetting(key=_PLATFORM_KEY, value=value))
    await db.commit()
    logger.info("platform_settings_updated")
    return PlatformSettingsRead(**value)
