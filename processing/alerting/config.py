from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import yaml


@dataclass
class SmtpConfig:
    enabled: bool = False
    host: str = "localhost"
    port: int = 25
    from_addr: str = "anthrimon@localhost"
    to_addr: str = ""
    username: str = ""
    password: str = ""


@dataclass
class SlackConfig:
    enabled: bool = False
    webhook_url: str = ""


@dataclass
class NotificationsConfig:
    smtp: SmtpConfig = field(default_factory=SmtpConfig)
    slack: SlackConfig = field(default_factory=SlackConfig)


@dataclass
class PollingConfig:
    interval_seconds: int = 15


@dataclass
class Settings:
    dsn: str = "postgres://postgres@/anthrimon?host=/var/run/postgresql&sslmode=disable"
    log_level: str = "info"
    polling: PollingConfig = field(default_factory=PollingConfig)
    notifications: NotificationsConfig = field(default_factory=NotificationsConfig)


def load(path: str) -> Settings:
    with open(path) as f:
        raw = yaml.safe_load(f) or {}

    s = Settings()
    s.log_level = raw.get("log", {}).get("level", "info")
    s.dsn = raw.get("database", {}).get("dsn", s.dsn)

    p = raw.get("polling", {})
    s.polling.interval_seconds = int(p.get("interval_seconds", 15))

    n = raw.get("notifications", {})
    smtp = n.get("smtp", {})
    s.notifications.smtp = SmtpConfig(
        enabled=smtp.get("enabled", False),
        host=smtp.get("host", "localhost"),
        port=int(smtp.get("port", 25)),
        from_addr=smtp.get("from_addr", "anthrimon@localhost"),
        to_addr=smtp.get("to_addr", ""),
        username=smtp.get("username", ""),
        password=smtp.get("password", ""),
    )
    slack = n.get("slack", {})
    s.notifications.slack = SlackConfig(
        enabled=slack.get("enabled", False),
        webhook_url=slack.get("webhook_url", ""),
    )
    return s
