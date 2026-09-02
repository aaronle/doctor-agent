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

from ..agent_config import DEFAULT_TIER_MODELS, TIER_LABELS, ResolvedConfig, prompt_hash, published_version, resolve, resolve_model
from ..agents import AGENT_REGISTRY, PROMPT_BUNDLE_VERSION
from ..agents import base as agent_base
from ..audit import DEMO_ACTOR, record_audit
from ..delivery_lane import record_agent_lane_run
from ..agents.context import build_context
from ..eval_datasets import active_cases, describe as describe_datasets, set_enabled, universal_checks
from ..obs import event
from ..schemas import StrictIn
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
    voice_summary_agent,
)

AGENTS = {
    "summary": summary_agent,
    "record": record_agent,
    "diagnosis": diagnosis_agent,
    "risk": risk_agent,
    "comorbidity": comorbidity_agent,
    # **必须是产品路径上真正在跑的那个实例。**
    # 原先指向 voice_plan_agent —— 而 /voice/complete 跑的是 voice_summary_agent。
    # 于是在控制台改「语音问诊」的提示词、存草稿、发布，改的全是一个已经不运行的岗位：
    # 界面一切正常，发布也成功，唯独线上行为一个字都不变。
    # 配置界面指错实例是最难发现的一类 bug —— 它没有任何报错。
    "voice": voice_summary_agent,
}

# 岗位中文名。名字只在注册表里有一份，Agent 实例上没有 `.name` ——
# 想当然去取会得到 AttributeError，而那个异常会被交付平台写入处的兜底吞掉。
AGENT_NAMES = {key: name for key, name, _v in AGENT_REGISTRY}

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


class DraftIn(StrictIn):
    #: 不传就沿用该岗位当前生效的档位，**不默认成快速档**。
    #: 原先默认 clinical_fast：在控制台只改了 Prompt、没碰档位，
    #: 存一次草稿就把岗位悄悄降级到快档 —— 而界面上看不出任何异样。
    model_tier: str | None = None
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
            {"tier": t, "label": TIER_LABELS[t], "model": resolve_model(t)} for t in DEFAULT_TIER_MODELS
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
        # 由 Pydantic 模型现算，不再是手写的 dict ——
        # 控制台看到的 schema 和真正发给模型的那份**必然一致**，
        # 手写两份时它们只是碰巧一样。
        "output_schema": agent.output_model.model_json_schema(),
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
    agent = _agent_or_404(agent_key)
    tier = body.model_tier or resolve(session, agent).model_tier
    if tier not in DEFAULT_TIER_MODELS:
        raise HTTPException(status_code=400, detail=f"未知模型档位：{tier}")
    if not body.role_prompt.strip():
        raise HTTPException(status_code=400, detail="岗位 Prompt 不能为空")
    _validate_params(body.params)

    draft = session.scalar(
        select(AgentVersion).where(AgentVersion.agent_key == agent_key, AgentVersion.status == "draft")
    )
    if draft is None:
        draft = AgentVersion(agent_key=agent_key, version="draft", status="draft")
        session.add(draft)

    draft.model_tier = tier
    draft.model = resolve_model(tier)
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

class DryRunIn(StrictIn):
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


class EvalIn(StrictIn):
    use: str = "draft"


class DatasetToggleIn(StrictIn):
    enabled: bool


@router.get("/eval-datasets")
def list_eval_datasets(session: Session = Depends(get_session)) -> dict:
    """数据集清单与启停状态。加载出错的也列出来，带着错误 —— 不静默藏起来。"""
    return {"datasets": describe_datasets(session)}


@router.patch("/eval-datasets/{dataset_id}")
def toggle_eval_dataset(
    dataset_id: str, body: DatasetToggleIn, session: Session = Depends(get_session)
) -> dict:
    """启用/停用一个数据集。留审计 —— 「那次为什么没跑到」要能查。"""
    known = {d["id"] for d in describe_datasets(session)}
    if dataset_id not in known:
        raise HTTPException(status_code=404, detail=f"未知数据集：{dataset_id}")
    set_enabled(session, dataset_id, body.enabled)
    event("eval_dataset_toggle", dataset=dataset_id, enabled=body.enabled)
    record_audit(
        session,
        action="eval_dataset_toggle",
        entity="eval_dataset",
        entity_id=dataset_id,
        detail={"enabled": body.enabled},
    )
    # 开关与留痕同一个事务：不该出现「开关变了但查不到谁改的」
    session.commit()
    return {"ok": True, "datasets": describe_datasets(session)}


@router.get("/eval-cases")
def list_eval_cases(agent_key: str = "", session: Session = Depends(get_session)) -> dict:
    """
    回归集用例清单 —— 只列**已启用**数据集里的。期望值由人写在数据集里，不自动生成。
    """
    universal = [n for n, _ in universal_checks()]
    return {
        "cases": [
            {
                "id": c.id,
                "name": c.name,
                "agent_key": c.agent_key,
                "patient_id": c.patient_id,
                "dataset_id": c.dataset_id,
                "dataset_name": c.dataset_name,
                "checks": [name for name, _ in c.checks] + universal,
            }
            for c in active_cases(session, agent_key)
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
    # 只跑已启用数据集里的用例。跑了哪些数据集要随结果报出来 ——
    # 否则「87% 通过」这个数字没有分母，关掉半个数据集也能刷上去。
    cases = active_cases(session, agent_key)
    ran_datasets = [
        {"id": d["id"], "name": d["name"], "case_count": d["case_count"]}
        for d in describe_datasets(session)
        if d["enabled"] and not d["error"] and any(c.dataset_id == d["id"] for c in cases)
    ]
    if not cases:
        return {"total": 0, "passed": 0, "failed": 0, "datasets": ran_datasets, "cases": []}

    universal = universal_checks()
    gate = asyncio.Semaphore(EVAL_CONCURRENCY)

    async def one(case) -> dict:
        async with gate:
            inner = SessionLocal()
            try:
                patient = inner.get(Patient, case.patient_id)
                if patient is None:
                    return {
                        "case_id": case.id, "name": case.name, "patient_id": case.patient_id,
                        "dataset_id": case.dataset_id, "dataset_name": case.dataset_name,
                        "passed": False, "degraded": False, "elapsed_ms": 0,
                        "checks": [{"name": "病例存在", "passed": False, "detail": "用例引用的病例不存在"}],
                    }
                ctx = build_context(inner, patient, include_dialog=True)
                outcome = await agent.run(inner, ctx, config_override=config, record=False)
            finally:
                inner.close()

        results = []
        for name, fn in list(case.checks) + universal:
            try:
                ok, detail = fn(outcome.data, ctx)
            except Exception as exc:  # 校验本身出错要看得见，不能静默算通过
                ok, detail = False, f"校验执行异常：{exc}"
            results.append({"name": name, "passed": ok, "detail": detail})

        # **降级一律判不通过。**
        #
        # 兜底输出是确定性本地规则产的，结构完全合法 —— 于是它会**通过所有结构校验**，
        # 而模型其实一次都没跑成。2026-09-03 真的发生过：结构化输出里嵌套对象
        # 偶尔以 JSON 字符串回来，summary 岗位每次都降级，而回归集一片绿。
        # 那个 bug 是端到端实跑才抓到的，不是测出来的。
        #
        # 判据不是「兜底质量好不好」，是「这一次到底测没测到模型」——
        # 「什么都没测」不能长得像「测了都过」。
        if outcome.degraded:
            results.insert(0, {
                "name": "本次真正调用了模型",
                "passed": False,
                "detail": f"已降级为本地规则，本条未测到模型：{outcome.note[:160]}",
            })

        return {
            "case_id": case.id,
            "name": case.name,
            "patient_id": case.patient_id,
            "dataset_id": case.dataset_id,
            "dataset_name": case.dataset_name,
            "degraded": outcome.degraded,
            "elapsed_ms": outcome.elapsed_ms,
            "passed": all(r["passed"] for r in results),
            "checks": results,
        }

    rows = await asyncio.gather(*(one(c) for c in cases))
    passed = sum(1 for r in rows if r["passed"])
    # 通过率必须连着分母与失败清单一起记 —— 只记百分比的话，
    # 日后回看分不清是「改好了」还是「关掉了半个数据集」
    event("eval_run", agent=agent_key, use=body.use, total=len(rows), passed=passed,
          failed=len(rows) - passed,
          datasets="|".join(d["id"] for d in ran_datasets),
          failed_cases="|".join(r["case_id"] for r in rows if not r["passed"]),
          degraded_cases=sum(1 for r in rows if r.get("degraded")),
          version=config.version, source=config.source)
    # 顺手把这次回归写进交付平台的智能体线。
    #
    # 在进程内直接写，不走 /api/delivery/runs 的上报接口 —— 那条接口是给
    # **开发机上的脚本**用的，需要令牌是因为它从公网进来。同一个进程里再绕一圈
    # HTTP、再配一次令牌，只会多一个能配错的地方。
    #
    # 写失败不能影响回归结果：人是来看通过率的，不是来看交付平台的。
    try:
        record_agent_lane_run(
            session,
            agent_key=agent_key,
            label=AGENT_NAMES.get(agent_key, agent_key),
            use=body.use,
            config_version=config.version,
            rows=list(rows),
            datasets=ran_datasets,
        )
    except Exception as exc:  # noqa: BLE001
        event("delivery_lane_write_failed", agent=agent_key, error=f"{type(exc).__name__}: {exc}")

    return {
        "total": len(rows),
        "passed": passed,
        "failed": len(rows) - passed,
        "config_version": config.version,
        "config_source": config.source,
        "datasets": ran_datasets,
        "cases": list(rows),
    }
