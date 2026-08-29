"""
AI 面。聚合读取 + 两路 SSE + 其余 AI 端点。

`report-summary` 是工作站打开患者后的主加载请求，前端几乎所有 AI 区块
都由它一次喂饱。它是多个 Agent 结果的合流出口，因此**必须支持部分就绪**：
某个岗位失败时该字段给降级值，不能让整个请求失败。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
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
    voice_coverage_agent,
    voice_plan_agent,
    voice_summary_agent,
)
from .. import cache
from ..agents.context import build_context, seed_items, seed_payload
from ..audit import next_id, record_audit
from ..database import SessionLocal, get_session
from ..llm import ChatMessage, LlmError, get_llm_client
from ..models import Patient, RecordDraft, Referral, VoiceSession

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


# ------------------------------------------------------------------ 聚合读取


@router.get("/report-summary/{patient_id}")
async def report_summary(
    patient_id: str,
    refresh: bool = False,
    session: Session = Depends(get_session),
) -> dict:
    patient = _patient_or_404(session, patient_id)
    ctx = build_context(session, patient, include_dialog=True)

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
        "todos": _build_todos(ctx, alerts),
        "dialog_script": seed_items(session, "dialog_script", patient_id),
        "record_nodes": SECTION_LABELS,
        "record_content": record_content,
        "is_return_visit": patient.is_return_visit,
        "pre_consultation_done": patient.pre_consultation_done,
        "suspected_diagnoses": diagnosis_data.get("suspected_diagnoses", []),
        "differential_diagnosis": diagnosis_data.get("differential_diagnosis", {}),
        "visit_history": (patient.payload or {}).get("visit_history", []),
        "voice_assessments": {},
        "assessment_triggers": [],
        "comorbidity": comorbidity_data,
        "timeline": seed_items(session, "timeline", patient_id),
        # 部分就绪的显式标记，前端据此显示降级标签
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


def _build_todos(ctx: dict, alerts: list[dict]) -> list[dict]:
    """待办由确定性规则生成，类型取 V4.3 定义的枚举。"""
    todos: list[dict] = []
    for alert in alerts:
        todos.append({"type": "critical_lab", "title": alert["name"], "detail": alert["summary"], "level": "danger"})
    for lab in ctx.get("lab_results", []):
        if isinstance(lab, dict) and lab.get("abnormal"):
            todos.append(
                {
                    "type": "exam",
                    "title": f"{lab.get('name')}复查",
                    "detail": f"当前 {lab.get('value')}{lab.get('unit', '')}，参考 {lab.get('ref', '—')}",
                    "level": "warning",
                }
            )
    return todos[:8]


# ------------------------------------------------------------------ SSE：对话与病历


class ChatIn(BaseModel):
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


class RecordAutoIn(BaseModel):
    patient_id: str
    note_text: str = ""
    dialog: list = Field(default_factory=list)
    labs: list = Field(default_factory=list)


class RecordFieldIn(BaseModel):
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


# ------------------------------------------------------------------ 语音问诊


class VoiceTurnIn(BaseModel):
    patient_id: str
    patient_text: str = ""
    turn_index: int = 0
    conversation_history: list = Field(default_factory=list)


class VoiceCompleteIn(BaseModel):
    patient_id: str
    conversation_summary: str = ""
    messages: list = Field(default_factory=list)


@router.get("/voice/init/{patient_id}")
async def voice_init(patient_id: str, session: Session = Depends(get_session)) -> dict:
    """
    问诊开场包。一次返回播放一整场问诊所需的全部内容。

    对齐 V4.3：点「语音问诊」后由前端按脚本自动播放对话，
    播放过程中对照 questions 逐条划掉、按需展开 observations。
    脚本是演示数据；questions 与 observations 是真实模型输出。
    """
    patient = _patient_or_404(session, patient_id)
    ctx = build_context(session, patient)
    outcome = await _run_isolated(voice_plan_agent, ctx)

    payload = patient.payload or {}
    return {
        "greeting": f"{patient.name}您好，我是{patient.doctor}。今天主要是哪里不舒服？",
        "patient_name": patient.name,
        "chief_complaint": patient.chief_complaint,
        "diagnoses": payload.get("diagnoses") or [],
        # 演示对话脚本，供前端逐条播放
        "dialog": seed_items(session, "dialog_script", patient_id),
        "questions": outcome.data.get("questions", []),
        "observations": outcome.data.get("observations", []),
        "provider": outcome.provider,
        "degraded": outcome.degraded,
    }


@router.post("/voice/turn")
async def voice_turn(body: VoiceTurnIn, session: Session = Depends(get_session)) -> StreamingResponse:
    patient = _patient_or_404(session, body.patient_id)
    ctx = build_context(session, patient)
    return StreamingResponse(
        _stream_voice_turn(
            ctx,
            patient_text=body.patient_text,
            turn_index=body.turn_index,
            conversation_history=body.conversation_history,
        ),
        headers=SSE_HEADERS,
    )


async def _stream_voice_turn(ctx: dict, **kwargs) -> AsyncIterator[str]:
    """
    手动补问路径：医生自己输入患者所述时，给出下一句追问建议。

    主流程（脚本播放）不经过这里 —— 那条路的追问清单在 voice/init 一次拿全。
    这个端点保留给「播放结束后医生继续追问」和无脚本患者的情形。
    """
    outcome = await _run_isolated(voice_plan_agent, ctx)
    questions = outcome.data.get("questions") or []
    asked = {str(m.get("text") or "") for m in (kwargs.get("conversation_history") or []) if isinstance(m, dict)}
    remaining = [q for q in questions if q not in asked]
    prompt = remaining[0] if remaining else "还有其他不舒服的地方吗？"

    for index in range(0, len(prompt), 3):
        yield _sse({"type": "prompt_token", "token": prompt[index : index + 3]})
        await asyncio.sleep(0.02)

    yield _sse(
        {
            "type": "prompt_done",
            "observations": outcome.data.get("observations", []),
            "turn_index": int(kwargs.get("turn_index") or 0) + 1,
            "provider": outcome.provider,
            "degraded": outcome.degraded,
        }
    )


class VoiceCoverageIn(BaseModel):
    patient_id: str
    # 只发还开着的问题：已覆盖的判定是单调的，不会回退，重复发只是浪费 token
    open_questions: list[str] = Field(default_factory=list)
    transcript: list[dict] = Field(default_factory=list)


@router.post("/voice/coverage")
async def voice_coverage(body: VoiceCoverageIn, session: Session = Depends(get_session)) -> dict:
    """
    判定追问清单里哪些问题已在对话中得到回答。

    单独开一个端点而不并进 voice/turn：两者节奏不同 —— 「建议下一句问什么」
    是每轮一次，「判定覆盖」是在对话停顿处批量做。混在一起会互相拖累。

    调用方按需异步调用，界面不阻塞在它上面。
    """
    patient = _patient_or_404(session, body.patient_id)
    if not body.open_questions:
        return {"covered": [], "provider": "none", "degraded": False}

    ctx = build_context(session, patient)
    outcome = await _run_isolated(
        voice_coverage_agent, ctx, questions=body.open_questions, transcript=body.transcript
    )
    # 序号越界的一律丢弃，避免模型幻觉出不存在的条目
    covered = [c for c in outcome.data.get("covered", []) if 1 <= c["index"] <= len(body.open_questions)]
    return {"covered": covered, "provider": outcome.provider, "degraded": outcome.degraded}


@router.post("/voice/complete")
async def voice_complete(body: VoiceCompleteIn, session: Session = Depends(get_session)) -> dict:
    patient = _patient_or_404(session, body.patient_id)
    ctx = build_context(session, patient)
    outcome = await _run_isolated(voice_summary_agent, ctx, conversation_summary=body.conversation_summary)

    record = VoiceSession(
        id=next_id(session, VoiceSession, "V"),
        patient_id=body.patient_id,
        summary=outcome.data.get("summary", ""),
        messages=body.messages,
        analysis=outcome.data,
    )
    session.add(record)
    record_audit(
        session,
        action="voice_complete",
        entity="voice_session",
        entity_id=record.id,
        patient_id=body.patient_id,
        detail={"provider": outcome.provider, "turns": len(body.messages)},
    )
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


@router.get("/voice/history/{patient_id}")
def voice_history(patient_id: str, session: Session = Depends(get_session)) -> dict:
    _patient_or_404(session, patient_id)
    sessions = session.scalars(
        select(VoiceSession).where(VoiceSession.patient_id == patient_id).order_by(VoiceSession.ended_at.desc())
    ).all()
    return {
        "patient_id": patient_id,
        "sessions": [
            {"ended_at": s.ended_at.isoformat(), "summary": s.summary, "messages": s.messages} for s in sessions
        ],
    }


# ------------------------------------------------------------------ 诊断回写


class DiagnosisWriteBackIn(BaseModel):
    patient_id: str
    diagnoses: list[str] = Field(default_factory=list)
    primary: str = ""
    # 医生已处置的红色风险 id。服务端据此二次校验，不信任前端的按钮禁用状态。
    handled_alerts: list[str] = Field(default_factory=list)


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

    # 红色风险闭环校验：拿当前聚合结果里的红色项与医生已处置列表比对
    ctx = build_context(session, patient)
    hard_alerts = hard_rule_alerts(ctx)
    cached = cache.get(cache.context_key(body.patient_id, build_context(session, patient, include_dialog=True)))
    model_alerts = (cached or {}).get("risk_alerts", [])
    all_red = {a["id"] for a in hard_alerts} | {a["id"] for a in model_alerts if a.get("level") == "高风险"}
    open_red = sorted(all_red - set(body.handled_alerts))
    if open_red:
        raise HTTPException(status_code=409, detail=f"尚有 {len(open_red)} 条红色风险未处置，已阻断回写")

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


class ComorbidityIn(BaseModel):
    patient_id: str


class ConsultationIn(BaseModel):
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
