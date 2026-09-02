"""
AI 面。聚合读取 + 两路 SSE + 其余 AI 端点。

`report-summary` 是工作站打开患者后的主加载请求，前端几乎所有 AI 区块
都由它一次喂饱。它是多个 Agent 结果的合流出口，因此**必须支持部分就绪**：
某个岗位失败时该字段给降级值，不能让整个请求失败。
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ..agents import (
    SECTION_KEYS,
    SECTION_LABELS,
    comorbidity_agent,
    diagnosis_agent,
    hard_rule_alerts,
    merge_risks,
    record_agent,
    record_field_agent,
    risk_agent,
    summary_agent,
    interview_agent,
)
from .. import cache
from ..agents.context import build_context, has_interview, latest_dialog, seed_items, seed_payload
from ..audit import next_id, record_audit
from ..schemas import StrictIn
from ..database import SessionLocal, get_session
from ..llm import ChatMessage, LlmError, get_llm_client
from ..models import AuditLog, Patient, RecordDraft, Referral, InterviewSession
from ..record_quality import evaluate
from ..obs import event

router = APIRouter(prefix="/api/emr", tags=["emr"])

SSE_HEADERS = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
}


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _patient_or_404(session: Session, patient_id: str) -> Patient:
    patient = session.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    return patient


async def _run_isolated(agent, ctx: dict, **kwargs):
    """
    每个 Agent 用独立 Session 运行。

    并发跑五个岗位时共用一个 Session 会让 agent_runs 的写入相互穿插，
    SQLAlchemy 的 Session 本来就不为并发使用设计。独立 Session 代价很小。
    """
    session = SessionLocal()
    try:
        return await agent.run(session, ctx, **kwargs)
    finally:
        session.close()


# ------------------------------------------------------------------ 专项评估目录

# V4.3 把 33 项专项评估写死在打包产物里。一期改由后端提供：
# 规格要求前端零写死数据，任何界面上的内容都要经由 API。
_CATALOG_PATH = Path(__file__).resolve().parents[1] / "data/assessment_catalog.json"


@router.get("/assessment-catalog")
def assessment_catalog() -> dict:
    """
    专项评估技能目录，五分类 33 项。

    这是 V4.3 的 20 个端点之外唯一新增的接口，因为原界面把它硬编码了。
    一期只做目录展示，单项能力的 Agent 化不在范围内。
    """
    return json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))


# ------------------------------------------------------------------ 临床知识库

_KB_PATH = Path(__file__).resolve().parents[1] / "data/knowledge_base.json"


def _knowledge_base() -> dict:
    return json.loads(_KB_PATH.read_text(encoding="utf-8"))


@router.get("/knowledge")
def knowledge_list(q: str = "") -> dict:
    """
    临床知识库目录：检验解读三条 + 鉴别诊断/诊疗指南四条。

    带 `q` 时按关键词匹配，供界面在一段文本（对话回复、检查结论）旁挂出
    「相关条目」。匹配放在服务端，因为关键词是数据的一部分，跟着内容走。

    只返回目录不返回正文 —— 正文最长 800 余字，列表里带上纯属浪费。
    """
    kb = _knowledge_base()
    items = [{"key": k, "title": v["title"], "keywords": v["keywords"]} for k, v in kb.items()]
    if not q:
        return {"items": items}
    hit = [i for i in items if any(w in q for w in i["keywords"])]
    return {"items": hit}


@router.get("/knowledge/{key}")
def knowledge_detail(key: str) -> dict:
    """
    单条词条正文。

    正文是 HTML（h3/table/ul/p 等结构标签），由本仓库静态提供、无用户输入
    参与拼接，因此前端以 v-html 渲染是安全的。内容变更走代码评审。
    """
    kb = _knowledge_base()
    if key not in kb:
        raise HTTPException(status_code=404, detail="词条不存在")
    return {"key": key, **kb[key]}


# ------------------------------------------------------------------ 聚合读取


# ------------------------------------------------------------------ 就诊状态机

"""
桌面端的问诊流程分三态：进入 → 问诊中 → 已生成。

**为什么要有这个状态**：改之前，八个 AI 标签页的结论是在医生跟患者说第一句话
**之前**就算好的 —— 只基于种子档案，不含任何问诊内容。摆在那里会让医生先看到
答案再去找证据，那是锚定，不是辅助。

**什么锁、什么不锁**，按「证据从哪来」分：

| 不锁（一进来就给） | 锁（问诊后才给） |
| --- | --- |
| 硬规则红色风险 —— 纯代码判定，危急值不能等 | 病情概要 |
| 阳性结果、检查检验 —— HIS 已有 | 鉴别诊断 |
| 健康档案、时间轴 —— HIS 已有 | 共病管理 |
| 专项评估目录 —— 静态字典 | 病历草稿 |

锁着的部分**留在原位并说明原因**，不是让它消失：消失会让医生以为系统没这功能。
"""

UNLOCK_REASONS = {"interview", "skipped"}


def _visit_state(session: Session, patient) -> dict:
    payload = patient.payload or {}
    unlock = payload.get("analysis_unlock") or {}
    return {
        "patient_id": patient.id,
        "interview_done": has_interview(session, patient.id),
        "analysis_unlocked": bool(unlock.get("reason")),
        "unlocked_by": unlock.get("reason", ""),
        "unlocked_at": unlock.get("at", ""),
    }


def _unlock_analysis(session: Session, patient, reason: str) -> dict:
    payload = patient.payload or {}
    payload["analysis_unlock"] = {"reason": reason, "at": datetime.now(UTC).isoformat()}
    patient.payload = payload
    flag_modified(patient, "payload")
    record_audit(
        session,
        action="analysis_unlock",
        entity="patient",
        entity_id=patient.id,
        patient_id=patient.id,
        detail={"reason": reason},
    )
    event("analysis_unlock", patient=patient.id, reason=reason)
    return _visit_state(session, patient)


@router.get("/visit-state/{patient_id}")
def visit_state(patient_id: str, session: Session = Depends(get_session)) -> dict:
    """
    这一场就诊走到哪了。刷新页面后要能恢复 ——
    否则医生问完一轮、刷新一下，八个标签页又锁回去了。
    """
    return _visit_state(session, _patient_or_404(session, patient_id))


class UnlockIn(StrictIn):
    patient_id: str
    reason: str = "skipped"


@router.post("/analysis/unlock")
def unlock_analysis(body: UnlockIn, session: Session = Depends(get_session)) -> dict:
    """
    解锁 AI 分析。

    两条路径：问诊结束（`interview`，由 interview/complete 自动调）与
    医生显式跳过（`skipped`）。**跳过这条不能少** —— 复诊、患者不配合、
    医生已自行问完，这些情况下分析不能因此永远出不来。
    """
    if body.reason not in UNLOCK_REASONS:
        raise HTTPException(status_code=400, detail=f"未知解锁原因：{body.reason}")
    patient = _patient_or_404(session, body.patient_id)
    state = _unlock_analysis(session, patient, body.reason)
    session.commit()
    return {"ok": True, **state}


@router.get("/objective/{patient_id}")
def objective_data(patient_id: str, session: Session = Depends(get_session)) -> dict:
    """
    这一场就诊的**客观资料**。确定性、毫秒级、不调模型。

    **为什么要单独开**：改成问诊门禁之后发现，检查记录与时间轴原本是搭
    `report-summary` 一起回来的 —— 而那个请求现在要等问诊。结果是规格里写着
    「客观数据一进来就给」，实际上时间轴、检查子页、健康档案概览全是空的。
    数据本身跟模型无关，只是当初图省事挂在了同一个出口上。

    时间轴 = 种子历史 + 本次就诊的真实动作（审计流），两者都不依赖模型。
    """
    _patient_or_404(session, patient_id)
    return {
        "patient_id": patient_id,
        "examinations": seed_items(session, "examination", patient_id),
        "timeline": seed_items(session, "timeline", patient_id) + _timeline_from_audit(session, patient_id),
    }


@router.get("/red-alerts/{patient_id}")
def red_alerts(patient_id: str, session: Session = Depends(get_session)) -> dict:
    """
    硬规则红色风险。**纯代码判定，不调模型，毫秒级返回。**

    单独开这个端点，是为了让工作站一进来就能显示危急值 —— 不必等
    report-summary 那 18–20 秒的四岗位并发，更不能等问诊结束。
    让医生在不知道血钾 6.8 的情况下问完一整轮，是不能接受的。
    """
    patient = _patient_or_404(session, patient_id)
    ctx = build_context(session, patient)
    alerts = hard_rule_alerts(ctx)
    handled = (patient.payload or {}).get("handled_alerts", [])
    return {
        "patient_id": patient_id,
        "alerts": alerts,
        "handled_alerts": handled,
        "open_count": len([a for a in alerts if a["id"] not in handled]),
    }


@router.get("/report-summary/{patient_id}")
async def report_summary(
    patient_id: str,
    refresh: bool = False,
    session: Session = Depends(get_session),
) -> dict:
    patient = _patient_or_404(session, patient_id)
    # seed_dialog_fallback=False：医生跳过问诊时，拿一段他从没做过的演示对话
    # 去生成「病情概要」「鉴别诊断」，比不给分析更糟 —— 那是把演示数据当事实。
    ctx = build_context(session, patient, include_dialog=True, seed_dialog_fallback=False)

    cache_key = cache.context_key(patient_id, ctx)
    if not refresh:
        cached = cache.get(cache_key)
        if cached is not None:
            return {**cached, "_meta": {**cached["_meta"], "cached": True}}

    # 硬规则先跑，且不依赖模型：模型全挂时红色风险照常产出
    hard_alerts = hard_rule_alerts(ctx)

    results = await asyncio.gather(
        _run_isolated(summary_agent, ctx),
        _run_isolated(risk_agent, ctx, hard_alerts=hard_alerts),
        _run_isolated(diagnosis_agent, ctx),
        _run_isolated(comorbidity_agent, ctx),
        return_exceptions=True,
    )
    summary_out, risk_out, diagnosis_out, comorbidity_out = results

    degraded: list[str] = []

    def unwrap(outcome, agent_key: str, default: dict) -> dict:
        if isinstance(outcome, BaseException):
            degraded.append(agent_key)
            return default
        if outcome.degraded:
            degraded.append(agent_key)
        return outcome.data

    summary_data = unwrap(summary_out, "summary", {"overall_conclusion": {}, "treatment_effectiveness": {}})
    risk_data = unwrap(risk_out, "risk", {"risk_assessments": []})
    diagnosis_data = unwrap(diagnosis_out, "diagnosis", {"suspected_diagnoses": [], "differential_diagnosis": {}})
    comorbidity_data = unwrap(comorbidity_out, "comorbidity", {"detected": False, "conditions": []})

    risks, alerts, conflicts = merge_risks(hard_alerts, risk_data.get("risk_assessments", []))

    seeded = seed_payload(session, "assessment", patient_id)
    record_content = seed_payload(session, "record_content", patient_id)

    payload = {
        "overall_conclusion": summary_data.get("overall_conclusion") or {},
        "treatment_effectiveness": summary_data.get("treatment_effectiveness") or {},
        "risk_assessments": risks,
        "risk_alerts": alerts,
        # 推荐医嘱一期仍取种子：它属于治疗决策，需临床专家先定评测集再交给模型
        "recommended_orders": seeded.get("recommended_orders", []),
        "examinations": seed_items(session, "examination", patient_id),
        "recommended_exams": _build_recommended_exams(ctx),
        "todos": _build_todos(
            ctx,
            alerts,
            patient=patient,
            suspected=diagnosis_data.get("suspected_diagnoses", []),
            recommended_orders=seeded.get("recommended_orders", []),
            examinations=seed_items(session, "examination", patient_id),
            comorbidity=comorbidity_data,
        ),
        "dialog_script": latest_dialog(session, patient_id),
        "record_nodes": SECTION_LABELS,
        "record_content": record_content,
        "is_return_visit": patient.is_return_visit,
        "pre_consultation_done": patient.pre_consultation_done,
        "suspected_diagnoses": diagnosis_data.get("suspected_diagnoses", []),
        "differential_diagnosis": diagnosis_data.get("differential_diagnosis", {}),
        "visit_history": (patient.payload or {}).get("visit_history", []),
        "interview_assessments": {},
        "assessment_triggers": [],
        "comorbidity": comorbidity_data,
        # 种子是历史记录，审计是本次操作 —— 两段合起来才是完整的时间线
        "timeline": seed_items(session, "timeline", patient_id) + _timeline_from_audit(session, patient_id),
        # 部分就绪的显式标记，前端据此显示降级标签
        # 已处置的红色风险随聚合包带回，刷新后界面据此恢复，不用额外请求
        "handled_alerts": list((patient.payload or {}).get("handled_alerts") or []),
        "_meta": {
            "degraded_agents": degraded,
            "hard_rule_alerts": len(hard_alerts),
            "model_conflicts": conflicts,
            "cached": False,
        },
    }

    # 只缓存全部岗位都正常的结果。降级结果缓存下来会让一次偶发的
    # 网关抖动在半小时内一直显示为降级。
    if not degraded:
        cache.put(cache_key, payload)
    return payload


# action_type → 分类。取自 V4.3 的 h7 映射。
#
# 原件里 followup_reminder 声明了两次（"随访+营养科会诊" 与 "随访+康复科干预"），
# JS 取后者。这里按 JS 的实际行为落，不复刻那个笔误的写法。
TODO_CATEGORY = {
    "diagnosis_confirm": "诊断",
    "order_exam": "辅助检查",
    "treatment_plan": "处置/治疗",
    "record_confirm": "病历文书",
    "qc_review": "病历文书",
    "comorbidity_referral": "医嘱与宣教",
    "nutrition_consult": "随访+营养科会诊",
    "hospitalization_apply": "住院申请",
    "guide_sheet": "导诊单",
    "followup_reminder": "随访+康复科干预",
}

# 分类的固定展示顺序（V4.3 的 g7）。不在表内的排最后。
TODO_CATEGORY_ORDER = [
    "诊断", "辅助检查", "导诊单", "处置/治疗", "住院申请",
    "病历文书", "医嘱与宣教", "随访+营养科会诊", "随访+康复科干预", "其他",
]

# 营养筛查阳性阈值。与共病岗位的营养提醒同源，改一处两处都变。
NUTRITION_THRESHOLD = 3


# 审计动作 → 时间轴上的人话。表外的动作不进时间轴（多是内部记账）。
AUDIT_TIMELINE_LABELS = {
    "create_order": ("doctor", "开立医嘱"),
    "create_exam": ("doctor", "开立检查检验"),
    "submit_record": ("doctor", "提交病历"),
    "stash_record": ("doctor", "暂存病历"),
    "write_back_diagnosis": ("doctor", "确认并回写诊断"),
    "handle_red_alert": ("doctor", "处置红色风险"),
    "qc_review": ("doctor", "审阅质控提醒"),
    "interview_complete": ("ai", "问诊完成"),
    "request_consultation": ("doctor", "申请会诊"),
    "generate_record": ("ai", "生成病历草稿"),
    "create_referral": ("doctor", "提交转诊单"),
    "create_admission": ("doctor", "提交住院申请"),
}


def _timeline_from_audit(session: Session, patient_id: str) -> list[dict]:
    """
    把本次就诊的真实操作接进时间轴。

    此前时间轴纯粹取种子：医生开了医嘱、提交了病历，它纹丝不动 ——
    一条**不反映当前操作的时间轴**没有任何用处，只是一张装饰图。
    而这些动作在审计日志里本来就全都有，接上即可。

    表外的 action 不进时间轴：审计里还有一些内部记账，混进来只会稀释信噪比。
    """
    rows = session.scalars(
        select(AuditLog)
        .where(AuditLog.patient_id == patient_id, AuditLog.action.in_(list(AUDIT_TIMELINE_LABELS)))
        .order_by(AuditLog.id)
    ).all()
    items = []
    for row in rows:
        kind, label = AUDIT_TIMELINE_LABELS[row.action]
        detail = row.detail if isinstance(row.detail, dict) else {}
        items.append({
            "time": row.created_at.strftime("%H:%M"),
            "type": kind,
            "action": label,
            "detail": _audit_detail_text(row.action, detail),
            # 标出来源，界面上可以区分「今天做的」与「历史记录」
            "source": "audit",
        })
    return items


def _audit_detail_text(action: str, detail: dict) -> str:
    """把审计详情写成一句人看得懂的话，而不是把 JSON 贴上去。"""
    if action == "create_order":
        return f"{detail.get('drug', '')} {detail.get('dose', '')} {detail.get('freq', '')}".strip()
    if action == "create_exam":
        return f"{detail.get('name', '')}（{detail.get('type', '')}）"
    if action in {"submit_record", "stash_record"}:
        return f"共 {len(detail.get('fields') or [])} 段"
    if action == "write_back_diagnosis":
        return f"主诊断：{detail.get('primary', '—')}"
    if action == "handle_red_alert":
        return str(detail.get("name") or "")
    if action == "qc_review":
        return f"当时尚有 {detail.get('gap_count', 0)} 处遗漏"
    return ""


def _build_recommended_exams(ctx: dict) -> list[dict]:
    """
    推荐复查项：每一条异常检验对应一条。

    以前这个列表是从 todos 里 `type === 'exam'` 过滤出来的 —— 待办清单兼职当
    推荐列表，两者的形状一改就互相拖累（这次改处置单就直接把它编译崩了）。
    拆成独立字段，各归各位。
    """
    exams: list[dict] = []
    for lab in ctx.get("lab_results", []):
        if not isinstance(lab, dict) or not lab.get("abnormal"):
            continue
        exams.append({
            "id": f"rec-{lab.get('name')}",
            "name": f"{lab.get('name')}复查",
            "type": "检验",
            "basis": f"当前 {lab.get('value')}{lab.get('unit', '')}，参考 {lab.get('ref', '—')}",
        })
    return exams


def _build_todos(
    ctx: dict,
    alerts: list[dict],
    *,
    patient,
    suspected: list[dict],
    recommended_orders: list[dict],
    examinations: list[dict],
    comorbidity: dict,
) -> list[dict]:
    """
    AI 处置单。

    形状对齐 V4.3：`{id, text, priority, source, done, action_type, category}`。
    每一条都由**确定性规则**生成，且**必须有真实依据才出现** —— 凭空列一堆待办
    比不列更糟：医生会先学会忽略它，真正要紧的那条也跟着被忽略。

    `done` 一律为 False：本项目不替医生判断某件事做完了没有。
    """
    todos: list[dict] = []

    def add(action_type: str, text: str, *, priority: str, source: str) -> None:
        todos.append({
            "id": f"t_{action_type}_{len(todos)}",
            "text": text,
            "priority": priority,
            "source": source,
            "done": False,
            "action_type": action_type,
            "category": TODO_CATEGORY.get(action_type, "其他"),
        })

    # 危急值优先：红色预警逐条列出，医生必须逐条处置
    for alert in alerts:
        add("qc_review", f"{alert['name']}：{alert['summary']}", priority="高", source="预警评估")

    if suspected:
        names = "、".join(d.get("name", "") for d in suspected[:3] if d.get("name"))
        add(
            "diagnosis_confirm",
            f"待确认诊断 {len(suspected)} 条（{names}{'…' if len(suspected) > 3 else ''}），勾选后回写 HIS",
            priority="高",
            source="诊断智能体",
        )

    abnormal_labs = [l for l in ctx.get("lab_results", []) if isinstance(l, dict) and l.get("abnormal")]
    if abnormal_labs:
        names = "、".join(str(l.get("name")) for l in abnormal_labs[:3])
        add(
            "order_exam",
            f"{len(abnormal_labs)} 项检验异常需复查（{names}{'…' if len(abnormal_labs) > 3 else ''}）",
            priority="中",
            source="检验结果",
        )

    if recommended_orders:
        add(
            "treatment_plan",
            f"AI 推荐医嘱 {len(recommended_orders)} 条待医生审核后开立",
            priority="中",
            source="智慧诊疗",
        )

    if examinations:
        add("guide_sheet", f"{len(examinations)} 项检查检验需生成注意事项与导诊单", priority="低", source="医嘱管理")

    if comorbidity.get("detected") and comorbidity.get("conditions"):
        count = len(comorbidity["conditions"])
        add(
            "comorbidity_referral",
            f"多病共存（{count} 种慢性病），建议转诊至多病共存管理门诊",
            priority="高",
            source="共病管理",
        )

    score = getattr(patient, "nutrition_screening_score", 0) or 0
    if score > NUTRITION_THRESHOLD:
        add(
            "nutrition_consult",
            f"营养筛查评分 {score}（阈值 {NUTRITION_THRESHOLD}），申请营养科会诊",
            priority="中",
            source="共病管理",
        )

    add("record_confirm", "AI 病历草稿待审核后写入 HIS", priority="中", source="病历生成")

    return todos


# ------------------------------------------------------------------ SSE：对话与病历


class ChatIn(StrictIn):
    patient_id: str
    messages: list[dict] = Field(default_factory=list)
    generate_record: bool = False
    # 界面「智能笔记」里医生随手记的要点，生成病历时一并参考
    note_text: str = ""


@router.post("/copilot/chat")
async def copilot_chat(body: ChatIn, session: Session = Depends(get_session)) -> StreamingResponse:
    patient = _patient_or_404(session, body.patient_id)
    ctx = build_context(session, patient, include_dialog=True)

    if body.generate_record:
        return StreamingResponse(_stream_record(ctx, body.patient_id, body.note_text), headers=SSE_HEADERS)
    return StreamingResponse(_stream_chat(ctx, body.messages), headers=SSE_HEADERS)


async def _stream_chat(ctx: dict, messages: list[dict]) -> AsyncIterator[str]:
    """普通问答：真流式转发 token。"""
    client = get_llm_client()
    if not client.configured:
        yield _sse({"type": "token", "token": "模型通道未配置，无法回答。请检查 AI_API_KEY 后重试。"})
        return

    system = (
        "你是门诊医生的临床助手。基于给定的患者上下文回答医生的问题。\n"
        "只使用上下文中出现的事实，没有依据就说明「上下文中未获得该信息」。\n"
        "不下诊断、不开处方。回答简洁，控制在 200 字以内。"
    )
    payload = [
        ChatMessage("system", f"{system}\n\n【患者上下文】\n{json.dumps(ctx, ensure_ascii=False)}"),
    ]
    for message in messages[-10:]:
        role = message.get("role") or "user"
        content = str(message.get("content") or "")
        if content:
            payload.append(ChatMessage("assistant" if role == "assistant" else "user", content))

    try:
        async for piece in client.stream_text(payload, agent_key="summary"):
            yield _sse({"type": "token", "token": piece})
    except LlmError as exc:
        # 失败时给出可读信息，不做静默空流 —— 前端的本地兜底只应用于极端情况
        yield _sse({"type": "token", "token": f"（模型暂时不可用：{exc}）"})


async def _stream_record(ctx: dict, patient_id: str, note_text: str = "") -> AsyncIterator[str]:
    """
    病历生成：结构化流。

    先让模型一次性产出七段 JSON，服务端再按段切分下发。
    不把模型自由文本直接透传 —— 那样 node_id 无法保证落在七段枚举内。
    """
    session = SessionLocal()
    try:
        outcome = await record_agent.run(session, ctx, note_text=note_text)
        fields = outcome.data.get("fields", {})

        version = 1 + (
            session.scalar(
                select(RecordDraft.version)
                .where(RecordDraft.patient_id == patient_id)
                .order_by(RecordDraft.version.desc())
                .limit(1)
            )
            or 0
        )
        session.add(
            RecordDraft(
                patient_id=patient_id,
                version=version,
                fields=fields,
                provenance={"agent": record_agent.key, "provider": outcome.provider},
                provider=outcome.provider,
            )
        )
        record_audit(
            session,
            action="generate_record",
            entity="record_draft",
            entity_id=str(version),
            patient_id=patient_id,
            detail={"provider": outcome.provider, "degraded": outcome.degraded},
        )
        session.commit()
    finally:
        session.close()

    for key in SECTION_KEYS:
        text = fields.get(key, "")
        yield _sse({"type": "record_node_start", "node_id": key})
        # 按小片下发而非整段，让前端有真实的逐字渲染效果
        for index in range(0, len(text), 6):
            yield _sse({"type": "record_token", "node_id": key, "token": text[index : index + 6]})
            await asyncio.sleep(0.012)
        yield _sse({"type": "record_node_done"})

    yield _sse(
        {
            "type": "record_done",
            "fields": fields,
            "version": version,
            "provider": outcome.provider,
            "degraded": outcome.degraded,
        }
    )


# ------------------------------------------------------------------ 病历：非流式


class RecordAutoIn(StrictIn):
    patient_id: str
    note_text: str = ""
    dialog: list = Field(default_factory=list)
    labs: list = Field(default_factory=list)


class RecordFieldIn(StrictIn):
    patient_id: str
    field: str
    note_text: str = ""


@router.post("/generate-record-auto")
async def generate_record_auto(body: RecordAutoIn, session: Session = Depends(get_session)) -> dict:
    patient = _patient_or_404(session, body.patient_id)
    ctx = build_context(session, patient, include_dialog=True)
    outcome = await _run_isolated(record_agent, ctx, note_text=body.note_text)
    return {"fields": outcome.data.get("fields", {}), "provider": outcome.provider, "degraded": outcome.degraded}


@router.post("/generate-record-field")
async def generate_record_field(body: RecordFieldIn, session: Session = Depends(get_session)) -> dict:
    if body.field not in SECTION_KEYS:
        raise HTTPException(status_code=400, detail=f"非法病历段落：{body.field}")
    patient = _patient_or_404(session, body.patient_id)
    ctx = build_context(session, patient, include_dialog=True)
    outcome = await _run_isolated(record_field_agent, ctx, field=body.field, note_text=body.note_text)
    return {
        "field": body.field,
        "generated_text": outcome.data.get("generated_text", ""),
        "provider": outcome.provider,
        "degraded": outcome.degraded,
    }


# ------------------------------------------------------------------ 病历质控


class RecordQualityIn(StrictIn):
    patient_id: str
    fields: dict[str, str] = Field(default_factory=dict)


@router.post("/record/quality")
def record_quality(body: RecordQualityIn, session: Session = Depends(get_session)) -> dict:
    """
    病历质控与完整性。四项指标全部由确定性规则算，不交给模型 ——
    让模型给自己的输出打分，分数只会好看，不会有用。

    其中「用语规范性」检查的是未经问诊的否定表述，兼作 F03 红线的运行时监控。
    """
    patient = _patient_or_404(session, body.patient_id)
    dialog = latest_dialog(session, patient.id)
    dialog_text = "".join(str(turn.get("text") or "") for turn in dialog if isinstance(turn, dict))
    return evaluate(body.fields, dialog_text=dialog_text)


# ------------------------------------------------------------------ 问诊


class InterviewCompleteIn(StrictIn):
    patient_id: str
    conversation_summary: str = ""
    messages: list = Field(default_factory=list)


@router.get("/interview/init/{patient_id}")
async def interview_init(patient_id: str, session: Session = Depends(get_session)) -> dict:
    """
    问诊开场包。一次返回播放一整场问诊所需的全部内容。

    **不再调模型**（2026-09-02）。原先这里会跑 `interview_agent` 生成
    「AI 追问提示」与「补充观察」两份清单 —— 那两块一期已撤（没有临床知识库
    支撑时，建议错一条的代价大于不给建议），产出没有任何消费方。

    留着那次调用等于每点一次「开始问诊」就白花 7.3 秒和一次真实模型费用，
    换来一份直接丢掉的输出。所以整个拿掉，这个接口现在是纯数据组装。

    `questions` / `observations` 两个字段仍在返回体里，恒为空数组：
    前端已经不消费它们，保留字段只是为了老前端拿到的形状不变。
    等临床知识库就位、这个功能重新开启时，把 agent 调用加回来即可。
    """
    patient = _patient_or_404(session, patient_id)

    payload = patient.payload or {}
    return {
        "greeting": f"{patient.name}您好，我是{patient.doctor}。今天主要是哪里不舒服？",
        "patient_name": patient.name,
        "chief_complaint": patient.chief_complaint,
        "diagnoses": payload.get("diagnoses") or [],
        # 演示对话脚本，供前端逐条播放
        "dialog": seed_items(session, "dialog_script", patient_id),
        "questions": [],
        "observations": [],
        "provider": "none",
        "degraded": False,
    }


@router.post("/interview/complete")
async def interview_complete(body: InterviewCompleteIn, session: Session = Depends(get_session)) -> dict:
    patient = _patient_or_404(session, body.patient_id)
    ctx = build_context(session, patient)
    outcome = await _run_isolated(interview_agent, ctx, conversation_summary=body.conversation_summary)

    record = InterviewSession(
        id=next_id(session, InterviewSession, "V"),
        patient_id=body.patient_id,
        summary=outcome.data.get("summary", ""),
        messages=body.messages,
        analysis=outcome.data,
    )
    session.add(record)
    record_audit(
        session,
        action="interview_complete",
        entity="interview_session",
        entity_id=record.id,
        patient_id=body.patient_id,
        detail={"provider": outcome.provider, "turns": len(body.messages)},
    )
    # 问诊结束即解锁分析。这是主路径 —— 跳过是例外，不是常态。
    _unlock_analysis(session, patient, "interview")
    session.commit()

    return {
        "ok": True,
        "session_id": record.id,
        "analysis_summary": outcome.data.get("summary", ""),
        "analysis_chief_complaint": outcome.data.get("chief_complaint", ""),
        "analysis_key_points": outcome.data.get("key_points", []),
        "analysis_gaps": outcome.data.get("gaps", []),
        "provider": outcome.provider,
        "degraded": outcome.degraded,
    }


@router.get("/interview/history/{patient_id}")
def interview_history(patient_id: str, session: Session = Depends(get_session)) -> dict:
    _patient_or_404(session, patient_id)
    sessions = session.scalars(
        select(InterviewSession).where(InterviewSession.patient_id == patient_id).order_by(InterviewSession.ended_at.desc())
    ).all()
    return {
        "patient_id": patient_id,
        "sessions": [
            {"ended_at": s.ended_at.isoformat(), "summary": s.summary, "messages": s.messages} for s in sessions
        ],
    }


# ------------------------------------------------------------------ 诊断回写


class DiagnosisWriteBackIn(StrictIn):
    patient_id: str
    diagnoses: list[str] = Field(default_factory=list)
    primary: str = ""
    # 医生已处置的红色风险 id。服务端据此二次校验，不信任前端的按钮禁用状态。
    handled_alerts: list[str] = Field(default_factory=list)


def _assert_red_alerts_closed(session: Session, patient, handled: list[str], *, action: str) -> None:
    """
    红色风险闭环校验。**服务端再校验一次**，前端禁用按钮只是体验。

    抽成函数是因为提交病历与回写诊断都要用它 —— 各写一份的话，
    哪天规则改了必然漏掉一处，而漏掉的那处就是一个能绕过红线的入口。
    """
    # 分析还没生成过就不能写回。
    #
    # 改成问诊状态机之后这里差点漏出一个洞：锁着的时候模型红线还不存在，
    # 而种子病例又不命中硬规则，于是 open_red 为空、门禁放行 —— 医生可以在
    # 从没跑过风险分析的情况下提交病历。改之前一进来就跑分析，红线总是在的；
    # 把加载时机往后挪，就必须把这一条补上，否则等于把门禁的分母改小了。
    state = _visit_state(session, patient)
    if not state["analysis_unlocked"]:
        event("redline_blocked", patient=patient.id, action=action, reason="analysis_not_generated")
        raise HTTPException(
            status_code=409,
            detail=f"本次就诊尚未生成 AI 分析，风险未经评估，已阻断{action}。请先完成问诊，或选择「跳过问诊，直接分析」。",
        )

    ctx = build_context(session, patient)
    hard = hard_rule_alerts(ctx)
    cached = cache.get(cache.context_key(patient.id, build_context(session, patient, include_dialog=True, seed_dialog_fallback=False)))
    model_alerts = (cached or {}).get("risk_alerts", [])
    # 两边都按 level 筛。
    #
    # 原来这里是 `{a["id"] for a in hard}` —— 不看 level，默认「硬规则出的都是红的」。
    # 那在当时成立（硬规则只有过敏冲突、危急值、生命体征越界三条，全是高风险），
    # 但它把一个**巧合**当成了不变量：2026-09-03 加了「阳性检查结论」这条中风险
    # 硬规则，提交立刻被拦，七个测试一起红 —— 而拦的是「心电图异常」这种
    # 需要记录、不需要阻断就诊的项。零容忍门禁一旦拦错东西，医生下一步就是
    # 想办法绕过它，那时真正该拦的也拦不住了。判据只能是 level，不能是来源。
    is_red = lambda a: a.get("level") == "高风险"
    all_red = {a["id"] for a in hard if is_red(a)} | {a["id"] for a in model_alerts if is_red(a)}
    open_red = sorted(all_red - set(handled or []))
    if open_red:
        # 红线拦截必须留日志：这是零容忍门禁真正生效的证据。
        # 只有审计没有日志的话，「那次到底拦没拦住」得翻库才知道。
        event("redline_blocked", patient=patient.id, action=action,
              open_count=len(open_red), open_ids="|".join(open_red),
              hard_rules=len(hard), model_alerts=len(model_alerts))
        raise HTTPException(status_code=409, detail=f"尚有 {len(open_red)} 条红色风险未处置，已阻断{action}")
    event("redline_passed", patient=patient.id, action=action, handled=len(handled or []))


class AlertHandleIn(StrictIn):
    patient_id: str
    alert_id: str
    alert_name: str = ""
    note: str = ""


@router.post("/alerts/handle")
def handle_alert(body: AlertHandleIn, session: Session = Depends(get_session)) -> dict:
    """
    记录一次红色风险处置。

    此前这个动作只改前端内存，而确认按钮上写着「已处置并**留痕**」——
    留痕是没有的，刷新也就没了。红色风险处置又门控着病历提交，
    于是医生刷新一次页面，得把所有红线重新处置一遍。

    落在患者主档上（而不是只留审计），是因为**下次打开要能恢复**：
    审计是给事后查的，恢复现场需要能读回来的状态。
    """
    patient = _patient_or_404(session, body.patient_id)
    payload = patient.payload or {}
    handled = list(payload.get("handled_alerts") or [])
    if body.alert_id not in handled:
        handled.append(body.alert_id)
    payload["handled_alerts"] = handled
    patient.payload = payload
    flag_modified(patient, "payload")

    record_audit(
        session, action="handle_red_alert", entity="risk_alert", entity_id=body.alert_id,
        patient_id=patient.id, detail={"name": body.alert_name, "note": body.note},
    )
    session.commit()
    return {"ok": True, "handled_alerts": handled, "message": f"已记录「{body.alert_name or body.alert_id}」的处置"}


class QcReviewIn(StrictIn):
    patient_id: str
    gap_count: int = 0


@router.post("/record/qc-review")
def qc_review(body: QcReviewIn, session: Session = Depends(get_session)) -> dict:
    """
    记录一次质控审阅。

    审阅**不清除遗漏** —— 它只表示医生看过。留痕的意义在于：
    事后能查到「这些遗漏在提交前被谁、在什么时候看过」。
    此前这句「已记录本次质控审阅」同样只是前端的一个 ref。
    """
    patient = _patient_or_404(session, body.patient_id)
    record_audit(
        session, action="qc_review", entity="record_quality", entity_id=patient.id,
        patient_id=patient.id, detail={"gap_count": body.gap_count},
    )
    session.commit()
    return {"ok": True, "message": "已记录本次质控审阅，遗漏仍保留在清单中"}


class RecordSaveIn(StrictIn):
    patient_id: str
    fields: dict = Field(default_factory=dict)
    handled_alerts: list[str] = Field(default_factory=list)


@router.post("/record/stash")
def stash_record(body: RecordSaveIn, session: Session = Depends(get_session)) -> dict:
    """
    暂存病历。

    暂存**不过红线门禁** —— 它的用途正是「还没弄完，先存着」，
    拿门禁拦住暂存，等于逼医生要么一次做完要么丢掉已写的内容。
    暂存不改患者主档，只落草稿。
    """
    patient = _patient_or_404(session, body.patient_id)
    version = _next_draft_version(session, patient.id)
    session.add(RecordDraft(patient_id=patient.id, version=version, fields=body.fields, provider="doctor-stash"))
    record_audit(
        session, action="stash_record", entity="record_draft", entity_id=str(version),
        patient_id=patient.id, detail={"fields": sorted(body.fields.keys())},
    )
    session.commit()
    return {"ok": True, "version": version, "message": "已暂存（未提交）"}


@router.post("/record/submit")
def submit_record(body: RecordSaveIn, session: Session = Depends(get_session)) -> dict:
    """
    提交病历：落库 + 留审计 + 写回患者主档。

    此前界面上这个按钮只弹一句「病历已提交（写入本地库并留审计）」，
    **实际什么都没写** —— 医生以为存下了，刷新就没了。伪造的成功文案
    是零容忍红线里最不该出现的一种，因为它让人对系统建立错误的信任。
    """
    patient = _patient_or_404(session, body.patient_id)
    if not str(body.fields.get("chief_complaint") or "").strip():
        raise HTTPException(status_code=400, detail="主诉不能为空")
    _assert_red_alerts_closed(session, patient, body.handled_alerts, action="提交")

    version = _next_draft_version(session, patient.id)
    session.add(RecordDraft(patient_id=patient.id, version=version, fields=body.fields, provider="doctor-submitted"))

    payload = patient.payload or {}
    payload["submitted_record"] = {"version": version, "fields": body.fields}
    patient.payload = payload
    flag_modified(patient, "payload")

    # 提交 = 本次就诊完成，患者出候诊队列。
    #
    # 此前没有任何地方会把 in_queue 置 false —— 于是「今日候诊 6 人」永远是 6，
    # 医生看完全部患者，队列纹丝不动。一次就诊没有「结束」，这个系统就只是个查看器。
    # 暂存不出队（它的语义就是没弄完）；误点后可在患者管理里「重新接诊」。
    patient.in_queue = False

    record_audit(
        session, action="submit_record", entity="record_draft", entity_id=str(version),
        patient_id=patient.id, detail={"fields": sorted(body.fields.keys()), "handled_alerts": body.handled_alerts},
    )
    session.commit()
    cache.clear()
    return {
        "ok": True, "version": version, "dequeued": True,
        "message": "病历已提交，本次就诊完成（本地库 + 审计，未触达真实 HIS）",
    }


@router.get("/record/{patient_id}")
def get_record(patient_id: str, session: Session = Depends(get_session)) -> dict:
    """
    读回该患者最近一次暂存/提交的病历。

    没有这个接口，刷新页面医生就得从头再来一遍 —— 那不叫系统，叫演示。
    """
    patient = _patient_or_404(session, patient_id)
    latest = session.scalars(
        select(RecordDraft).where(RecordDraft.patient_id == patient_id).order_by(RecordDraft.version.desc()).limit(1)
    ).first()
    submitted = (patient.payload or {}).get("submitted_record")
    return {
        "patient_id": patient_id,
        "latest": None if latest is None else {
            "version": latest.version, "fields": latest.fields,
            "provider": latest.provider, "created_at": latest.created_at.isoformat(),
        },
        "submitted": submitted,
    }


def _next_draft_version(session: Session, patient_id: str) -> int:
    current = session.scalar(
        select(func.max(RecordDraft.version)).where(RecordDraft.patient_id == patient_id)
    )
    return int(current or 0) + 1


@router.post("/diagnosis/write-back")
async def diagnosis_write_back(body: DiagnosisWriteBackIn, session: Session = Depends(get_session)) -> dict:
    """
    确认并回写诊断。一期落本地库并留审计，不触达真实 HIS。

    门禁在服务端**再校验一次**：前端的按钮禁用只是体验，绕过它（改 DOM、直接
    发请求）不能让未闭环的红色风险溜过去。这是零容忍门禁里「未确认写回」那一条。
    """
    patient = _patient_or_404(session, body.patient_id)

    if not body.diagnoses:
        raise HTTPException(status_code=400, detail="未选择任何诊断")
    if not body.primary:
        raise HTTPException(status_code=400, detail="必须指定一个主诊断")
    if body.primary not in body.diagnoses:
        raise HTTPException(status_code=400, detail="主诊断必须在已选诊断中")

    _assert_red_alerts_closed(session, patient, body.handled_alerts, action="回写")

    payload = patient.payload or {}
    payload["diagnoses"] = [
        {"name": name, "primary": name == body.primary, "source": "ai-confirmed"} for name in body.diagnoses
    ]
    patient.payload = payload
    # JSON 列整体替换，SQLAlchemy 不会自动感知内部改动
    flag_modified(patient, "payload")

    record_audit(
        session,
        action="write_back_diagnosis",
        entity="patient",
        entity_id=patient.id,
        patient_id=patient.id,
        detail={"diagnoses": body.diagnoses, "primary": body.primary, "handled_alerts": body.handled_alerts},
    )
    session.commit()
    # 诊断变了，聚合缓存里的上下文哈希随之失效，这里显式清一次更直观
    cache.clear()

    return {"ok": True, "message": "诊断已回写（本地库 + 审计）", "diagnoses": payload["diagnoses"]}


# ------------------------------------------------------------------ 共病


class ComorbidityIn(StrictIn):
    patient_id: str


class ConsultationIn(StrictIn):
    patient_id: str
    focus_nutrition: bool = False


@router.post("/comorbidity/check")
async def comorbidity_check(body: ComorbidityIn, session: Session = Depends(get_session)) -> dict:
    patient = _patient_or_404(session, body.patient_id)
    ctx = build_context(session, patient)
    outcome = await _run_isolated(comorbidity_agent, ctx)
    return {"ok": True, "comorbidity": outcome.data, "provider": outcome.provider, "degraded": outcome.degraded}


@router.post("/comorbidity/consultation")
def comorbidity_consultation(body: ConsultationIn, session: Session = Depends(get_session)) -> dict:
    patient = _patient_or_404(session, body.patient_id)
    dept = "营养科" if body.focus_nutrition else "全科医学科"
    reason = (
        f"营养筛查评分 {patient.nutrition_screening_score} 分，存在营养风险"
        if body.focus_nutrition
        else "共病协同管理会诊"
    )

    referral = Referral(
        id=next_id(session, Referral, "T"),
        patient_id=body.patient_id,
        target_dept=dept,
        reason=reason,
        payload={"focus_nutrition": body.focus_nutrition},
    )
    session.add(referral)
    record_audit(
        session,
        action="request_consultation",
        entity="referral",
        entity_id=referral.id,
        patient_id=body.patient_id,
        detail={"target_dept": dept, "reason": reason},
    )
    session.commit()

    return {"ok": True, "message": f"{dept}会诊申请已提交", "referral": {"id": referral.id, "target_dept": dept, "reason": reason}}
