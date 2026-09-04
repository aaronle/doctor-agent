"""
HIS 数据面。10 个端点，形状由 V4.3 打包产物定义，不得自行改动。

一期的四个写入端点（orders / exams / referral / admission）全部落本项目自己的库，
不触达真实 HIS；响应结构保持与 V4.3 一致，另在审计表留痕。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import next_id, record_audit
from ..schemas import StrictIn
from ..database import get_session
from ..agents.context import seed_items
from ..models import Admission, Drug, Order, Patient, Referral, Reminder

router = APIRouter(prefix="/api/his", tags=["his"])

# 候诊列表只回这些字段。患者全量对象含 lab_results、health_archive 等大字段，
# 列表页用不到，回传只是白白放大响应体与泄露面。
LIST_FIELDS = (
    "id", "name", "gender", "age", "birth_date", "visit_type", "dept", "doctor",
    "visit_date", "chief_complaint", "primary_diagnosis", "risk_level",
)

#: **`id_no` 不在列表里，也不该进。** 出生年月由它推导后落成 `birth_date`，
#: 界面要的是出生年月，不是身份证号 —— 把身份证发到前端只是白白扩大泄露面。


class OrderIn(StrictIn):
    patient_id: str
    drug: str | None = None
    name: str | None = None
    dose: str = ""
    freq: str = ""
    route: str = ""
    days: str = ""


class ExamIn(StrictIn):
    patient_id: str
    name: str
    type: str = ""
    route: str = ""
    freq: str = ""


class ReferralIn(StrictIn):
    patient_id: str
    target_dept: str = ""
    reason: str = ""

    model_config = {"extra": "allow"}


class AdmissionIn(StrictIn):
    patient_id: str
    patient_name: str = ""
    target_dept: str = ""

    model_config = {"extra": "allow"}


class RemindIn(StrictIn):
    patient_ids: list[str] = Field(default_factory=list)
    patient_id: str | None = None


def _patient_or_404(session: Session, patient_id: str) -> Patient:
    patient = session.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    return patient


def allergy_view(payload: dict) -> dict:
    """
    过敏史的对外形状。**状态和过敏原一起给，不拆成两个平级字段。**

    拆开的话，前端总有一处会只读 items 就下结论 —— 空列表既可能是「问过、没有」，
    也可能是「没人问过」，而这两者在门诊是完全不同的两件事。包成一个对象，
    调用方拿到 items 时必然也拿到了 status，想漏都漏不掉。
    """
    items = payload.get("allergies") or []
    if isinstance(items, str):
        items = [items.strip()] if items.strip() and items.strip() not in {"无", "否认"} else []
    items = [str(a).strip() for a in items if str(a).strip()]
    status = str(payload.get("allergy_status") or "").strip().lower()
    if status not in {"confirmed", "denied", "unknown"}:
        # 老数据没有显式状态：有过敏原就是 confirmed，没有只能算「没人问过」。
        # **不能默认 denied** —— 那等于替医生认领了一次没发生过的问诊。
        status = "confirmed" if items else "unknown"
    return {"status": status, "items": items}


def _list_view(patient: Patient) -> dict:
    view = {field: getattr(patient, field) for field in LIST_FIELDS}
    view["allergy"] = allergy_view(patient.payload or {})
    return view


def _full_view(session: Session, patient: Patient) -> dict:
    """患者全量对象，并把该患者已开的医嘱合并进 orders。"""
    data = {
        **(patient.payload or {}),
        "id": patient.id,
        "name": patient.name,
        "gender": patient.gender,
        "age": patient.age,
        "birth_date": patient.birth_date,
        "allergy": allergy_view(patient.payload or {}),
        "id_no": patient.id_no,
        "phone": patient.phone,
        "visit_type": patient.visit_type,
        "dept": patient.dept,
        "doctor": patient.doctor,
        "visit_date": patient.visit_date,
        "chief_complaint": patient.chief_complaint,
        "primary_diagnosis": patient.primary_diagnosis,
        "risk_level": patient.risk_level,
        "is_return_visit": patient.is_return_visit,
        "pre_consultation_done": patient.pre_consultation_done,
        "nutrition_screening_score": patient.nutrition_screening_score,
    }

    seeded = list(data.get("orders") or [])
    issued = session.scalars(
        select(Order).where(Order.patient_id == patient.id).order_by(Order.created_at)
    ).all()
    data["orders"] = seeded + [
        {
            "id": o.id,
            "drug": o.name,
            "name": o.name,
            "dose": o.dose,
            "freq": o.freq,
            "route": o.route,
            "days": o.days,
            "status": o.status,
            "category": o.category,
            # 检查与检验同为 category=exam，靠 exam_type 区分，界面据此分到两个子页
            "exam_type": o.exam_type,
        }
        for o in issued
    ]
    return data


@router.get("/patients")
def list_patients(session: Session = Depends(get_session)) -> list[dict]:
    patients = session.scalars(
        select(Patient).where(Patient.in_queue.is_(True)).order_by(Patient.id)
    ).all()
    return [_list_view(p) for p in patients]


@router.get("/patients/manage")
def manage_patients(session: Session = Depends(get_session)) -> dict:
    reminded = {r.patient_id for r in session.scalars(select(Reminder)).all()}
    patients = session.scalars(select(Patient).order_by(Patient.id)).all()
    return {
        "ok": True,
        "patients": [{**_list_view(p), "in_queue": p.in_queue, "reminded": p.id in reminded} for p in patients],
        "total": len(patients),
        "reminded_count": len(reminded),
    }


class RequeueIn(StrictIn):
    patient_id: str


@router.post("/patients/requeue")
def requeue_patient(body: RequeueIn, session: Session = Depends(get_session)) -> dict:
    """
    重新接诊：把已完成的患者放回候诊队列。

    提交病历会让患者出队，这是不可逆的单向操作 —— 误点一次，医生的列表里
    就再也找不到这个人了。给一条明确的退路比让人去数据库里改稳妥得多。
    """
    patient = session.get(Patient, body.patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    if patient.in_queue:
        return {"ok": True, "message": "该患者本就在候诊队列中", "changed": False}
    patient.in_queue = True
    record_audit(
        session, action="requeue_patient", entity="patient", entity_id=patient.id,
        patient_id=patient.id, detail={},
    )
    session.commit()
    return {"ok": True, "message": f"{patient.name} 已重新加入候诊队列", "changed": True}


@router.post("/patients/remind")
def remind_patients(body: RemindIn, session: Session = Depends(get_session)) -> dict:
    targets = list(body.patient_ids)
    if body.patient_id:
        targets.append(body.patient_id)
    targets = [pid for pid in dict.fromkeys(targets) if pid]
    if not targets:
        raise HTTPException(status_code=400, detail="未指定患者")

    already = {r.patient_id for r in session.scalars(select(Reminder)).all()}
    added = 0
    for patient_id in targets:
        _patient_or_404(session, patient_id)
        if patient_id in already:
            continue
        session.add(Reminder(patient_id=patient_id))
        record_audit(session, action="remind", entity="patient", entity_id=patient_id, patient_id=patient_id)
        added += 1
    session.commit()
    return {"ok": True, "reminded_count": added, "message": f"已提醒 {added} 位患者"}


@router.get("/patient/{patient_id}")
def get_patient(patient_id: str, session: Session = Depends(get_session)) -> dict:
    return _full_view(session, _patient_or_404(session, patient_id))


@router.get("/patient/{patient_id}/diagnoses")
def get_diagnoses(patient_id: str, session: Session = Depends(get_session)) -> list:
    patient = _patient_or_404(session, patient_id)
    return (patient.payload or {}).get("diagnoses") or []


@router.get("/drugs")
def list_drugs(session: Session = Depends(get_session)) -> list[dict]:
    return [d.payload or {"id": d.id, "name": d.name} for d in session.scalars(select(Drug).order_by(Drug.id)).all()]


@router.post("/orders")
def create_order(body: OrderIn, session: Session = Depends(get_session)) -> dict:
    _patient_or_404(session, body.patient_id)
    name = body.drug or body.name
    if not name:
        raise HTTPException(status_code=400, detail="缺少药品名称")

    order = Order(
        id=next_id(session, Order, "R"),
        patient_id=body.patient_id,
        category="drug",
        name=name,
        dose=body.dose,
        freq=body.freq,
        route=body.route,
        days=str(body.days or ""),
    )
    session.add(order)
    record_audit(
        session,
        action="create_order",
        entity="order",
        entity_id=order.id,
        patient_id=body.patient_id,
        detail={"drug": name, "dose": body.dose, "freq": body.freq, "route": body.route, "days": order.days},
    )
    session.commit()
    return {
        "ok": True,
        "order": {
            "id": order.id,
            "drug": order.name,
            "dose": order.dose,
            "freq": order.freq,
            "route": order.route,
            "days": order.days,
            "status": order.status,
            "category": "drug",
        },
    }


@router.post("/exams")
def create_exam(body: ExamIn, session: Session = Depends(get_session)) -> dict:
    _patient_or_404(session, body.patient_id)
    exam = Order(
        id=next_id(session, Order, "E"),
        patient_id=body.patient_id,
        category="exam",
        name=body.name,
        route=body.route,
        freq=body.freq,
        exam_type=body.type,
    )
    session.add(exam)
    record_audit(
        session,
        action="create_exam",
        entity="order",
        entity_id=exam.id,
        patient_id=body.patient_id,
        detail={"name": body.name, "type": body.type, "route": body.route, "freq": body.freq},
    )
    session.commit()
    return {
        "ok": True,
        "exam": {
            "id": exam.id,
            "name": exam.name,
            "type": exam.exam_type,
            "route": exam.route,
            "freq": exam.freq,
            "status": exam.status,
            "category": "exam",
        },
    }


@router.post("/referral")
def create_referral(body: ReferralIn, session: Session = Depends(get_session)) -> dict:
    _patient_or_404(session, body.patient_id)
    referral = Referral(
        id=next_id(session, Referral, "T"),
        patient_id=body.patient_id,
        target_dept=body.target_dept,
        reason=body.reason,
        payload=body.model_dump(),
    )
    session.add(referral)
    record_audit(
        session,
        action="create_referral",
        entity="referral",
        entity_id=referral.id,
        patient_id=body.patient_id,
        detail={"target_dept": body.target_dept, "reason": body.reason},
    )
    session.commit()
    return {"ok": True, "message": "转诊单已提交", "referral": {"id": referral.id, "target_dept": referral.target_dept}}


@router.post("/admission")
def create_admission(body: AdmissionIn, session: Session = Depends(get_session)) -> dict:
    patient = _patient_or_404(session, body.patient_id)
    admission = Admission(
        id=next_id(session, Admission, "A"),
        patient_id=body.patient_id,
        patient_name=body.patient_name or patient.name,
        target_dept=body.target_dept,
        payload=body.model_dump(),
    )
    session.add(admission)
    record_audit(
        session,
        action="create_admission",
        entity="admission",
        entity_id=admission.id,
        patient_id=body.patient_id,
        detail={"target_dept": body.target_dept},
    )
    session.commit()
    return {
        "ok": True,
        "message": "住院申请已提交",
        "admission": {
            "id": admission.id,
            "patient_id": admission.patient_id,
            "patient_name": admission.patient_name,
            "target_dept": admission.target_dept,
        },
    }


# ------------------------------------------------------------------ 科室看板

#: 进度闭集。多一个值界面就没有对应样式，那一行会渲染成裸文字。
PROGRESS = ("not_started", "pending_report", "interviewed", "done")

#: 风险分档闭集。**「普通病人」是其中一档，不是「没标记」** ——
#: 看板只标危险的，医生仍要逐个确认「这个是真没事还是我漏看了」。
RISK_TIER = ("critical", "warning", "ordinary")


def _pending_exams(session: Session, patient_id: str) -> int:
    """已开单、报告还没回来的检查数。

    这是产品定义里点名的那个状态：**既不是「没看过」**（医生已经开了单、
    做了判断），**也不是「已完成」**（结论还没法下）。合并进任何一边，
    医生就看不出「这个人还欠我一个报告」。
    """
    return sum(
        1 for e in seed_items(session, "examination", patient_id)
        if isinstance(e, dict) and str(e.get("status") or "") != "已完成"
    )


def _progress(patient, pending: int) -> str:
    payload = patient.payload or {}
    if payload.get("submitted_record"):
        return "done"
    if pending:
        return "pending_report"
    if payload.get("analysis_unlock"):
        return "interviewed"
    return "not_started"


@router.get("/board")
def department_board(session: Session = Depends(get_session)) -> dict:
    """
    科室看板：**诊疗进度** × **风险** 两个维度。

    产品定义（2026-09-04 确认）：

    > 病人看板主要是从两个维度回顾：① 诊疗进度 —— 哪些看过了、哪些没有
    > （比如做完检查但报告还没回来的）；② 风险评估 —— 哪些有风险或危急值，
    > 哪些是普通病人。

    它**不是运营报表**（那面向科主任，是另一个人另一个场景），
    也**不只是「下一个看谁」的队列** —— 关键词是「回顾」，
    所以已出队、已完成的患者同样要在，否则今天回顾不了。

    排序是「**该我处理的排前面**」：未处置红线 > 报告已回但没看 > 其余。
    不按患者号排 —— 那个顺序对医生没有任何含义。
    """
    from ..agents.risk import hard_rule_alerts

    rows = []
    for patient in session.scalars(select(Patient).order_by(Patient.id)).all():
        payload = patient.payload or {}
        pending = _pending_exams(session, patient.id)
        progress = _progress(patient, pending)

        ctx = {
            "allergies": payload.get("allergies") or [],
            "allergy_status": payload.get("allergy_status") or "",
            "orders": payload.get("orders") or [],
            "lab_results": payload.get("lab_results") or [],
            "vitals": payload.get("vitals") or {},
        }
        alerts = hard_rule_alerts(ctx)
        handled = set(payload.get("handled_alerts") or [])
        # **未处置的条数**，不是总数 —— 已处置的还算在里面，
        # 医生会以为自己没处理完
        open_red = [a for a in alerts if a["level"] == "高风险" and a["id"] not in handled]
        open_warn = [a for a in alerts if a["level"] == "中风险" and a["id"] not in handled]

        tier = "critical" if open_red else ("warning" if open_warn else "ordinary")
        rows.append({
            "patient_id": patient.id,
            "name": patient.name,
            "age": patient.age,
            "gender": patient.gender,
            "dept": patient.dept,
            "chief_complaint": patient.chief_complaint,
            "progress": progress,
            "pending_exams": pending,
            "in_queue": bool(patient.in_queue),
            "risk_tier": tier,
            "open_red": len(open_red),
            "open_warn": len(open_warn),
            "red_names": [a["name"] for a in open_red][:3],
            "allergy_status": payload.get("allergy_status") or "unknown",
            "allergies": payload.get("allergies") or [],
        })

    order = {t: i for i, t in enumerate(RISK_TIER)}
    rows.sort(key=lambda r: (order[r["risk_tier"]], r["progress"] == "done", r["patient_id"]))

    return {
        "total": len(rows),
        "done": sum(1 for r in rows if r["progress"] == "done"),
        "pending_report": sum(1 for r in rows if r["progress"] == "pending_report"),
        # 「今天还剩几个要处理」—— 医生第一眼看的就是这个数
        "needs_attention": sum(1 for r in rows if r["risk_tier"] != "ordinary" and r["progress"] != "done"),
        "rows": rows,
    }
