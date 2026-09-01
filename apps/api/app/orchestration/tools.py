"""临床工具层：Worker 通过 Toolkit 调用的函数。

**这些是进程内 Python 函数，不是 MCP 工具** —— 一期没有真实 HIS 接口。
数据来源分三种，每个工具的 docstring 里都标了：

- **真实**：本地 SQLite + 种子档案（虚构病例，但结构与真实 HIS 一致）
- **规则**：纯代码判定，不调模型（硬规则风险扫描）
- **Mock**：暂无接口，返回固定的闭集字典（科室树）

等 HIS 的 MCP server 就位，同名工具从 SKILL.md 的 `tools` 迁到 `mcp-tools`，
skill 正文一个字不用改 —— 这是当初把两个字段都认下来的原因。

## 三条硬约束

1. **工具只读，不写。** 一期的写入（医嘱、转诊、住院、病历）一律走产品路径的
   显式确认，不给 Agent 自主写入的能力。Agent 能改病历 = 未确认写回，那是零容忍红线。
2. **返回结构化数据，不返回自然语言。** 措辞是 skill 的事；工具只负责事实。
3. **查不到就如实说查不到，不编。** 返回 `{"found": false, ...}` 而不是空壳，
   让模型能区分「没有这项检查」和「这项检查全正常」。
"""

from __future__ import annotations

import json
from typing import Any

from agentscope.tool import ToolResponse

from ..agents.context import build_context, latest_dialog, seed_items
from ..agents.risk import hard_rule_alerts
from ..database import SessionLocal
from ..models import Patient
from ..obs import event

# 科室闭集。**Mock**：一期没有接 HIS 的科室树接口，用这份字典兜住 ——
# 关键是它必须是**闭集**，模型只能从里面挑，不能自己造一个科室出来。
DEPARTMENTS: tuple[str, ...] = (
    "内分泌科", "心内科", "神经内科", "肾内科", "消化内科", "呼吸内科",
    "血液科", "风湿免疫科", "普外科", "骨科", "妇科", "眼科",
    "营养科", "康复科", "精神心理科", "全科医学科",
)


def _ok(payload: Any) -> ToolResponse:
    """统一出参：单个 JSON 文本块。模型侧解析简单，日志侧也好读。"""
    from agentscope.message import TextBlock

    return ToolResponse(content=[TextBlock(type="text", text=json.dumps(payload, ensure_ascii=False))])


def _patient(session, patient_id: str) -> Patient | None:
    return session.get(Patient, patient_id)


# ------------------------------------------------------------------ 患者主档


def get_patient(patient_id: str) -> ToolResponse:
    """取就诊人基本信息：姓名、性别、年龄、科室、主诉、过敏史、体征。【真实】

    Args:
        patient_id: 就诊人 ID，如 P001。
    """
    session = SessionLocal()
    try:
        p = _patient(session, patient_id)
        if p is None:
            return _ok({"found": False, "reason": f"无此就诊人：{patient_id}"})
        payload = p.payload or {}
        return _ok({
            "found": True,
            "id": p.id, "name": p.name, "gender": p.gender, "age": p.age,
            "dept": p.dept, "doctor": p.doctor, "visit_date": p.visit_date,
            "visit_type": p.visit_type, "is_return_visit": p.is_return_visit,
            "chief_complaint": p.chief_complaint,
            "primary_diagnosis": p.primary_diagnosis,
            "allergies": payload.get("allergies"),
            "past_history": payload.get("past_history"),
            "vitals": payload.get("vitals"),
            "nutrition_screening_score": p.nutrition_screening_score,
        })
    finally:
        session.close()


def get_lab_results(patient_id: str) -> ToolResponse:
    """取检验结果，含参考区间、异常标记与与上次的差值。【真实】

    Args:
        patient_id: 就诊人 ID。
    """
    session = SessionLocal()
    try:
        p = _patient(session, patient_id)
        if p is None:
            return _ok({"found": False, "reason": f"无此就诊人：{patient_id}"})
        labs = (p.payload or {}).get("lab_results") or []
        return _ok({
            "found": True,
            "count": len(labs),
            "abnormal_count": sum(1 for x in labs if isinstance(x, dict) and x.get("abnormal")),
            "results": labs,
        })
    finally:
        session.close()


def get_examinations(patient_id: str) -> ToolResponse:
    """取检查报告（影像、心电、超声等），含结论与异常标记。【真实】

    Args:
        patient_id: 就诊人 ID。
    """
    session = SessionLocal()
    try:
        if _patient(session, patient_id) is None:
            return _ok({"found": False, "reason": f"无此就诊人：{patient_id}"})
        items = seed_items(session, "examination", patient_id)
        return _ok({"found": True, "count": len(items), "examinations": items})
    finally:
        session.close()


def get_visit_history(patient_id: str) -> ToolResponse:
    """取既往就诊记录：时间、科室、诊断、小结。【真实】

    Args:
        patient_id: 就诊人 ID。
    """
    session = SessionLocal()
    try:
        p = _patient(session, patient_id)
        if p is None:
            return _ok({"found": False, "reason": f"无此就诊人：{patient_id}"})
        history = (p.payload or {}).get("visit_history") or []
        return _ok({"found": True, "count": len(history), "visits": history})
    finally:
        session.close()


def get_current_orders(patient_id: str) -> ToolResponse:
    """取在用医嘱（药品与检查）。【真实】

    Args:
        patient_id: 就诊人 ID。
    """
    session = SessionLocal()
    try:
        p = _patient(session, patient_id)
        if p is None:
            return _ok({"found": False, "reason": f"无此就诊人：{patient_id}"})
        orders = (p.payload or {}).get("orders") or []
        return _ok({"found": True, "count": len(orders), "orders": orders})
    finally:
        session.close()


# ------------------------------------------------------------------ 本次问诊


def get_interview_dialog(patient_id: str) -> ToolResponse:
    """取**本次就诊**医生实际做过的问诊对话。【真实】

    没做过问诊时返回 `found: false` 且 `turns: 0` —— **不回落演示脚本**。
    拿一段医生从没做过的对话当本次问诊的事实，比没有对话更糟。

    Args:
        patient_id: 就诊人 ID。
    """
    session = SessionLocal()
    try:
        if _patient(session, patient_id) is None:
            return _ok({"found": False, "reason": f"无此就诊人：{patient_id}"})
        dialog = latest_dialog(session, patient_id, seed_fallback=False)
        return _ok({
            "found": bool(dialog),
            "turns": len(dialog),
            "dialog": dialog,
            "note": "" if dialog else "本次就诊尚未做过问诊，请不要臆测患者自述内容。",
        })
    finally:
        session.close()


# ------------------------------------------------------------------ 规则与字典


def run_hard_rule_risk_scan(patient_id: str) -> ToolResponse:
    """跑硬规则风险扫描：过敏冲突与危急值。【规则 · 不调模型】

    这是**纯代码判定**，独立于任何模型输出。模型不得压低或推翻它的结论 ——
    真出事时，能站住的是规则，不是模型的措辞。

    Args:
        patient_id: 就诊人 ID。
    """
    session = SessionLocal()
    try:
        p = _patient(session, patient_id)
        if p is None:
            return _ok({"found": False, "reason": f"无此就诊人：{patient_id}"})
        ctx = build_context(session, p)
        alerts = hard_rule_alerts(ctx)
        event("tool_hard_rule_scan", patient=patient_id, hits=len(alerts))
        return _ok({
            "found": True,
            "count": len(alerts),
            "alerts": alerts,
            "note": "未命中不等于无风险，只表示这两类硬规则（过敏冲突、危急值）没有触发。",
        })
    finally:
        session.close()


def search_department(keyword: str = "") -> ToolResponse:
    """按关键词检索本院科室。【Mock · 闭集字典】

    一期没有接 HIS 的科室树接口。**推荐科室必须来自这个闭集**，
    不得自行编造本院没有的科室 —— 患者会照着去挂号。

    Args:
        keyword: 症状或科室关键词；留空返回全部科室。
    """
    if not keyword:
        return _ok({"found": True, "count": len(DEPARTMENTS), "departments": list(DEPARTMENTS)})
    hits = [d for d in DEPARTMENTS if keyword in d]
    return _ok({
        "found": bool(hits),
        "count": len(hits),
        "departments": hits,
        "all_departments": list(DEPARTMENTS),
        "note": "未命中时请从 all_departments 里挑选，不要新造科室名。",
    })


def get_assessment_catalog() -> ToolResponse:
    """取 33 项专项评估目录（分类与条目）。【真实 · 静态字典】"""
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "data" / "assessment_catalog.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    return _ok({"found": True, "categories": data.get("categories", [])})


def search_knowledge(query: str) -> ToolResponse:
    """按关键词检索临床知识库词条。【真实 · 本地词条】

    Args:
        query: 检索文本，通常是一段结论或症状描述。
    """
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "data" / "knowledge_base.json"
    kb = json.loads(path.read_text(encoding="utf-8"))
    hits = [
        {"key": k, "title": v["title"], "keywords": v.get("keywords", [])}
        for k, v in kb.items()
        if any(w in query for w in v.get("keywords", []))
    ]
    return _ok({"found": bool(hits), "count": len(hits), "entries": hits})


def get_nutrition_screening(patient_id: str) -> ToolResponse:
    """取营养筛查评分与阈值。【真实 · 阈值规则】

    Args:
        patient_id: 就诊人 ID。
    """
    from ..agents.comorbidity import NUTRITION_ALERT_THRESHOLD

    session = SessionLocal()
    try:
        p = _patient(session, patient_id)
        if p is None:
            return _ok({"found": False, "reason": f"无此就诊人：{patient_id}"})
        score = p.nutrition_screening_score or 0
        return _ok({
            "found": True,
            "score": score,
            "threshold": NUTRITION_ALERT_THRESHOLD,
            "triggered": score >= NUTRITION_ALERT_THRESHOLD,
        })
    finally:
        session.close()


#: 工具注册表。SKILL.md 的 `tools` 白名单按名字从这里取。
#: **不认识的名字一律报错**，不静默跳过 —— 打错一个字就等于那个能力悄悄消失。
TOOL_REGISTRY = {
    fn.__name__: fn
    for fn in (
        get_patient,
        get_lab_results,
        get_examinations,
        get_visit_history,
        get_current_orders,
        get_interview_dialog,
        run_hard_rule_risk_scan,
        search_department,
        get_assessment_catalog,
        search_knowledge,
        get_nutrition_screening,
    )
}
