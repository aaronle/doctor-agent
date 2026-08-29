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
from ..database import get_session
from ..models import Admission, Drug, Order, Patient, Referral, Reminder

router = APIRouter(prefix="/api/his", tags=["his"])

# 候诊列表只回这些字段。患者全量对象含 lab_results、health_archive 等大字段，
# 列表页用不到，回传只是白白放大响应体与泄露面。
LIST_FIELDS = (
    "id", "name", "gender", "age", "visit_type", "dept", "doctor",
    "visit_date", "chief_complaint", "primary_diagnosis", "risk_level",
)


class OrderIn(BaseModel):
    patient_id: str
    drug: str | None = None
    name: str | None = None
    dose: str = ""
    freq: str = ""
    route: str = ""
    days: str = ""


class ExamIn(BaseModel):
    patient_id: str
    name: str
    type: str = ""
    route: str = ""
    freq: str = ""


class ReferralIn(BaseModel):
    patient_id: str
    target_dept: str = ""
    reason: str = ""

    model_config = {"extra": "allow"}


class AdmissionIn(BaseModel):
    patient_id: str
    patient_name: str = ""
    target_dept: str = ""

    model_config = {"extra": "allow"}


class RemindIn(BaseModel):
    patient_ids: list[str] = Field(default_factory=list)
    patient_id: str | None = None


def _patient_or_404(session: Session, patient_id: str) -> Patient:
    patient = session.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    return patient


def _list_view(patient: Patient) -> dict:
    return {field: getattr(patient, field) for field in LIST_FIELDS}


def _full_view(session: Session, patient: Patient) -> dict:
    """患者全量对象，并把该患者已开的医嘱合并进 orders。"""
    data = {
        **(patient.payload or {}),
        "id": patient.id,
        "name": patient.name,
        "gender": patient.gender,
        "age": patient.age,
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
