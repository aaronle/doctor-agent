"""编排层对外接口：Master（医生本人）与六个 Worker。

与既有的 `/api/emr/*` 并存，**不替换**。理由：

- `/api/emr/*` 是产品路径，形状由 V4.3 界面倒推，有还原度门禁守着；
- `/api/orchestration/*` 是 Agent 路径，形状由 AgentScope 决定，用于对话式使用与调试。

一次性把产品路径切过来，等于同时改「界面契约」和「Agent 架构」两件事，
出问题时分不清是谁的锅。先并存，等编排层在真实使用中站住了再谈迁移。
"""

from __future__ import annotations

import asyncio

from agentscope.message import Msg
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Patient
from ..obs import event, timed
from ..orchestration import (
    DEFAULT_MODEL,
    TOOL_REGISTRY,
    build_master,
    build_worker,
    load_all_agents,
    load_all_skills,
    model_is_configured,
)
from ..schemas import StrictIn

router = APIRouter(prefix="/api/orchestration", tags=["orchestration"])

#: 单次调用的墙钟上限。Master 串六个 worker 实测约 100–200 秒；
#: 给到 300 秒是为了留出网关抖动的重试窗口，再长就该让使用者知道出事了。
CALL_TIMEOUT_S = 300


def _patient_or_404(session: Session, patient_id: str) -> Patient:
    patient = session.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail=f"无此就诊人：{patient_id}")
    return patient


@router.get("/topology")
def topology() -> dict:
    """
    编排拓扑：Master / Worker / Skill / Tool 四层的当前装配。

    这是 CI/CD 平台「智能体」那一侧的数据源 —— 界面上要能看出
    「哪个 worker 挂了哪些 skill、能调哪些工具」，而不是去翻 YAML。
    """
    master, workers = load_all_agents()
    skills = load_all_skills()

    return {
        "model": DEFAULT_MODEL,
        "configured": model_is_configured(),
        "master": {
            "name": master.name,
            "display_name": master.display_name,
            "workflow": list(master.workflow),
            "max_iters": master.max_iters or 12,
            "has_persona": bool(master.resolve_prompt()),
        },
        "workers": [
            {
                "name": name,
                "display_name": p.display_name,
                "tool_name": p.resolve_worker_tool_name(),
                "model": p.model or DEFAULT_MODEL,
                "max_iters": p.max_iters or 8,
                "skills": [
                    {
                        "name": s,
                        "display_name": skills[s].display_name,
                        "version": skills[s].version,
                        "description": skills[s].description,
                        "tools": skills[s].all_tools,
                        "prompt_chars": len(skills[s].body),
                    }
                    for s in p.skills
                    if s in skills
                ],
            }
            for name, p in sorted(workers.items())
        ],
        "tools": [
            {
                "name": n,
                # docstring 首行就是这个工具做什么，末尾的【真实/规则/Mock】标了数据来源
                "summary": (fn.__doc__ or "").strip().splitlines()[0] if fn.__doc__ else "",
            }
            for n, fn in sorted(TOOL_REGISTRY.items())
        ],
    }


class AskIn(StrictIn):
    patient_id: str
    question: str
    #: 只装这几个 worker。留空 = 全部。给单岗位调试用。
    workers: list[str] | None = None


@router.post("/ask")
async def ask_master(body: AskIn, session: Session = Depends(get_session)) -> dict:
    """
    问主诊医生。Master 自行决定叫哪些助手、要不要采纳。

    **不做流式**：Master 的价值在于它对多个 worker 结果的取舍，
    那个判断只有在全部 worker 回来之后才成立。中途流式吐字会让使用者
    看到尚未被取舍的中间结论，那比等一会儿更糟。
    """
    # 同上：就诊人不存在是客户端错误，先判
    _patient_or_404(session, body.patient_id)
    if not model_is_configured():
        raise HTTPException(status_code=503, detail="模型通道未配置，编排层不可用")

    with timed("orchestration_ask", patient=body.patient_id, workers=body.workers or "all") as ev:
        master = await build_master(patient_id=body.patient_id, only_workers=body.workers)
        try:
            reply: Msg = await asyncio.wait_for(
                master(Msg("使用者", body.question, "user")), timeout=CALL_TIMEOUT_S
            )
        except TimeoutError:
            # 超时如实报，不返回半截结论 —— 半截的临床判断比没有更危险
            raise HTTPException(
                status_code=504, detail=f"编排超过 {CALL_TIMEOUT_S} 秒未完成，已中止"
            ) from None
        text = reply.get_text_content() or str(reply.content)
        ev["chars"] = len(text)

    return {
        "patient_id": body.patient_id,
        "answer": text,
        "model": DEFAULT_MODEL,
        "workers_available": sorted(master.worker_tool_names),
    }


class WorkerRunIn(StrictIn):
    patient_id: str
    task: str


@router.post("/workers/{worker_name}/run")
async def run_worker(
    worker_name: str, body: WorkerRunIn, session: Session = Depends(get_session)
) -> dict:
    """
    单独跑一个 worker，绕过 Master。

    用途是调试与回归：要判断「是这个岗位的 skill 写坏了，还是 Master 派错了活」，
    就必须能单独驱动它。
    """
    # 先校验请求本身，再看服务可用性：worker 名字打错是客户端错误，
    # 用 503 盖住它只会让人以为是模型挂了，去查错方向。
    _master, workers = load_all_agents()
    if worker_name not in workers:
        raise HTTPException(
            status_code=404, detail=f"无此 worker：{worker_name}；可用：{'、'.join(sorted(workers))}"
        )
    _patient_or_404(session, body.patient_id)
    if not model_is_configured():
        raise HTTPException(status_code=503, detail="模型通道未配置，编排层不可用")

    skills = load_all_skills()
    profile = workers[worker_name]

    with timed("orchestration_worker", worker=worker_name, patient=body.patient_id) as ev:
        worker = build_worker(
            profile, [skills[s] for s in profile.skills], patient_id=body.patient_id
        )
        try:
            reply: Msg = await asyncio.wait_for(
                worker(Msg("主诊医生", body.task, "user")), timeout=CALL_TIMEOUT_S
            )
        except TimeoutError:
            raise HTTPException(
                status_code=504, detail=f"{worker_name} 超过 {CALL_TIMEOUT_S} 秒未完成，已中止"
            ) from None
        text = reply.get_text_content() or str(reply.content)
        ev["chars"] = len(text)

    event("worker_run_api", worker=worker_name, patient=body.patient_id, chars=len(text))
    return {
        "worker": worker_name,
        "display_name": profile.display_name,
        "patient_id": body.patient_id,
        "answer": text,
        "model": profile.model or DEFAULT_MODEL,
        "skills": list(profile.skills),
    }
