from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    from .site import Site
    from .interface import Interface
    from .health import DeviceHealthLatest
    from .alert import Alert
    from .tenant import Tenant


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    site_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("sites.id"))
    collector_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("remote_collectors.id"))

    hostname: Mapped[str] = mapped_column(Text, nullable=False)
    fqdn: Mapped[Optional[str]] = mapped_column(Text)
    mgmt_ip: Mapped[str] = mapped_column(INET, nullable=False)

    # Maps to PostgreSQL vendor_type enum
    vendor: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    # Maps to PostgreSQL device_type enum
    device_type: Mapped[str] = mapped_column(String(30), nullable=False, default="unknown")

    platform: Mapped[Optional[str]] = mapped_column(Text)
    os_version: Mapped[Optional[str]] = mapped_column(Text)
    serial_number: Mapped[Optional[str]] = mapped_column(Text)
    sys_description: Mapped[Optional[str]] = mapped_column(Text)
    sys_object_id: Mapped[Optional[str]] = mapped_column(Text)

    # Maps to PostgreSQL collection_method enum
    collection_method: Mapped[str] = mapped_column(String(10), nullable=False, default="snmp")
    # Maps to PostgreSQL snmp_version enum
    snmp_version: Mapped[str] = mapped_column(String(5), nullable=False, default="v2c")
    snmp_port: Mapped[int] = mapped_column(Integer, nullable=False, default=161)
    gnmi_port: Mapped[int] = mapped_column(Integer, nullable=False, default=57400)
    gnmi_tls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    polling_interval_s: Mapped[int] = mapped_column(Integer, nullable=False, default=300)

    # Maps to PostgreSQL device_status enum
    status: Mapped[str] = mapped_column(String(15), nullable=False, default="unknown")
    last_seen: Mapped[Optional[datetime]] = mapped_column()
    last_polled: Mapped[Optional[datetime]] = mapped_column()
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    notes: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    # Relationships
    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="devices", lazy="noload")
    site: Mapped[Optional["Site"]] = relationship("Site", back_populates="devices", lazy="noload")
    interfaces: Mapped[list["Interface"]] = relationship("Interface", back_populates="device", lazy="noload")
    health: Mapped[Optional["DeviceHealthLatest"]] = relationship("DeviceHealthLatest", back_populates="device", uselist=False, lazy="noload")
    alerts: Mapped[list["Alert"]] = relationship("Alert", back_populates="device", lazy="noload")
