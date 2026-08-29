"""审计与 ID 生成。所有写入动作都必须经过这里留痕。"""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import AuditLog

# 一期没有 SSO，写入动作统一记在这个演示身份下。
# 接入医院 SSO 后改为真实医生工号，审计表结构不变。
DEMO_ACTOR = "demo-doctor"


def record_audit(
    session: Session,
    *,
    action: str,
    entity: str,
    entity_id: str = "",
    patient_id: str = "",
    detail: dict | None = None,
    actor: str = DEMO_ACTOR,
) -> None:
    session.add(
        AuditLog(
            actor=actor,
            action=action,
            entity=entity,
            entity_id=entity_id,
            patient_id=patient_id,
            detail=detail or {},
        )
    )


def next_id(session: Session, model, prefix: str) -> str:
    """
    生成稳定的业务 ID。

    V4.3 的 mock 用 "R" + Date.now()，同一毫秒内会撞号，且重启后可能回退。
    这里改为按序号递增，不足位补零；并发下若撞主键，回退到 uuid 后缀。

    计数只统计**同前缀**的行：药品与检查同在 orders 表，若数整表行数，
    开完 R0001 后第一张检查单会变成 E0002，序号出现无来由的跳号。
    """
    count = (
        session.scalar(select(func.count()).select_from(model).where(model.id.like(f"{prefix}%"))) or 0
    )
    candidate = f"{prefix}{count + 1:04d}"
    if session.get(model, candidate) is not None:
        return f"{prefix}{uuid4().hex[:8].upper()}"
    return candidate
