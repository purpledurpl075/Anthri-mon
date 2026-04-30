from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, MACADDR, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    from .device import Device


class Interface(Base):
    __tablename__ = "interfaces"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    if_index: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    if_type: Mapped[Optional[str]] = mapped_column(Text)
    speed_bps: Mapped[Optional[int]] = mapped_column(BigInteger)
    mtu: Mapped[Optional[int]] = mapped_column(Integer)
    mac_address: Mapped[Optional[str]] = mapped_column(MACADDR)

    # Maps to PostgreSQL if_status enum
    admin_status: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    oper_status: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")

    last_change: Mapped[Optional[datetime]] = mapped_column()
    ip_addresses: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    vrf: Mapped[Optional[str]] = mapped_column(Text)
    is_uplink: Mapped[Optional[bool]] = mapped_column(Boolean)

    created_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    device: Mapped["Device"] = relationship("Device", back_populates="interfaces", lazy="noload")


class InterfaceStatusLog(Base):
    """Append-only log of interface up/down transitions; drives flap detection."""
    __tablename__ = "interface_status_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    interface_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("interfaces.id", ondelete="CASCADE"), nullable=False)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    prev_status: Mapped[Optional[str]] = mapped_column(String(20))
    new_status: Mapped[str] = mapped_column(String(20), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
