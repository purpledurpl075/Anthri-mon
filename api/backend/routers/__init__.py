from .auth import router as auth_router
from .devices import router as devices_router
from .interfaces import router as interfaces_router
from .alerts import router as alerts_router

__all__ = ["auth_router", "devices_router", "interfaces_router", "alerts_router"]
