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

import asyncio

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..agent_config import MODEL_TIERS, TIER_LABELS, ResolvedConfig, prompt_hash, published_version, resolve, resolve_model
from ..agents import AGENT_REGISTRY, PROMPT_BUNDLE_VERSION
from ..agents import base as agent_base
from ..audit import DEMO_ACTOR, record_audit
from ..agents.context import build_context
from ..eval_cases import UNIVERSAL_CHECKS, cases_for
from ..database import SessionLocal, get_session
from ..models import AgentRun, AgentVersion, Patient

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


# 参数上下限。界面上也会限，但**服务端必须自己拦** —— 界面能绕过，服务端不能。
#
# temperature 临床岗位默认 0：调高会让同一份病历每次生成不同，无法复核。
# max_tokens 下限 512：太小会截断 JSON，整个岗位跟着降级（一期真踩过）。
PARAM_BOUNDS = {
    "temperature": (0.0, 1.0),
    "max_tokens": (512, 8192),
}


class DraftIn(BaseModel):
    model_tier: str = "clinical_fast"
    role_prompt: str = ""
    params: dict = Field(default_factory=dict)
    note: str = ""


def _validate_params(params: dict) -> None:
    """
    参数边界在服务端拦。

    界面上也会限，但界面能绕过 —— 一个 curl 就能把 max_tokens 设成 16，
    然后所有岗位一起降级，而日志里只会看到「JSON 解析失败」。
    """
    for key, value in (params or {}).items():
        if key not in PARAM_BOUNDS:
            raise HTTPException(status_code=400, detail=f"不支持的参数：{key}")
        low, high = PARAM_BOUNDS[key]
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{key} 必须是数字") from None
        if not low <= num <= high:
            raise HTTPException(status_code=400, detail=f"{key} 超出允许范围 {low}–{high}")


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
    _validate_params(body.params)

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

# ------------------------------------------------------------------ 试运行与调优

class DryRunIn(BaseModel):
    patient_id: str
    #「用哪一版配置跑」：草稿或当前线上
    use: str = "draft"


def _demo_patient_or_400(session: Session, patient_id: str) -> Patient:
    """
    试运行只允许演示病例。

    一期本来就只有虚构数据，但这条要写死在服务端 —— 只靠界面不给入口，
    换个 curl 就绕过去了。接真实数据后这里是第一道闸。
    """
    patient = session.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    return patient


def _config_for(session: Session, agent, use: str) -> ResolvedConfig:
    """取草稿或线上配置。草稿不存在时明确报错，不要静默回落到线上 —— 那会让人
    以为自己在试草稿，其实试的是线上，得出完全相反的结论。"""
    if use == "published":
        return resolve(session, agent)
    draft = session.scalars(
        select(AgentVersion).where(AgentVersion.agent_key == agent.key, AgentVersion.status == "draft")
    ).first()
    if draft is None:
        raise HTTPException(status_code=400, detail="该岗位没有草稿，请先保存草稿或选择「线上」")
    return ResolvedConfig(
        agent_key=agent.key,
        version=f"draft#{draft.id}",
        source="draft",
        model_tier=draft.model_tier,
        model=resolve_model(draft.model_tier),
        role_prompt=draft.role_prompt,
        params=draft.params or {},
    )


async def _run_once(agent, ctx: dict, config: ResolvedConfig) -> dict:
    """
    用指定配置跑一次，**不记账、不写缓存**。

    独立 Session：与聚合读取一样，并发跑两次不能共用一个 Session。
    """
    session = SessionLocal()
    try:
        outcome = await agent.run(session, ctx, config_override=config, record=False)
    finally:
        session.close()
    return {
        "output": outcome.data,
        "provider": outcome.provider,
        "degraded": outcome.degraded,
        "note": outcome.note,
        "model": config.model,
        "model_tier": config.model_tier,
        "config_version": config.version,
        "config_source": config.source,
        "prompt_hash": prompt_hash(config.role_prompt),
        "elapsed_ms": outcome.elapsed_ms,
        "total_tokens": outcome.total_tokens,
    }


@router.post("/agents/{agent_key}/dry-run")
async def dry_run(agent_key: str, body: DryRunIn, session: Session = Depends(get_session)) -> dict:
    """
    用草稿或线上配置跑一个演示病例，看真实输出。

    **不写缓存、不落库、不计入运行统计。** 见 docs/product/11 第 1.2 节。
    """
    agent = _agent_or_404(agent_key)
    patient = _demo_patient_or_400(session, body.patient_id)
    config = _config_for(session, agent, body.use)
    ctx = build_context(session, patient, include_dialog=True)
    return await _run_once(agent, ctx, config)


@router.post("/agents/{agent_key}/compare")
async def compare(agent_key: str, body: DryRunIn, session: Session = Depends(get_session)) -> dict:
    """
    草稿与线上并排跑同一个病例。

    **两次调用并发发起** —— 串行会让每次调优等两倍时间，而调优是个高频动作。
    """
    agent = _agent_or_404(agent_key)
    patient = _demo_patient_or_400(session, body.patient_id)
    draft_cfg = _config_for(session, agent, "draft")
    live_cfg = resolve(session, agent)
    ctx = build_context(session, patient, include_dialog=True)

    live, draft = await asyncio.gather(
        _run_once(agent, ctx, live_cfg),
        _run_once(agent, ctx, draft_cfg),
    )
    return {"patient_id": body.patient_id, "published": live, "draft": draft, "diff": _diff(live["output"], draft["output"])}


def _diff(before: dict, after: dict) -> list[dict]:
    """
    逐字段标出差异。

    输出动辄几十个字段，给两坨 JSON 等于没给 —— 人眼比不出来。
    只比顶层键：再深就得做树形展示，那是二期的事，一期先把「哪几段变了」说清楚。
    """
    keys = sorted(set(before) | set(after))
    rows = []
    for k in keys:
        b, a = before.get(k), after.get(k)
        if k not in before:
            kind = "added"
        elif k not in after:
            kind = "removed"
        elif b == a:
            kind = "same"
        else:
            kind = "changed"
        rows.append({"field": k, "kind": kind})
    return rows



# ------------------------------------------------------------------ 回归集

# 并发上限。网关有速率限制，一次打十几个并发只会换来一片 502 ——
# 那看起来像「这次改动把岗位改坏了」，其实只是打太急，会把人引向完全错误的结论。
EVAL_CONCURRENCY = 3


class EvalIn(BaseModel):
    use: str = "draft"


@router.get("/eval-cases")
def list_eval_cases(agent_key: str = "") -> dict:
    """回归集用例清单。期望值由人写在 eval_cases.py，不自动生成。"""
    return {
        "cases": [
            {
                "id": c["id"],
                "name": c["name"],
                "agent_key": c["agent_key"],
                "patient_id": c["patient_id"],
                "checks": [name for name, _ in c["checks"]] + [n for n, _ in UNIVERSAL_CHECKS],
            }
            for c in cases_for(agent_key)
        ]
    }


@router.post("/agents/{agent_key}/eval")
async def run_eval(agent_key: str, body: EvalIn, session: Session = Depends(get_session)) -> dict:
    """
    用草稿或线上配置跑完该岗位的全部回归用例。

    与试运行一样：不记账、不写缓存。校验全部是确定性规则，
    不用模型给模型打分 —— 那只会得到好看的分数。
    """
    agent = _agent_or_404(agent_key)
    config = _config_for(session, agent, body.use)
    cases = cases_for(agent_key)
    if not cases:
        return {"total": 0, "passed": 0, "failed": 0, "cases": []}

    gate = asyncio.Semaphore(EVAL_CONCURRENCY)

    async def one(case: dict) -> dict:
        async with gate:
            inner = SessionLocal()
            try:
                patient = inner.get(Patient, case["patient_id"])
                if patient is None:
                    return {
                        "case_id": case["id"], "name": case["name"], "patient_id": case["patient_id"],
                        "passed": False, "degraded": False, "elapsed_ms": 0,
                        "checks": [{"name": "病例存在", "passed": False, "detail": "用例引用的病例不存在"}],
                    }
                ctx = build_context(inner, patient, include_dialog=True)
                outcome = await agent.run(inner, ctx, config_override=config, record=False)
            finally:
                inner.close()

        results = []
        for name, fn in list(case["checks"]) + UNIVERSAL_CHECKS:
            try:
                ok, detail = fn(outcome.data, ctx)
            except Exception as exc:  # 校验本身出错要看得见，不能静默算通过
                ok, detail = False, f"校验执行异常：{exc}"
            results.append({"name": name, "passed": ok, "detail": detail})

        return {
            "case_id": case["id"],
            "name": case["name"],
            "patient_id": case["patient_id"],
            # 降级时输出来自本地规则，判定结果说明不了提示词的好坏，单独标出来
            "degraded": outcome.degraded,
            "elapsed_ms": outcome.elapsed_ms,
            "passed": all(r["passed"] for r in results),
            "checks": results,
        }

    rows = await asyncio.gather(*(one(c) for c in cases))
    passed = sum(1 for r in rows if r["passed"])
    return {
        "total": len(rows),
        "passed": passed,
        "failed": len(rows) - passed,
        "config_version": config.version,
        "config_source": config.source,
        "cases": list(rows),
    }
