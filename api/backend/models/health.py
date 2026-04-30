from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import BigInteger, ForeignKey, Numeric, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base

if TYPE_CHECKING:
    from .device import Device


class DeviceHealthLatest(Base):
    """Single upserted row per device with the most recent health poll.
    Historical time-series lives in VictoriaMetrics; this row serves
    dashboard health cards without querying VM."""
    __tablename__ = "device_health_latest"

    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True)
    collected_at: Mapped[datetime] = mapped_column(nullable=False)
    cpu_util_pct: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    mem_used_bytes: Mapped[Optional[int]] = mapped_column(BigInteger)
    mem_total_bytes: Mapped[Optional[int]] = mapped_column(BigInteger)
    # [{"sensor": "Inlet", "celsius": 28.5}, ...]
    temperatures: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    uptime_seconds: Mapped[Optional[int]] = mapped_column(BigInteger)
    updated_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())

    device: Mapped["Device"] = relationship("Device", back_populates="health", lazy="noload")
