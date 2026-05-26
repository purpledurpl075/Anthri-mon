from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, Float, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base


class MetricBaseline(Base):
    """Per-device, per-metric learned baseline statistics.

    Rows are upserted by the background baseline computation task (hourly).
    The alert evaluators read these to suppress noise or detect anomalies.

    Two flavours of row exist side-by-side in this table:

    1. **Time-of-week numeric baselines** (bucket_type='hour_of_week', bucket_index=0-167)
       Mean/stddev for a specific hour-of-week bucket — used for utilisation,
       CPU, memory, traffic etc. where a Tuesday-2pm baseline differs from a
       Sunday-2am one.

    2. **Rolling-window state baselines** (bucket_type='rolling', bucket_index=0)
       normal_up_pct, mean/stddev/p5/p95 over the whole window_days window —
       used for interface_down (suppress ports that are always down), error
       rates, and other metrics where time-of-day doesn't matter.
    """

    __tablename__ = "metric_baselines"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("devices.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # For per-interface metrics (interface_down, util, errors, dom).
    # NULL for device-level metrics (cpu, mem, syslog_rate) or label-keyed ones.
    interface_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("interfaces.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    # For non-interface-FK metrics (BGP peer IP, etc.).
    label: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # e.g. 'interface_down', 'interface_util_pct', 'cpu_util_pct',
    #      'mem_util_pct', 'interface_errors', 'dom_rx_power',
    #      'bgp_prefix_count', 'syslog_rate'
    metric_type: Mapped[str] = mapped_column(Text, nullable=False)

    # 'hour_of_week' or 'rolling'
    bucket_type: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="hour_of_week"
    )
    # For hour_of_week: 0–167 (day*24 + hour, UTC).  For rolling: always 0.
    bucket_index: Mapped[int] = mapped_column(Integer, nullable=False)

    # Rolling window length used when bucket_type='rolling'.
    window_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default="14")

    # ── Numeric stats ──────────────────────────────────────────────────────
    mean: Mapped[float] = mapped_column(Float, nullable=False, server_default="0")
    stddev: Mapped[float] = mapped_column(Float, nullable=False, server_default="0")
    p5: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    p95: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    # ── Boolean / state metrics ────────────────────────────────────────────
    # Fraction of samples (0.0–1.0) where the port/metric was in the "up"
    # or "normal" state.  NULL for purely numeric metrics.
    normal_up_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # ── Manual overrides ───────────────────────────────────────────────────
    force_alert: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    force_suppress: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )

    computed_at: Mapped[Optional[datetime]] = mapped_column(nullable=True)
