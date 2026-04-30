from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class AlertRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    rule_id: Optional[uuid.UUID] = None
    device_id: Optional[uuid.UUID] = None
    interface_id: Optional[uuid.UUID] = None
    severity: str
    status: str
    title: str
    message: Optional[str] = None
    context: dict = {}
    triggered_at: datetime
    acknowledged_at: Optional[datetime] = None
    acknowledged_by: Optional[uuid.UUID] = None
    resolved_at: Optional[datetime] = None
    resolved_by: Optional[uuid.UUID] = None
    created_at: datetime
    updated_at: datetime


class AlertRuleCreate(BaseModel):
    name: str
    description: Optional[str] = None
    is_enabled: bool = True
    device_selector: Optional[dict] = None
    metric: str
    condition: str
    threshold: Optional[float] = None
    duration_seconds: int = Field(default=0, ge=0)
    renotify_seconds: int = Field(default=3600, ge=0)
    severity: str = "warning"
    channel_ids: list[uuid.UUID] = []
    maintenance_window_ids: list[uuid.UUID] = []


class AlertRuleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_enabled: Optional[bool] = None
    device_selector: Optional[dict] = None
    metric: Optional[str] = None
    condition: Optional[str] = None
    threshold: Optional[float] = None
    duration_seconds: Optional[int] = None
    renotify_seconds: Optional[int] = None
    severity: Optional[str] = None
    channel_ids: Optional[list[uuid.UUID]] = None
    maintenance_window_ids: Optional[list[uuid.UUID]] = None


class AlertRuleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    name: str
    description: Optional[str] = None
    is_enabled: bool
    device_selector: Optional[dict] = None
    metric: str
    condition: str
    threshold: Optional[float] = None
    duration_seconds: int
    renotify_seconds: int
    severity: str
    channel_ids: list[Any] = []
    maintenance_window_ids: list[Any] = []
    created_at: datetime
    updated_at: datetime
