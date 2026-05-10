#!/usr/bin/env python3
"""
Anthrimon alerting engine.

Usage:
    python3 -m main [--config alerting.yaml]
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

import asyncpg
import structlog

from .config import load as load_config
from .engine import AlertEngine


def _configure_logging(level: str) -> None:
    structlog.configure(
        processors=[
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(),
    )


async def _run(config_path: str) -> None:
    cfg = load_config(config_path)
    _configure_logging(cfg.log_level)

    log = structlog.get_logger("anthrimon.alerting")
    log.info("starting", config=config_path, interval_s=cfg.polling.interval_seconds)

    pool = await asyncpg.create_pool(cfg.dsn, min_size=1, max_size=3)
    engine = AlertEngine(pool, cfg)

    log.info("connected_to_db")

    try:
        while True:
            await engine.run_once()
            await asyncio.sleep(cfg.polling.interval_seconds)
    except asyncio.CancelledError:
        pass
    finally:
        await pool.close()
        log.info("stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="Anthrimon alerting engine")
    parser.add_argument("--config", default="alerting.yaml", help="Path to config file")
    args = parser.parse_args()

    try:
        asyncio.run(_run(args.config))
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
