from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Boolean, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import ENUM as PgEnum, INET, JSONB, UUID
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

    vendor: Mapped[str] = mapped_column(
        PgEnum("cisco_ios", "cisco_iosxe", "cisco_iosxr", "cisco_nxos",
               "juniper", "arista", "aruba_cx", "fortios", "procurve", "unknown",
               name="vendor_type", create_type=False),
        nullable=False, default="unknown",
    )
    device_type: Mapped[str] = mapped_column(
        PgEnum("router", "switch", "firewall", "load_balancer",
               "wireless_controller", "unknown",
               name="device_type", create_type=False),
        nullable=False, default="unknown",
    )

    platform: Mapped[Optional[str]] = mapped_column(Text)
    os_version: Mapped[Optional[str]] = mapped_column(Text)
    serial_number: Mapped[Optional[str]] = mapped_column(Text)
    sys_description: Mapped[Optional[str]] = mapped_column(Text)
    sys_object_id: Mapped[Optional[str]] = mapped_column(Text)

    collection_method: Mapped[str] = mapped_column(
        PgEnum("snmp", "gnmi", "netconf", "api", "syslog",
               name="collection_method", create_type=False),
        nullable=False, default="snmp",
    )
    snmp_version: Mapped[str] = mapped_column(
        PgEnum("v1", "v2c", "v3", name="snmp_version", create_type=False),
        nullable=False, default="v2c",
    )
    snmp_port: Mapped[int] = mapped_column(Integer, nullable=False, default=161)
    gnmi_port: Mapped[int] = mapped_column(Integer, nullable=False, default=57400)
    gnmi_tls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    polling_interval_s: Mapped[int] = mapped_column(Integer, nullable=False, default=300)

    status: Mapped[str] = mapped_column(
        PgEnum("up", "down", "degraded", "unreachable", "maintenance", "unknown",
               name="device_status", create_type=False),
        nullable=False, default="unknown",
    )
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
