from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base


class DeviceApiMethod(Base):
    __tablename__ = "device_api_methods"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    reachable: Mapped[Optional[bool]] = mapped_column(Boolean)
    last_probe_at: Mapped[Optional[datetime]] = mapped_column()
    probe_error: Mapped[Optional[str]] = mapped_column(Text)
    configure_status: Mapped[Optional[str]] = mapped_column(Text)
    configure_output: Mapped[Optional[str]] = mapped_column(Text)
    configure_at: Mapped[Optional[datetime]] = mapped_column()
    updated_at: Mapped[datetime] = mapped_column(nullable=False)
