"""
把 V4.3 抽取出来的 fixture 导入数据库作为临床种子。

这些数据在一期是 **Agent 的输入上下文**，不是 Agent 的输出。
导入是幂等的：按主键覆盖，可重复执行；不会删除运行时写入的表。
"""

import json
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Drug, Patient, SeedDocument

# apps/api/app/seed.py → 上溯四层到仓库根
FIXTURE_DIR = Path(__file__).resolve().parents[3] / "references/ui-demo/extracted/fixtures"

# 按患者维度组织的六类种子：文件名 → seed_documents.kind
PATIENT_SCOPED = {
    "assessments.json": "assessment",
    "record-content.json": "record_content",
    "comorbidity.json": "comorbidity",
    "dialog-script.json": "dialog_script",
    "timeline.json": "timeline",
    "examinations.json": "examination",
}

# Patient 表的一级列，其余字段整体进 payload
PATIENT_COLUMNS = {
    "id", "name", "gender", "age", "id_no", "phone", "visit_type", "dept", "doctor",
    "visit_date", "chief_complaint", "primary_diagnosis", "risk_level",
    "is_return_visit", "pre_consultation_done", "nutrition_screening_score", "in_queue",
}


def _load(name: str):
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def seed_database(session: Session, *, force: bool = False) -> dict[str, int]:
    """
    导入种子。已存在患者数据时默认跳过，force=True 强制重导。

    返回各类记录数，便于启动日志与测试断言。
    """
    already = session.scalar(select(Patient).limit(1))
    if already is not None and not force:
        return {"skipped": 1}

    counts: dict[str, int] = {}

    patients = _load("patients.json")
    for raw in patients:
        payload = {k: v for k, v in raw.items() if k not in PATIENT_COLUMNS}
        session.merge(
            Patient(
                id=raw["id"],
                name=raw.get("name", ""),
                gender=raw.get("gender", ""),
                age=int(raw.get("age") or 0),
                id_no=raw.get("id_no", ""),
                phone=raw.get("phone", ""),
                visit_type=raw.get("visit_type", ""),
                dept=raw.get("dept", ""),
                doctor=raw.get("doctor", ""),
                visit_date=raw.get("visit_date", ""),
                chief_complaint=raw.get("chief_complaint", ""),
                primary_diagnosis=raw.get("primary_diagnosis", ""),
                risk_level=raw.get("risk_level", ""),
                is_return_visit=bool(raw.get("is_return_visit")),
                pre_consultation_done=bool(raw.get("pre_consultation_done")),
                nutrition_screening_score=int(raw.get("nutrition_screening_score") or 0),
                # fixture 里只有 P007 显式标了 in_queue: false，其余缺省即在队列中
                in_queue=raw.get("in_queue", True) is not False,
                payload=payload,
            )
        )
    counts["patients"] = len(patients)

    drugs = _load("drugs.json")
    for raw in drugs:
        session.merge(Drug(id=raw["id"], name=raw.get("name", ""), payload=raw))
    counts["drugs"] = len(drugs)

    # 重导前清掉旧的按患者种子，避免 kind+patient_id 重复堆积
    if force:
        for doc in session.scalars(select(SeedDocument)).all():
            session.delete(doc)
        session.flush()

    for filename, kind in PATIENT_SCOPED.items():
        data = _load(filename)
        for patient_id, payload in data.items():
            # 列表型种子（对话脚本、时间轴、检查报告）包一层，保证 JSON 列始终是对象
            body = payload if isinstance(payload, dict) else {"items": payload}
            session.add(SeedDocument(kind=kind, patient_id=patient_id, payload=body))
        counts[kind] = len(data)

    session.commit()
    return counts
