from .auth import router as auth_router
from .devices import router as devices_router
from .interfaces import router as interfaces_router
from .alerts import router as alerts_router
from .credentials import router as credentials_router
from .discovery import router as discovery_router

__all__ = ["auth_router", "devices_router", "interfaces_router", "alerts_router", "credentials_router", "discovery_router"]
