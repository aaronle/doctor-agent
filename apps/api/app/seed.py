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
    "id", "name", "gender", "age", "birth_date", "id_no", "phone", "visit_type", "dept", "doctor",
    "visit_date", "chief_complaint", "primary_diagnosis", "risk_level",
    "is_return_visit", "pre_consultation_done", "nutrition_screening_score", "in_queue",
}


def _load(name: str):
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


#: 需要类型转换的列。其余按字符串原样取，缺省空串。
_COERCE = {
    "age": lambda v: int(v or 0),
    "nutrition_screening_score": lambda v: int(v or 0),
    "is_return_visit": bool,
    "pre_consultation_done": bool,
    # fixture 里只有 P007 显式标了 in_queue: false，其余缺省即在队列中
    "in_queue": lambda v: v is not False,
}


def birth_date_from_id_no(id_no: str) -> str:
    """
    从 18 位身份证号取出生日期 `YYYY-MM-DD`。

    **出生日期只有这一个来源。** 单独再录一个字段的话，两处必然会漂 ——
    修 fixture 时发现七个患者里已经有五个的 age 与身份证对不上（P001 差 2 岁），
    而那一直没被发现，正是因为身份证号从来不显示在界面上。
    现在出生年月要显示在患者信息行里，紧挨着年龄，这道减法谁都会做。
    """
    s = str(id_no or "").strip()
    if len(s) != 18 or not s[:17].isdigit():
        return ""
    year, month, day = s[6:10], s[10:12], s[12:14]
    return f"{year}-{month}-{day}"


def _patient_columns(raw: dict) -> dict:
    """
    按 PATIENT_COLUMNS 组装一级列。

    以前这里是手写的 17 行 `字段=raw.get(...)`，和 PATIENT_COLUMNS 是**两份清单**。
    往 PATIENT_COLUMNS 加了 birth_date 之后，构造函数不认识它 ——
    不报错、不告警，那一列就是空的，直到界面上显示出来才发现。
    改成由同一份清单驱动，加字段只需要改一处。
    """
    out: dict = {}
    for field in PATIENT_COLUMNS:
        if field == "birth_date":
            out[field] = birth_date_from_id_no(raw.get("id_no", ""))
            continue
        value = raw.get(field)
        out[field] = _COERCE[field](value) if field in _COERCE else (value if value is not None else "")
    return out


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
        session.merge(Patient(**_patient_columns(raw), payload=payload))
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
