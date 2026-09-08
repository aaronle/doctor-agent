"""
预问诊：患者候诊时在手机上自己填的那一份。

## 它解决什么

医生开口第一分钟问的东西，大半是患者本来就知道的事实 ——
「哪儿不舒服」「多久了」「有没有过敏」「上次月经哪天」。
让患者在候诊时先填，医生一进来就看得到。

## 三条硬约束

**① 这条路上不下发任何临床数据。** 患者端只填自己的情况；
诊断、检验、风险一个字都不下发。「界面不显示」不算数 —— 接口不给才算。

**② 登录失败不说是哪一项错了。** 说了就等于给出一份可枚举的患者名单：
拿到一个病人号的人可以逐个试姓名，直到不再报「姓名错误」。

**③ 患者自报的过敏史不改档案状态。** 患者点一下「没有过敏」，
与医生问过并确认，是两件事。混为一谈会消掉那条提醒医生补问的告警，
而下游的过敏冲突红线正建立在它之上。
（产品决定，2026-09-08。）
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Patient
from ..schemas import StrictIn

router = APIRouter(prefix="/api/previsit", tags=["previsit"])

# 比 `seed.py` 多一层 —— 这个文件在 `routers/` 里。
# 第一版照抄了 seed 的 `parents[3]`，指到了 `apps/`，FileNotFoundError
_FIXTURES = Path(__file__).resolve().parents[4] / "references/ui-demo/extracted/fixtures"

#: 登录失败时唯一的那句话。**两种错法必须完全一致** —— 见文件头第 ② 条。
_LOGIN_FAILED = "病人号与姓名对不上，请核对挂号单"

#: 一次就诊里最多存多少条答案。问题集统共 8 题，给到 24 是留给将来加题的余量，
#: 同时挡住「有人拿这个接口当存储用」
_MAX_ANSWERS = 24


def _questions() -> dict:
    return json.loads((_FIXTURES / "previsit-questions.json").read_text(encoding="utf-8"))


def _authenticate(session: Session, patient_id: str, name: str) -> Patient:
    """
    病人号 + 姓名。**两项都对才放行，且失败只有一种回法。**

    姓名做了去空格比对：挂号单上抄下来的名字常常带空格，
    因为一个空格把患者挡在门外，他只会去找护士，而不会想到是空格。
    """
    patient = session.get(Patient, (patient_id or "").strip())
    if patient is None or patient.name != (name or "").strip():
        raise HTTPException(status_code=404, detail=_LOGIN_FAILED)
    return patient


class LoginIn(StrictIn):
    patient_id: str = ""
    name: str = ""


@router.post("/login")
def login(body: LoginIn, session: Session = Depends(get_session)) -> dict:
    """
    确认是本人，并告诉前端该问哪一套题。

    **返回体里只有患者自己知道的东西**（名字、科室、就诊日）——
    没有诊断、没有检验、没有风险等级。
    """
    patient = _authenticate(session, body.patient_id, body.name)
    return {
        "patient_id": patient.id,
        "name": patient.name,
        "dept": patient.dept,
        "visit_date": patient.visit_date,
        "submitted": bool((patient.payload or {}).get("previsit")),
    }


@router.get("/questions/{patient_id}")
def questions(patient_id: str, session: Session = Depends(get_session)) -> dict:
    """
    通用题 + 本科室题。

    科室没有专属题时**只给通用题，不报错** —— 一个还没配题的科室
    不该让患者卡在这里。
    """
    patient = session.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    data = _questions()
    return {
        "patient_id": patient.id,
        "dept_name": patient.dept,
        "common": data["common"],
        "dept": data["by_dept"].get(patient.dept, []),
    }


class AnswersIn(StrictIn):
    patient_id: str = ""
    name: str = ""
    answers: dict = Field(default_factory=dict)


@router.post("/answers")
def submit(body: AnswersIn, session: Session = Depends(get_session)) -> dict:
    """
    提交。**覆盖，不追加。**

    同一次就诊里留下两份互相矛盾的答案，医生没有办法判断该信哪一份 ——
    而他多半不会发现有两份。

    提交同样要校验姓名：只验病人号的话，拿到号码就能替别人填。
    """
    patient = _authenticate(session, body.patient_id, body.name)

    answers = {k: v for k, v in list(body.answers.items())[:_MAX_ANSWERS] if isinstance(v, dict)}
    payload = dict(patient.payload or {})
    payload["previsit"] = {
        "source": "patient",
        "answers": answers,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }
    patient.payload = payload
    # 「预问诊已完成」是候诊列表上的一个标记，医生扫一眼就知道谁填过
    patient.pre_consultation_done = True
    session.commit()

    return {"ok": True, "count": len(answers)}


def previsit_of(patient: Patient) -> dict | None:
    """读出预问诊，并**标出哪些还需要医生确认**。

    目前只有过敏这一项：患者自报不改档案状态（见文件头第 ③ 条），
    所以必须在医生端显式挂一个「待确认」，否则这次采集等于白做。
    """
    raw = (patient.payload or {}).get("previsit")
    if not isinstance(raw, dict):
        return None
    answers = raw.get("answers") or {}
    allergy = answers.get("allergy") or {}
    return {
        "patient_id": patient.id,
        "source": raw.get("source", "patient"),
        "answers": answers,
        "submitted_at": raw.get("submitted_at", ""),
        "needs_confirmation": bool(allergy.get("choice")),
    }


@router.get("/answers/{patient_id}")
def read(patient_id: str, session: Session = Depends(get_session)) -> dict:
    """医生端读。没填过返回空壳而不是 404 —— 「没填」是正常状态，不是错误。"""
    patient = session.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="患者不存在")
    got = previsit_of(patient)
    if got is None:
        return {"patient_id": patient_id, "source": "", "answers": {},
                "submitted_at": "", "needs_confirmation": False}
    return got
