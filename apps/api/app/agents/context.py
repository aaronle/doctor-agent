"""
患者上下文装配。

送进模型的字段是**白名单**，不是「把患者对象整个丢过去」：
身份证号、手机号这类身份信息对临床推理没有贡献，却会扩大泄露面，
因此一律不进上下文。需要新增字段时在这里显式加，便于审计。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Patient, SeedDocument

# 临床推理所需的最小充分集合。刻意排除 id_no、phone 等身份信息。
CLINICAL_FIELDS = (
    "diagnoses",
    "suspected_diagnoses",
    "past_history",
    "allergies",
    "vitals",
    "lab_results",
    "orders",
    "visit_history",
    "health_archive",
    "has_fundus_exam",
    "has_retinopathy",
    "retinopathy_grade",
)


def load_patient(session: Session, patient_id: str) -> Patient | None:
    return session.get(Patient, patient_id)


def seed_payload(session: Session, kind: str, patient_id: str) -> dict:
    doc = session.scalar(
        select(SeedDocument).where(SeedDocument.kind == kind, SeedDocument.patient_id == patient_id)
    )
    return doc.payload if doc else {}


def seed_items(session: Session, kind: str, patient_id: str) -> list:
    """列表型种子（对话脚本、时间轴、检查报告）导入时包了一层 items。"""
    return seed_payload(session, kind, patient_id).get("items", [])


def build_context(session: Session, patient: Patient, *, include_dialog: bool = False) -> dict:
    """装配送进模型的患者上下文。来源清晰、时间明确、最小充分。"""
    payload = patient.payload or {}
    ctx: dict = {
        "id": patient.id,
        "name": patient.name,
        "gender": patient.gender,
        "age": patient.age,
        "dept": patient.dept,
        "visit_type": patient.visit_type,
        "visit_date": patient.visit_date,
        "is_return_visit": patient.is_return_visit,
        "chief_complaint": patient.chief_complaint,
        "primary_diagnosis": patient.primary_diagnosis,
        "nutrition_screening_score": patient.nutrition_screening_score,
    }
    for field in CLINICAL_FIELDS:
        if field in payload:
            ctx[field] = payload[field]

    examinations = seed_items(session, "examination", patient.id)
    if examinations:
        ctx["examinations"] = examinations

    if include_dialog:
        dialog = seed_items(session, "dialog_script", patient.id)
        if dialog:
            ctx["dialog_script"] = dialog

    return ctx


def abnormal_labs(ctx: dict) -> list[dict]:
    """取出异常检验项。风险硬规则与多个 Agent 的兜底都依赖它。"""
    return [lab for lab in ctx.get("lab_results", []) if isinstance(lab, dict) and lab.get("abnormal")]


# 患者上下文里最占体积的两块：检验历史值数组与检查报告全文。
# 只有需要判断趋势的岗位才用得上历史值，其余岗位带着它们只是白白拖慢生成。
def project(ctx: dict, *, fields: tuple[str, ...] | None, lab_history: bool = False, exam_detail: bool = True) -> dict:
    """
    按岗位需要裁剪上下文。

    动机是延迟：四个岗位各带一份 20KB 全量上下文时，最慢的诊断岗位要 27s。
    裁剪掉用不上的部分能显著降低 prompt token 与首字延迟，
    且不影响该岗位的判断质量 —— 用不到的字段本来就不该进提示词。
    """
    # 身份与就诊信息是所有岗位的公共底座，任何裁剪都要保留
    always = ("id", "name", "gender", "age", "dept", "visit_type", "visit_date", "is_return_visit", "chief_complaint")
    keep = set(always) | set(fields or ctx.keys())
    slim = {k: v for k, v in ctx.items() if k in keep}

    if not lab_history and isinstance(slim.get("lab_results"), list):
        slim["lab_results"] = [
            {k: v for k, v in lab.items() if k not in {"history", "history_dates"}}
            if isinstance(lab, dict)
            else lab
            for lab in slim["lab_results"]
        ]

    if not exam_detail and isinstance(slim.get("examinations"), list):
        # 只留结论，不带报告全文
        slim["examinations"] = [
            {k: v for k, v in exam.items() if k in {"name", "date", "conclusion", "result"}}
            if isinstance(exam, dict)
            else exam
            for exam in slim["examinations"]
        ]

    return slim
