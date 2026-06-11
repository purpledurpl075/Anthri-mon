"""WebSocket-driven ping/traceroute/mtr probes.

Single endpoint at /probes/ws.  JWT goes in the `token` query-param because
browser WebSocket APIs can't set arbitrary headers.

Wire protocol:

  → client:   {"type": "ping|traceroute|mtr", "target": "10.0.0.1",
               "source": "hub" | "<collector_uuid>",
               "count": 5, "timeout_s": 3, "max_hops": 24}
  ← server:   {"event": "start",     "command": "...", "source": "..."}
              {"event": "line",      "data":    "..."}
              ...
              {"event": "complete",  "exit_code": 0}
              {"event": "error",     "detail":  "..."}   (terminates the stream)

The client may also send {"cancel": true} at any time to abort the running
probe.  Closing the WebSocket has the same effect.
"""
from __future__ import annotations

import asyncio
import json
import uuid

import structlog
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..dependencies import _principal_from_jwt
from ..models.site import RemoteCollector
from ..models.tenant import User
from ..probes import ProbeRequest, run_local, run_remote
from .devices import _collector_token

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["probes"])


async def _resolve_user(token: str, db: AsyncSession) -> User | None:
    """Decode the JWT and return the User row, or None if invalid."""
    principal = await _principal_from_jwt(token, db)
    return principal.user if principal else None


async def _send_event(ws: WebSocket, event: dict) -> bool:
    """Send one event; return False if the socket has closed under us."""
    try:
        await ws.send_text(json.dumps(event))
        return True
    except Exception:
        return False


@router.websocket("/probes/ws")
async def probe_ws(ws: WebSocket, token: str = Query(...)):
    """One probe per connection; close to cancel."""
    await ws.accept()

    async with AsyncSessionLocal() as db:
        user = await _resolve_user(token, db)
        if user is None or user.role not in ("admin", "superadmin", "operator"):
            await _send_event(ws, {"event": "error", "detail": "Unauthorized"})
            await ws.close(code=1008)
            return

        # Wait for the probe request
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=30.0)
        except (asyncio.TimeoutError, WebSocketDisconnect):
            await ws.close()
            return

        try:
            body = json.loads(raw)
            req = ProbeRequest(
                target    = body.get("target", ""),
                type      = body.get("type", ""),
                source    = body.get("source", "hub"),
                count     = int(body.get("count",     5)),
                timeout_s = int(body.get("timeout_s", 3)),
                max_hops  = int(body.get("max_hops",  24)),
            )
            req.sanitize()
        except Exception as exc:
            await _send_event(ws, {"event": "error", "detail": f"bad request: {exc}"})
            await ws.close(code=1003)
            return

        # Resolve source
        if req.source in ("hub", "local", ""):
            stream = run_local(req)
        else:
            try:
                col_uuid = uuid.UUID(req.source)
            except ValueError:
                await _send_event(ws, {"event": "error", "detail": "source must be 'hub' or a collector UUID"})
                await ws.close(code=1003)
                return
            col = (await db.execute(
                select(RemoteCollector).where(
                    RemoteCollector.id == col_uuid,
                    RemoteCollector.tenant_id == user.tenant_id,
                )
            )).scalar_one_or_none()
            if col is None or not col.wg_ip or not col.api_key_hash:
                await _send_event(ws, {"event": "error", "detail": "collector not found or not ready"})
                await ws.close(code=1008)
                return
            stream = run_remote(req, str(col.wg_ip), col.api_key_hash, _collector_token)

        # Consume the stream and forward events to the WebSocket.  If the client
        # disconnects, cancel the generator so the subprocess is reaped.
        try:
            agen = stream.__aiter__()
            while True:
                next_task   = asyncio.create_task(agen.__anext__())
                cancel_task = asyncio.create_task(ws.receive_text())
                done, pending = await asyncio.wait(
                    {next_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED,
                )
                if cancel_task in done:
                    try:
                        msg = cancel_task.result()
                        try:
                            parsed = json.loads(msg)
                            if isinstance(parsed, dict) and parsed.get("cancel"):
                                next_task.cancel()
                                break
                        except json.JSONDecodeError:
                            pass
                    except WebSocketDisconnect:
                        next_task.cancel()
                        return
                if next_task in done:
                    cancel_task.cancel()
                    try:
                        event = next_task.result()
                    except StopAsyncIteration:
                        break
                    if not await _send_event(ws, event):
                        return
                    if event.get("event") in ("complete", "error"):
                        break
        except WebSocketDisconnect:
            return
        except Exception as exc:
            logger.error("probe_ws_error", error=str(exc), exc_info=True)
            await _send_event(ws, {"event": "error", "detail": str(exc)})
        finally:
            try:
                await ws.close()
            except Exception:
                pass
