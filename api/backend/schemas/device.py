from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, IPvAnyAddress


class DeviceCreate(BaseModel):
    hostname: str
    mgmt_ip: IPvAnyAddress
    vendor: str = "unknown"
    device_type: str = "unknown"
    platform: Optional[str] = None
    os_version: Optional[str] = None
    serial_number: Optional[str] = None
    collection_method: str = "snmp"
    snmp_version: str = "v2c"
    snmp_port: int = 161
    gnmi_port: int = 57400
    gnmi_tls: bool = True
    polling_interval_s: int = Field(default=300, ge=10, le=86400)
    site_id: Optional[uuid.UUID] = None
    collector_id: Optional[uuid.UUID] = None
    tags: list[str] = []
    notes: Optional[str] = None


class DeviceUpdate(BaseModel):
    """All fields optional — PATCH semantics."""
    hostname: Optional[str] = None
    mgmt_ip: Optional[IPvAnyAddress] = None
    vendor: Optional[str] = None
    device_type: Optional[str] = None
    platform: Optional[str] = None
    os_version: Optional[str] = None
    serial_number: Optional[str] = None
    collection_method: Optional[str] = None
    snmp_version: Optional[str] = None
    snmp_port: Optional[int] = None
    gnmi_port: Optional[int] = None
    gnmi_tls: Optional[bool] = None
    polling_interval_s: Optional[int] = None
    site_id: Optional[uuid.UUID] = None
    collector_id: Optional[uuid.UUID] = None
    tags: Optional[list[str]] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None


class SiteEmbedded(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    location: Optional[str] = None


class HealthEmbedded(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    collected_at: datetime
    cpu_util_pct: Optional[float] = None
    mem_used_bytes: Optional[int] = None
    mem_total_bytes: Optional[int] = None
    temperatures: list[Any] = []
    uptime_seconds: Optional[int] = None


class DeviceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID
    hostname: str
    fqdn: Optional[str] = None
    mgmt_ip: str
    vendor: str
    device_type: str
    platform: Optional[str] = None
    os_version: Optional[str] = None
    serial_number: Optional[str] = None
    sys_description: Optional[str] = None
    collection_method: str
    snmp_version: str
    snmp_port: int
    gnmi_port: int
    gnmi_tls: bool
    polling_interval_s: int
    status: str
    last_seen: Optional[datetime] = None
    last_polled: Optional[datetime] = None
    is_active: bool
    tags: list[Any] = []
    notes: Optional[str] = None
    site_id: Optional[uuid.UUID] = None
    collector_id: Optional[uuid.UUID] = None
    created_at: datetime
    updated_at: datetime

    # Optionally included when ?include=health
    health: Optional[HealthEmbedded] = None
    site: Optional[SiteEmbedded] = None


class DeviceListRead(BaseModel):
    """Lighter response for list views — no embedded objects."""
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    hostname: str
    mgmt_ip: str
    vendor: str
    device_type: str
    platform: Optional[str] = None
    status: str
    last_seen: Optional[datetime] = None
    site_id: Optional[uuid.UUID] = None
    tags: list[Any] = []
    is_active: bool
