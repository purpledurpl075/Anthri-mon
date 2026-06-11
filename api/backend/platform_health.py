"""Lightweight in-process metrics registry for Anthrimon's self-observability.

Three primitive types — Counter, Gauge, Histogram — with no Prometheus client
dependency.  Everything is thread/async safe and cheap (atomic ops on dicts).

Usage:
    from .platform_health import registry, observe_latency
    registry.counter("anthrimon_api_requests_total", {"method": "GET"}).inc()
    with observe_latency("alert_engine_cycle_duration_seconds"):
        ...do work...

Exposed by:
  - GET /api/v1/platform/health  (JSON snapshot for the in-app dashboard)
  - GET /api/v1/platform/metrics (Prometheus text format, for external scrape)
"""
from __future__ import annotations

import os
import time
from collections import deque
from contextlib import contextmanager
from threading import Lock
from typing import Optional

PROCESS_START = time.monotonic()
PROCESS_START_WALL = time.time()


def _label_key(labels: dict[str, str]) -> tuple:
    """Stable tuple key for a label dict — sorted to make ordering irrelevant."""
    return tuple(sorted(labels.items()))


class Counter:
    """Monotonic-increasing counter, partitioned by label set."""
    __slots__ = ("name", "help", "_values", "_lock")

    def __init__(self, name: str, help_text: str = "") -> None:
        self.name = name
        self.help = help_text
        self._values: dict[tuple, float] = {}
        self._lock = Lock()

    def inc(self, amount: float = 1.0, **labels: str) -> None:
        key = _label_key(labels)
        with self._lock:
            self._values[key] = self._values.get(key, 0.0) + amount

    def get(self, **labels: str) -> float:
        return self._values.get(_label_key(labels), 0.0)

    def total(self) -> float:
        return sum(self._values.values())

    def snapshot(self) -> dict[tuple, float]:
        with self._lock:
            return dict(self._values)


class Gauge:
    """Arbitrary point-in-time value (can go up or down)."""
    __slots__ = ("name", "help", "_values", "_lock")

    def __init__(self, name: str, help_text: str = "") -> None:
        self.name = name
        self.help = help_text
        self._values: dict[tuple, float] = {}
        self._lock = Lock()

    def set(self, value: float, **labels: str) -> None:
        key = _label_key(labels)
        with self._lock:
            self._values[key] = float(value)

    def get(self, **labels: str) -> float:
        return self._values.get(_label_key(labels), 0.0)

    def snapshot(self) -> dict[tuple, float]:
        with self._lock:
            return dict(self._values)


class Histogram:
    """Latency-style histogram with a fixed rolling window of recent samples.

    Computes count + sum + p50 + p95 + p99 from the window on demand.  The
    window is fixed size to bound memory; tail of the window is dropped as
    new samples arrive."""
    __slots__ = ("name", "help", "_samples", "_count", "_sum", "_lock", "_max")

    def __init__(self, name: str, help_text: str = "", max_samples: int = 1024) -> None:
        self.name = name
        self.help = help_text
        self._samples: deque[float] = deque(maxlen=max_samples)
        self._count = 0
        self._sum = 0.0
        self._lock = Lock()
        self._max = max_samples

    def observe(self, value: float) -> None:
        with self._lock:
            self._samples.append(value)
            self._count += 1
            self._sum += value

    def summary(self) -> dict:
        with self._lock:
            samples = sorted(self._samples)
            count = self._count
            total = self._sum
        if not samples:
            return {"count": count, "sum": total, "p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0}
        n = len(samples)
        def pct(p: float) -> float:
            idx = min(n - 1, max(0, int(round(n * p / 100)) - 1))
            return samples[idx]
        return {
            "count": count,
            "sum":   total,
            "p50":   pct(50),
            "p95":   pct(95),
            "p99":   pct(99),
            "max":   samples[-1],
        }


class Registry:
    """Single global registry of all metrics in the process."""
    def __init__(self) -> None:
        self._counters: dict[str, Counter] = {}
        self._gauges:   dict[str, Gauge] = {}
        self._histograms: dict[str, Histogram] = {}
        self._lock = Lock()

    def counter(self, name: str, help_text: str = "") -> Counter:
        with self._lock:
            if name not in self._counters:
                self._counters[name] = Counter(name, help_text)
            return self._counters[name]

    def gauge(self, name: str, help_text: str = "") -> Gauge:
        with self._lock:
            if name not in self._gauges:
                self._gauges[name] = Gauge(name, help_text)
            return self._gauges[name]

    def histogram(self, name: str, help_text: str = "", max_samples: int = 1024) -> Histogram:
        with self._lock:
            if name not in self._histograms:
                self._histograms[name] = Histogram(name, help_text, max_samples)
            return self._histograms[name]

    def snapshot(self) -> dict:
        """Full JSON-friendly snapshot for the dashboard."""
        return {
            "process": {
                "uptime_seconds":  time.monotonic() - PROCESS_START,
                "started_at_unix": PROCESS_START_WALL,
                "pid":             os.getpid(),
            },
            "counters": {
                name: [
                    {"labels": dict(k), "value": v}
                    for k, v in c.snapshot().items()
                ]
                for name, c in self._counters.items()
            },
            "gauges": {
                name: [
                    {"labels": dict(k), "value": v}
                    for k, v in g.snapshot().items()
                ]
                for name, g in self._gauges.items()
            },
            "histograms": {
                name: h.summary()
                for name, h in self._histograms.items()
            },
        }

    def prometheus_text(self) -> str:
        """Emit all metrics in Prometheus text exposition format."""
        out: list[str] = []
        def lbl(labels: tuple) -> str:
            if not labels:
                return ""
            return "{" + ",".join(f'{k}="{_esc(v)}"' for k, v in labels) + "}"

        for c in self._counters.values():
            if c.help:
                out.append(f"# HELP {c.name} {c.help}")
            out.append(f"# TYPE {c.name} counter")
            for k, v in c.snapshot().items():
                out.append(f"{c.name}{lbl(k)} {v}")
        for g in self._gauges.values():
            if g.help:
                out.append(f"# HELP {g.name} {g.help}")
            out.append(f"# TYPE {g.name} gauge")
            for k, v in g.snapshot().items():
                out.append(f"{g.name}{lbl(k)} {v}")
        for h in self._histograms.values():
            s = h.summary()
            if h.help:
                out.append(f"# HELP {h.name} {h.help}")
            out.append(f"# TYPE {h.name} summary")
            out.append(f"{h.name}{{quantile=\"0.5\"}} {s['p50']}")
            out.append(f"{h.name}{{quantile=\"0.95\"}} {s['p95']}")
            out.append(f"{h.name}{{quantile=\"0.99\"}} {s['p99']}")
            out.append(f"{h.name}_count {s['count']}")
            out.append(f"{h.name}_sum {s['sum']}")
        return "\n".join(out) + "\n"


def _esc(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


registry = Registry()


@contextmanager
def observe_latency(name: str, help_text: str = ""):
    """Context manager that records the elapsed wall time into a histogram."""
    h = registry.histogram(name, help_text)
    t0 = time.monotonic()
    try:
        yield
    finally:
        h.observe(time.monotonic() - t0)


# ── Convenience accessors for commonly-used metrics ─────────────────────────
def api_requests_total() -> Counter:
    return registry.counter("anthrimon_api_requests_total",
                            "Total HTTP requests handled by the API.")

def api_request_duration() -> Histogram:
    # 8k samples: a busy API at ~50 req/s holds ~2.5 min of recent quantiles;
    # at low traffic that stretches to many hours.
    return registry.histogram("anthrimon_api_request_duration_seconds",
                              "API request duration in seconds.",
                              max_samples=8192)

def alert_engine_cycle_duration() -> Histogram:
    # 1k samples × 15s default interval ≈ 4 hours of cycle-time history.
    return registry.histogram("anthrimon_alert_engine_cycle_duration_seconds",
                              "Time spent in one full alert engine evaluation cycle.",
                              max_samples=1024)

def alert_engine_alerts_fired() -> Counter:
    return registry.counter("anthrimon_alert_engine_alerts_fired_total",
                            "Alerts that transitioned to open in each cycle.")

def alert_engine_alerts_suppressed() -> Counter:
    return registry.counter("anthrimon_alert_engine_alerts_suppressed_total",
                            "Alerts that were created or transitioned to suppressed.")

def alert_engine_wake_events() -> Counter:
    return registry.counter("anthrimon_alert_engine_wake_events_total",
                            "Times the engine was woken early via request_immediate_pass().")

def notification_sent_total() -> Counter:
    return registry.counter("anthrimon_notification_sent_total",
                            "Notifications attempted, by channel type and status.")
