"""
埋点：医生实际点了什么。

`operation_logs` 是 **HTTP 级**的，能回答「哪个接口调得多」，回答不了
「哪个按钮点得多」—— 而后者才是产品要问的。大量交互根本不发请求：
关掉追问提示浮框、调字号、全屏、拖窗口、切标签页。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import TrainingSample, UsageEvent
from ..schemas import StrictIn

router = APIRouter(prefix="/api/telemetry", tags=["telemetry"])

#: 单次上报的事件数上限。前端是攒批发的，给个上限免得一次灌进来几万条
MAX_BATCH = 200

#: 事件名与作用对象的长度上限，按列宽来。超了截断而不是拒收 ——
#: 埋点丢一条不要紧，但因为一条太长把整批退回去就太蠢了
_MAX_NAME = 64


class EventIn(StrictIn):
    event: str
    target: str = ""
    patient_id: str = ""
    props: dict = Field(default_factory=dict)
    client_ts: int = 0


class EventBatchIn(StrictIn):
    session_id: str = ""
    actor: str = ""
    events: list[EventIn] = Field(default_factory=list)


@router.post("/events")
def ingest(body: EventBatchIn, session: Session = Depends(get_session)) -> dict:
    """
    收一批埋点。

    **永远返回 200。** 埋点是旁路，它出问题不该让医生的操作失败 ——
    前端那边也是 fire-and-forget，不等这个响应。所以这里只做长度截断，
    不做校验拒收：一条脏数据的代价远小于「因为埋点报错，医生以为提交失败」。
    """
    rows = [
        UsageEvent(
            session_id=body.session_id[:_MAX_NAME],
            actor=body.actor[:_MAX_NAME],
            event=(e.event or "unknown")[:_MAX_NAME],
            target=(e.target or "")[:_MAX_NAME],
            patient_id=(e.patient_id or "")[:32],
            props=e.props if isinstance(e.props, dict) else {},
            client_ts=e.client_ts,
        )
        for e in body.events[:MAX_BATCH]
    ]
    session.add_all(rows)
    session.commit()
    return {"ok": True, "accepted": len(rows)}


@router.get("/usage")
def usage(days: int = 7, session: Session = Depends(get_session)) -> dict:
    """
    使用情况汇总。

    **存的是原始事件，聚合在查询时做。** 聚合口径会变（今天想看按天、
    明天想看按科室），而原始事件只采一次 —— 反过来做的话，改口径就得重新采。
    """
    since = datetime.now(timezone.utc) - timedelta(days=max(1, days))

    def rows(*cols, order_desc=True, limit=30):
        q = select(*cols, func.count().label("n")).where(UsageEvent.created_at >= since)
        q = q.group_by(*cols).order_by(func.count().desc() if order_desc else func.count())
        return session.execute(q.limit(limit)).all()

    by_event = [{"event": e, "count": n} for e, n in rows(UsageEvent.event)]
    by_target = [
        {"event": e, "target": t, "count": n}
        for e, t, n in rows(UsageEvent.event, UsageEvent.target)
        if t
    ]

    total = session.scalar(
        select(func.count()).select_from(UsageEvent).where(UsageEvent.created_at >= since)
    ) or 0
    sessions = session.scalar(
        select(func.count(func.distinct(UsageEvent.session_id))).where(UsageEvent.created_at >= since)
    ) or 0

    return {
        "days": days,
        "total_events": total,
        "sessions": sessions,
        # 人均次数：只看总量会被一个人狂点刷上去
        "per_session": round(total / sessions, 1) if sessions else 0,
        "by_event": by_event,
        "by_target": by_target,
    }


@router.get("/training")
def training_summary(limit: int = 20, session: Session = Depends(get_session)) -> dict:
    """
    微调语料概览。

    最要紧的一个数是 **`edited` 的占比** —— 那是模型和医生的分歧率。
    `accepted` 高说明模型在这类病例上已经够用；`discarded` 高说明它跑偏了，
    那些行要优先拿出来看。

    `trainable_count` 与总数分开报：接真实 HIS 之后两者会拉开差距，
    而「有多少条能真的拿去训练」才是排期时要用的那个数。
    """
    total = session.scalar(select(func.count()).select_from(TrainingSample)) or 0
    trainable = session.scalar(
        select(func.count()).select_from(TrainingSample).where(TrainingSample.trainable.is_(True))
    ) or 0

    by_verdict = [
        {"verdict": v, "count": n}
        for v, n in session.execute(
            select(TrainingSample.verdict, func.count())
            .group_by(TrainingSample.verdict)
            .order_by(func.count().desc())
        ).all()
    ]
    by_agent = [
        {"agent_key": a, "count": n}
        for a, n in session.execute(
            select(TrainingSample.agent_key, func.count())
            .group_by(TrainingSample.agent_key)
            .order_by(func.count().desc())
        ).all()
    ]

    rows = session.scalars(
        select(TrainingSample).order_by(TrainingSample.id.desc()).limit(max(1, min(limit, 100)))
    ).all()

    return {
        "total": total,
        "trainable_count": trainable,
        "by_verdict": by_verdict,
        "by_agent": by_agent,
        # 列表**不带正文** —— 概览页不需要病历原文，
        # 顺手把它塞进一个随手可访问的接口，等于给自己开了个数据出口
        "recent": [
            {
                "id": r.id, "patient_id": r.patient_id, "agent_key": r.agent_key,
                "task": r.task, "verdict": r.verdict,
                "changed_fields": sorted(r.changed.keys()) if isinstance(r.changed, dict) else [],
                "source": r.source, "trainable": r.trainable,
                "created_at": r.created_at.isoformat() if r.created_at else "",
            }
            for r in rows
        ],
    }
