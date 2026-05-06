from .admin import router as admin_router
from .auth import router as auth_router
from .maintenance import router as maintenance_router
from .channels import router as channels_router
from .credentials import router as credentials_router
from .devices import router as devices_router
from .discovery import router as discovery_router
from .interfaces import router as interfaces_router
from .alerts import router as alerts_router
from .overview import router as overview_router
from .policies import router as policies_router

__all__ = ["admin_router", "auth_router", "channels_router", "credentials_router", "maintenance_router",
           "devices_router", "discovery_router", "interfaces_router", "alerts_router",
           "overview_router", "policies_router"]
