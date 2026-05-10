from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, model_validator


class MaintenanceWindowCreate(BaseModel):
    name: str
    description: Optional[str] = None
    device_selector: Optional[dict] = None  # None = all devices in tenant
    starts_at: datetime
    ends_at: datetime
    is_recurring: bool = False
    recurrence_cron: Optional[str] = None

    @model_validator(mode="after")
    def check_times(self) -> "MaintenanceWindowCreate":
        if self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        if self.is_recurring and not self.recurrence_cron:
            raise ValueError("recurrence_cron is required when is_recurring is true")
        return self


class MaintenanceWindowUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    device_selector: Optional[dict] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    is_recurring: Optional[bool] = None
    recurrence_cron: Optional[str] = None


class MaintenanceWindowRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    name: str
    description: Optional[str] = None
    device_selector: Optional[dict] = None
    starts_at: datetime
    ends_at: datetime
    is_recurring: bool
    recurrence_cron: Optional[str] = None
    created_by: Optional[uuid.UUID] = None
    created_at: datetime
    updated_at: datetime
    is_active: bool = False  # populated by the API, not stored
