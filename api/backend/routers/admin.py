from __future__ import annotations

import asyncio

import structlog
from fastapi import APIRouter, Depends, HTTPException
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

_SMTP_KEY = "smtp"


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
        await loop.run_in_executor(None, _send_smtp, smtp_cfg, [recipient], subject, body_text)
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
