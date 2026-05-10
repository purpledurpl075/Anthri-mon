from __future__ import annotations

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings

_settings = get_settings()

# Build engine kwargs. When database_url_override contains a Unix socket path
# (host=...) we pass it through connect_args so asyncpg receives it correctly,
# because SQLAlchemy's URL parser strips query params before forwarding to asyncpg.
_connect_args: dict = {}
_db_url = _settings.database_url
if "host=/var/run" in _db_url:
    # Extract the socket directory from the URL and pass directly to asyncpg.
    import urllib.parse as _up
    _qs = _up.parse_qs(_up.urlparse(_db_url).query)
    _connect_args["host"] = _qs.get("host", ["/var/run/postgresql"])[0]
    _db_url = _db_url.split("?")[0]

engine = create_async_engine(
    _db_url,
    echo=False,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    connect_args=_connect_args,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    """Shared declarative base for all ORM models."""
    pass
