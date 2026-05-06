from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class SmtpSettingsRead(BaseModel):
    host: str = ""
    port: int = 587
    user: str = ""
    from_addr: str = ""
    ssl: bool = False
    password_set: bool = False  # never return the actual password


class SmtpSettingsWrite(BaseModel):
    host: str = ""
    port: int = Field(default=587, ge=1, le=65535)
    user: str = ""
    password: Optional[str] = None  # None = keep existing; "" = clear it
    from_addr: str = ""
    ssl: bool = False
