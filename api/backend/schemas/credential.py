from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict

# ── Data shapes per credential type (stored as JSONB) ─────────────────────────
# snmp_v2c  : {community}
# snmp_v3   : {username, auth_protocol, auth_key, priv_protocol, priv_key}
# ssh       : {username, password?, private_key?, passphrase?}
# gnmi_tls  : {skip_verify, ca_cert?, client_cert?, client_key?}
# api_token : {token, base_url?}
# netconf   : {username, password, port}
# telnet    : {username, password, enable_password?}  — requires DB enum extension


class CredentialCreate(BaseModel):
    name: str
    type: str
    data: dict[str, Any] = {}


class CredentialUpdate(BaseModel):
    name: Optional[str] = None
    data: Optional[dict[str, Any]] = None


class CredentialRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    type: str
    data: dict[str, Any]
    created_at: datetime
    updated_at: datetime
