from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


class InterfaceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    device_id: uuid.UUID
    if_index: int
    name: str
    description: Optional[str] = None
    if_type: Optional[str] = None
    speed_bps: Optional[int] = None
    mtu: Optional[int] = None
    mac_address: Optional[str] = None
    admin_status: str
    oper_status: str
    last_change: Optional[datetime] = None
    ip_addresses: list[Any] = []
    vrf: Optional[str] = None
    is_uplink: Optional[bool] = None
    updated_at: datetime


class InterfaceUpdate(BaseModel):
    """Only operator-editable fields are exposed here.
    Everything else is written by the collector."""
    description: Optional[str] = None
    is_uplink: Optional[bool] = None
