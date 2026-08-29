"""
Agent 配置与运行控制台。

面向产品管理员与调优人员，**不是医生端的第八个功能** —— 单独挂在 /api/admin
与前端 /admin 路由下，不影响 V4.3 定义的五个医生端页面。

核心约束：
  - 平台安全层不可编辑，只能随代码发布。管理员能改的只有岗位层 Prompt。
  - 同一岗位同时只有一个 published 版本；发布不覆盖旧版本，历史可查可回滚。
  - 模型只按档位别名配置，具体 Model ID 由平台解析。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..agent_config import MODEL_TIERS, TIER_LABELS, prompt_hash, published_version, resolve, resolve_model
from ..agents import AGENT_REGISTRY, PROMPT_BUNDLE_VERSION
from ..agents import base as agent_base
from ..audit import DEMO_ACTOR, record_audit
from ..database import get_session
from ..models import AgentRun, AgentVersion

router = APIRouter(prefix="/api/admin", tags=["admin"])

# agent_key → 岗位实例，用于取代码默认值
from ..agents import (  # noqa: E402  循环导入规避：注册表在 agents 包初始化后才可用
    comorbidity_agent,
    diagnosis_agent,
    record_agent,
    risk_agent,
    summary_agent,
    voice_plan_agent,
)

AGENTS = {
    "summary": summary_agent,
    "record": record_agent,
    "diagnosis": diagnosis_agent,
    "risk": risk_agent,
    "comorbidity": comorbidity_agent,
    "voice": voice_plan_agent,
}

# 岗位承载的产品功能，控制台总览要显示
AGENT_TASKS = {
    "summary": ["病情概况"],
    "record": ["病历生成"],
    "diagnosis": ["鉴别诊断", "诊断管理"],
    "risk": ["风险管理"],
    "comorbidity": ["共病管理"],
    "voice": ["语音问诊"],
}


class DraftIn(BaseModel):
    model_tier: str = "clinical_fast"
    role_prompt: str = ""
    params: dict = Field(default_factory=dict)
    note: str = ""


def _agent_or_404(agent_key: str):
    agent = AGENTS.get(agent_key)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"未知岗位：{agent_key}")
    return agent


def _recent_stats(session: Session, agent_key: str) -> dict:
    """最近 24 小时的调用情况。成功率是控制台最该一眼看到的数字。"""
    since = datetime.now(UTC) - timedelta(hours=24)
    rows = session.execute(
        select(AgentRun.status, func.count(), func.avg(AgentRun.elapsed_ms), func.sum(AgentRun.total_tokens))
        .where(AgentRun.agent_key == agent_key, AgentRun.created_at >= since)
        .group_by(AgentRun.status)
    ).all()

    total = sum(r[1] for r in rows)
    ok = sum(r[1] for r in rows if r[0] == "ok")
    elapsed = [r[2] for r in rows if r[0] == "ok" and r[2]]
    return {
        "runs_24h": total,
        "success_rate": round(ok / total * 100) if total else None,
        "avg_elapsed_ms": round(elapsed[0]) if elapsed else None,
        "tokens_24h": sum(int(r[3] or 0) for r in rows),
    }


# ------------------------------------------------------------------ 总览


@router.get("/agents")
def list_agents(session: Session = Depends(get_session)) -> dict:
    items = []
    for key, name, code_version in AGENT_REGISTRY:
        agent = AGENTS[key]
        config = resolve(session, agent)
        published = published_version(session, key)
        draft = session.scalar(
            select(AgentVersion).where(AgentVersion.agent_key == key, AgentVersion.status == "draft")
        )
        items.append(
            {
                "agent_key": key,
                "name": name,
                "tasks": AGENT_TASKS[key],
                "code_version": code_version,
                "running_version": config.version,
                "config_source": config.source,
                "model_tier": config.model_tier,
                "model": config.model,
                "has_draft": draft is not None,
                "published_at": published.published_at.isoformat() if published and published.published_at else None,
                **_recent_stats(session, key),
            }
        )
    return {
        "agents": items,
        "model_tiers": [
            {"tier": t, "label": TIER_LABELS[t], "model": resolve_model(t)} for t in MODEL_TIERS
        ],
        "prompt_bundle_version": PROMPT_BUNDLE_VERSION,
    }


# ------------------------------------------------------------------ 配置工作区


@router.get("/agents/{agent_key}")
def get_agent(agent_key: str, session: Session = Depends(get_session)) -> dict:
    agent = _agent_or_404(agent_key)
    config = resolve(session, agent)
    versions = session.scalars(
        select(AgentVersion).where(AgentVersion.agent_key == agent_key).order_by(AgentVersion.id.desc()).limit(20)
    ).all()
    draft = next((v for v in versions if v.status == "draft"), None)

    return {
        "agent_key": agent_key,
        "name": dict((k, n) for k, n, _ in AGENT_REGISTRY)[agent_key],
        "tasks": AGENT_TASKS[agent_key],
        # 平台安全层只读展示 —— 让管理员看得到自己改不了什么，比藏起来更可信
        "safety_layer": agent_base.SAFETY_LAYER,
        "safety_layer_editable": False,
        "code_default_prompt": agent.role_prompt,
        "output_schema": agent.output_schema,
        "context_fields": list(agent.context_fields or []),
        "running": {
            "version": config.version,
            "source": config.source,
            "model_tier": config.model_tier,
            "model": config.model,
            "role_prompt": config.role_prompt,
            "params": config.params,
        },
        "draft": None
        if draft is None
        else {
            "id": draft.id,
            "model_tier": draft.model_tier,
            "role_prompt": draft.role_prompt,
            "params": draft.params,
            "note": draft.note,
        },
        "versions": [
            {
                "id": v.id,
                "version": v.version,
                "status": v.status,
                "model_tier": v.model_tier,
                "model": v.model,
                "prompt_hash": v.prompt_hash,
                "note": v.note,
                "author": v.author,
                "created_at": v.created_at.isoformat(),
                "published_at": v.published_at.isoformat() if v.published_at else None,
            }
            for v in versions
        ],
    }


@router.put("/agents/{agent_key}/draft")
def save_draft(agent_key: str, body: DraftIn, session: Session = Depends(get_session)) -> dict:
    _agent_or_404(agent_key)
    if body.model_tier not in MODEL_TIERS:
        raise HTTPException(status_code=400, detail=f"未知模型档位：{body.model_tier}")
    if not body.role_prompt.strip():
        raise HTTPException(status_code=400, detail="岗位 Prompt 不能为空")

    draft = session.scalar(
        select(AgentVersion).where(AgentVersion.agent_key == agent_key, AgentVersion.status == "draft")
    )
    if draft is None:
        draft = AgentVersion(agent_key=agent_key, version="draft", status="draft")
        session.add(draft)

    draft.model_tier = body.model_tier
    draft.model = resolve_model(body.model_tier)
    draft.role_prompt = body.role_prompt
    draft.params = body.params
    draft.note = body.note
    draft.prompt_bundle_version = PROMPT_BUNDLE_VERSION
    draft.prompt_hash = prompt_hash(body.role_prompt)
    draft.author = DEMO_ACTOR
    session.commit()

    return {"ok": True, "draft_id": draft.id, "prompt_hash": draft.prompt_hash}


@router.post("/agents/{agent_key}/publish")
def publish(agent_key: str, session: Session = Depends(get_session)) -> dict:
    """
    发布草稿。旧的 published 版本置为 inactive 而非删除 —— 历史可查、可回滚。
    """
    _agent_or_404(agent_key)
    draft = session.scalar(
        select(AgentVersion).where(AgentVersion.agent_key == agent_key, AgentVersion.status == "draft")
    )
    if draft is None:
        raise HTTPException(status_code=400, detail="没有待发布的草稿")

    count = session.scalar(
        select(func.count()).select_from(AgentVersion).where(
            AgentVersion.agent_key == agent_key, AgentVersion.status != "draft"
        )
    ) or 0

    for old in session.scalars(
        select(AgentVersion).where(AgentVersion.agent_key == agent_key, AgentVersion.status == "published")
    ).all():
        old.status = "inactive"

    draft.status = "published"
    draft.version = f"v{count + 1}"
    draft.published_at = datetime.now(UTC)

    record_audit(
        session,
        action="publish_agent_config",
        entity="agent_version",
        entity_id=str(draft.id),
        detail={"agent_key": agent_key, "version": draft.version, "model_tier": draft.model_tier,
                "prompt_hash": draft.prompt_hash},
    )
    session.commit()
    return {"ok": True, "version": draft.version, "published_at": draft.published_at.isoformat()}


@router.post("/agents/{agent_key}/rollback/{version_id}")
def rollback(agent_key: str, version_id: int, session: Session = Depends(get_session)) -> dict:
    """回滚到某个历史版本：把它重新置为 published，当前版本降为 inactive。"""
    _agent_or_404(agent_key)
    target = session.get(AgentVersion, version_id)
    if target is None or target.agent_key != agent_key:
        raise HTTPException(status_code=404, detail="版本不存在")
    if target.status == "draft":
        raise HTTPException(status_code=400, detail="草稿不能作为回滚目标，请先发布")

    for current in session.scalars(
        select(AgentVersion).where(AgentVersion.agent_key == agent_key, AgentVersion.status == "published")
    ).all():
        current.status = "inactive"

    target.status = "published"
    target.published_at = datetime.now(UTC)

    record_audit(
        session,
        action="rollback_agent_config",
        entity="agent_version",
        entity_id=str(target.id),
        detail={"agent_key": agent_key, "version": target.version},
    )
    session.commit()
    return {"ok": True, "version": target.version}


@router.delete("/agents/{agent_key}/draft")
def discard_draft(agent_key: str, session: Session = Depends(get_session)) -> dict:
    _agent_or_404(agent_key)
    draft = session.scalar(
        select(AgentVersion).where(AgentVersion.agent_key == agent_key, AgentVersion.status == "draft")
    )
    if draft is None:
        raise HTTPException(status_code=400, detail="没有草稿")
    session.delete(draft)
    session.commit()
    return {"ok": True}


# ------------------------------------------------------------------ 运行与审计


@router.get("/runs")
def list_runs(
    agent_key: str = "",
    status: str = "",
    limit: int = 50,
    session: Session = Depends(get_session),
) -> dict:
    """
    运行日志。**不返回完整输出与病历内容** —— 日志不应成为病历副本，
    只给足以定位问题的摘要：岗位、模型、档位、配置版本、耗时、Token、错误。
    """
    query = select(AgentRun).order_by(AgentRun.id.desc()).limit(min(limit, 200))
    if agent_key:
        query = query.where(AgentRun.agent_key == agent_key)
    if status:
        query = query.where(AgentRun.status == status)

    rows = session.scalars(query).all()
    return {
        "runs": [
            {
                "id": r.id,
                "agent_key": r.agent_key,
                "patient_id": r.patient_id,
                "status": r.status,
                "provider": r.provider,
                "model": r.model,
                "model_tier": (r.input_digest or {}).get("model_tier", ""),
                "config_version": (r.input_digest or {}).get("config_version", ""),
                "config_source": (r.input_digest or {}).get("config_source", ""),
                "elapsed_ms": r.elapsed_ms,
                "total_tokens": r.total_tokens,
                "context_hash": (r.input_digest or {}).get("context_hash", ""),
                "error": r.error,
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ]
    }
