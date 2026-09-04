"""
微调语料的采集。

**采的是「医生改了什么」，不是「AI 输出了什么」。** 后者 `agent_runs.output`
里早就有了，拿它去微调等于让模型学它自己已经会的东西。

一条语料 = (完整输入上下文, AI 初稿, 医生定稿, 判定)。缺了医生定稿的行是
半成品，只有参考价值。所以采集点必须挂在**医生落笔的那一刻** ——
提交病历、回写诊断 —— 而不是模型返回的那一刻。
"""

from __future__ import annotations

import difflib

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Patient, RecordDraft, TrainingSample

#: `RecordDraft.provider` 里属于医生的那些前缀。其余视为 AI 产出。
_DOCTOR_PROVIDERS = ("doctor-",)


def _similarity(a: str, b: str) -> float:
    """两段文本的相似度 0–1。用来量化医生改了多少。"""
    if not a and not b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def diff_fields(ai: dict, doctor: dict) -> dict:
    """
    逐字段比对，给出「改了哪些、各改了多少」。

    只比双方都有的字段与医生新增的字段。**相似度不做阈值判断** ——
    「改了多少算改」是分析时的事，采集阶段只如实记录数字。
    过早地把连续量压成布尔，后面想换阈值就得重新采。
    """
    out: dict[str, dict] = {}
    for key in sorted(set(ai) | set(doctor)):
        before = str(ai.get(key) or "")
        after = str(doctor.get(key) or "")
        if before == after:
            continue
        out[key] = {
            "similarity": round(_similarity(before, after), 4),
            "len_before": len(before),
            "len_after": len(after),
        }
    return out


def verdict_of(ai: dict, doctor: dict, changed: dict) -> str:
    """
    采纳 / 改过 / 丢弃。

    - `accepted`：一字未改。**这也是有效语料** —— 它说明模型在这类病例上是对的。
    - `discarded`：医生把 AI 那一份整个换掉了（几乎没有字段留下来）。
      这是最值钱也最刺眼的一类，单独标出来便于优先看。
    - `edited`：其余。
    """
    if not ai:
        return "no_ai_draft"
    if not changed:
        return "accepted"
    # 所有字段都改过、且改动都很大 → 医生实际上是重写了一遍
    common = [k for k in ai if k in doctor]
    if common and all(
        changed.get(k, {}).get("similarity", 1.0) < 0.3 for k in common
    ):
        return "discarded"
    return "edited"


def latest_ai_draft(session: Session, patient_id: str) -> RecordDraft | None:
    """最近一版**由 AI 生成**的病历草稿。

    医生自己暂存/提交的版本（`provider` 以 `doctor-` 开头）要跳过 ——
    拿医生的上一版当「AI 初稿」，会把他自己的修改算成模型的产出。
    """
    rows = session.scalars(
        select(RecordDraft)
        .where(RecordDraft.patient_id == patient_id)
        .order_by(RecordDraft.version.desc())
    ).all()
    for row in rows:
        if not str(row.provider or "").startswith(_DOCTOR_PROVIDERS):
            return row
    return None


def source_of(patient: Patient) -> str:
    """数据来源。决定 `trainable` 的默认值。

    一期全部是种子里的虚构病例。真正接入院内 HIS 时，患者会带上
    真实来源标记，那时这里返回 `his`，语料默认**不可训练**，
    要人工过完去标识化与合规审查才翻。
    """
    return str((patient.payload or {}).get("source") or "fixture")


def capture_record_sample(
    session: Session,
    patient: Patient,
    doctor_fields: dict,
    *,
    task: str = "submit_record",
) -> TrainingSample | None:
    """
    在医生提交病历时采一条语料。

    找不到 AI 初稿就不采：没有对照的「医生写了什么」不是监督信号，
    只是一份病历副本 —— 那种东西存进来只增加隐私面，不增加训练价值。
    """
    draft = latest_ai_draft(session, patient.id)
    if draft is None:
        return None

    ai_fields = dict(draft.fields or {})
    changed = diff_fields(ai_fields, doctor_fields)
    source = source_of(patient)

    sample = TrainingSample(
        patient_id=patient.id,
        agent_key="record",
        task=task,
        context={
            "chief_complaint": patient.chief_complaint,
            "dept": patient.dept,
            "primary_diagnosis": patient.primary_diagnosis,
            # 来源映射：这一段 AI 是照着什么写的，微调时是重要的输入线索
            "provenance": draft.provenance or {},
        },
        ai_output=ai_fields,
        doctor_output=dict(doctor_fields),
        verdict=verdict_of(ai_fields, doctor_fields, changed),
        changed=changed,
        source=source,
        # 虚构演示数据默认可训练；真实院内数据默认不可，等人工过合规
        trainable=source == "fixture",
        deidentified=source == "fixture",
    )
    session.add(sample)
    return sample


def capture_diagnosis_sample(
    session: Session,
    patient: Patient,
    ai_suspected: list,
    doctor_confirmed: list,
) -> TrainingSample:
    """
    在医生确认诊断时采一条语料。

    这里的监督信号是**勾选**：AI 列了 5 条鉴别诊断，医生只勾了 2 条 ——
    没被勾的那 3 条就是负样本。这比病历的文本 diff 更干净，
    因为它是医生的明确判断，不掺杂措辞偏好。
    """
    ai_names = [str(x.get("name") or "") for x in ai_suspected if isinstance(x, dict)]
    picked = [str(x) for x in doctor_confirmed]
    source = source_of(patient)

    sample = TrainingSample(
        patient_id=patient.id,
        agent_key="diagnosis",
        task="write_back_diagnosis",
        context={
            "chief_complaint": patient.chief_complaint,
            "dept": patient.dept,
            "primary_diagnosis": patient.primary_diagnosis,
        },
        ai_output={"suspected": ai_suspected},
        doctor_output={"confirmed": picked},
        verdict=(
            "accepted" if set(picked) == set(ai_names)
            else "discarded" if not set(picked) & set(ai_names)
            else "edited"
        ),
        changed={
            "kept": [n for n in ai_names if n in picked],
            "dropped": [n for n in ai_names if n not in picked],
            # 医生自己加的（不在 AI 清单里）—— 模型漏掉的那些，最值得看
            "added": [n for n in picked if n not in ai_names],
        },
        source=source,
        trainable=source == "fixture",
        deidentified=source == "fixture",
    )
    session.add(sample)
    return sample
