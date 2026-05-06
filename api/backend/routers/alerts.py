from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_db, require_role
from ..models.alert import Alert, AlertRule
from ..models.tenant import User
from ..schemas.alert import AlertRead, AlertRuleCreate, AlertRuleRead, AlertRuleUpdate
from ..schemas.common import PaginatedResponse

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["alerts"])


# ── Alerts ─────────────────────────────────────────────────────────────────────

@router.get("/alerts", response_model=PaginatedResponse[AlertRead], summary="List alerts")
async def list_alerts(
    alert_status: Optional[str] = Query(default=None, alias="status"),
    severity: Optional[str] = Query(default=None),
    device_id: Optional[uuid.UUID] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[AlertRead]:
    q = select(Alert).where(Alert.tenant_id == current_user.tenant_id)

    if alert_status:
        q = q.where(Alert.status == alert_status)
    if severity:
        q = q.where(Alert.severity == severity)
    if device_id:
        q = q.where(Alert.device_id == device_id)

    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.order_by(Alert.triggered_at.desc()).limit(limit).offset(offset))).scalars().all()

    return PaginatedResponse(
        total=total, limit=limit, offset=offset,
        items=[AlertRead.model_validate(a) for a in items],
    )


@router.get("/alerts/{alert_id}", response_model=AlertRead, summary="Get a single alert")
async def get_alert(
    alert_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AlertRead:
    alert = await _get_alert(alert_id, current_user.tenant_id, db)
    return AlertRead.model_validate(alert)


@router.post("/alerts/{alert_id}/acknowledge", response_model=AlertRead, summary="Acknowledge an open alert")
async def acknowledge_alert(
    alert_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> AlertRead:
    alert = await _get_alert(alert_id, current_user.tenant_id, db)

    if alert.status != "open":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Alert is already '{alert.status}'")

    now = datetime.now(timezone.utc)
    alert.status = "acknowledged"
    alert.acknowledged_at = now
    alert.acknowledged_by = current_user.id

    await db.commit()
    await db.refresh(alert)
    logger.info("alert_acknowledged", alert_id=str(alert_id), by=str(current_user.id))
    return AlertRead.model_validate(alert)


@router.post("/alerts/{alert_id}/resolve", response_model=AlertRead, summary="Manually resolve an alert")
async def resolve_alert(
    alert_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> AlertRead:
    alert = await _get_alert(alert_id, current_user.tenant_id, db)

    if alert.status == "resolved":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Alert is already resolved")

    now = datetime.now(timezone.utc)
    alert.status = "resolved"
    alert.resolved_at = now
    alert.resolved_by = current_user.id

    await db.commit()
    await db.refresh(alert)
    logger.info("alert_resolved", alert_id=str(alert_id), by=str(current_user.id))
    return AlertRead.model_validate(alert)


# ── Alert Rules ────────────────────────────────────────────────────────────────

@router.get("/alert-rules", response_model=PaginatedResponse[AlertRuleRead], summary="List alert rules")
async def list_alert_rules(
    is_enabled: Optional[bool] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[AlertRuleRead]:
    q = select(AlertRule).where(AlertRule.tenant_id == current_user.tenant_id)
    if is_enabled is not None:
        q = q.where(AlertRule.is_enabled == is_enabled)

    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    items = (await db.execute(q.order_by(AlertRule.name).limit(limit).offset(offset))).scalars().all()

    return PaginatedResponse(
        total=total, limit=limit, offset=offset,
        items=[AlertRuleRead.model_validate(r) for r in items],
    )


@router.post("/alert-rules", response_model=AlertRuleRead, status_code=status.HTTP_201_CREATED, summary="Create an alert rule")
async def create_alert_rule(
    body: AlertRuleCreate,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> AlertRuleRead:
    rule = AlertRule(
        tenant_id=current_user.tenant_id,
        **body.model_dump(mode='json', exclude_none=True),
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    logger.info("alert_rule_created", rule_id=str(rule.id), name=rule.name)
    return AlertRuleRead.model_validate(rule)


@router.get("/alert-rules/{rule_id}", response_model=AlertRuleRead, summary="Get an alert rule")
async def get_alert_rule(
    rule_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AlertRuleRead:
    rule = await _get_rule(rule_id, current_user.tenant_id, db)
    return AlertRuleRead.model_validate(rule)


@router.patch("/alert-rules/{rule_id}", response_model=AlertRuleRead, summary="Update an alert rule")
async def update_alert_rule(
    rule_id: uuid.UUID,
    body: AlertRuleUpdate,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> AlertRuleRead:
    rule = await _get_rule(rule_id, current_user.tenant_id, db)

    for field, value in body.model_dump(mode='json', exclude_none=True).items():
        setattr(rule, field, value)

    await db.commit()
    await db.refresh(rule)
    return AlertRuleRead.model_validate(rule)


@router.delete("/alert-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, summary="Delete an alert rule")
async def delete_alert_rule(
    rule_id: uuid.UUID,
    current_user: User = Depends(require_role("admin", "superadmin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    rule = await _get_rule(rule_id, current_user.tenant_id, db)
    await db.delete(rule)
    await db.commit()
    logger.info("alert_rule_deleted", rule_id=str(rule_id))


# ── Internal helpers ───────────────────────────────────────────────────────────

async def _get_alert(alert_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> Alert:
    result = await db.execute(
        select(Alert).where(Alert.id == alert_id, Alert.tenant_id == tenant_id)
    )
    alert = result.scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alert not found")
    return alert


async def _get_rule(rule_id: uuid.UUID, tenant_id: uuid.UUID, db: AsyncSession) -> AlertRule:
    result = await db.execute(
        select(AlertRule).where(AlertRule.id == rule_id, AlertRule.tenant_id == tenant_id)
    )
    rule = result.scalar_one_or_none()
    if rule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alert rule not found")
    return rule
