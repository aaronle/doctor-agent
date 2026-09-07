"""
医生个人配置：主题、字号、AI 追问初始状态、浮窗布局记忆。

## 为什么不挂在 `/api/config` 下

`/api/config` 返回的是**服务端运行时事实**（模型通道、是否真实生成），它的 PUT
刻意不写入、只回显。把「医生个人偏好」塞进同一个 endpoint，那个「PUT 不落库」
的语义立刻又变含糊 —— 正是删掉 `voice_mode` 时反复强调的错误类型。所以另开一路。

## `actor` 是不可信的

一期没有 SSO，`actor` 来自前端 session store 里的医生名，任何人都能伪造。
这里**不做任何访问控制**，伪造的后果仅限于读到或改掉别人的界面颜色与字号。
真正需要保护的东西（岗位配置、写回门禁）不在这条路径上。
接 SSO 后把 `actor` 换成工号即可，本文件的逻辑不变。

## 前端是双写的

localStorage 管瞬时生效不闪屏，这里管跨设备同步。所以 `PUT` 必须是幂等的
全量覆盖语义、`GET` 必须永远返回一份**完整**偏好（合并过默认值），
否则前端要自己判断「没设过」和「设成了默认值」的区别。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy.orm import Session

from ..audit import DEMO_ACTOR, record_audit
from ..database import get_session
from ..models import UserPreference
from ..preferences import (
    DEFAULTS,
    FOLLOW_UP_MODES,
    FONT_LEVELS,
    PREFERENCE_VERSION,
    THEMES,
    WINDOW_BOUNDS,
    PreferenceError,
    merge,
    strip_defaults,
    validate_prefs,
)
from ..schemas import StrictIn

router = APIRouter(prefix="/api/preferences", tags=["preferences"])


def _actor(raw: str) -> str:
    """
    空 actor 落到演示身份，而不是报错。

    一期前端在极少数路径下（首次进入、sessionStorage 被清）确实拿不到医生名，
    这时让它读写演示身份的那一行，比弹一个 400 更符合「配置页永远能打开」。
    """
    return (raw or "").strip()[:64] or DEMO_ACTOR


class PreferencesIn(StrictIn):
    actor: str = ""
    #: PATCH 语义：只传要改的项。校验在 app/preferences.py，
    #: 不写成一堆 Pydantic 字段是因为偏好项会频繁增删，
    #: 集中在一份白名单里比散在模型定义里好维护
    prefs: dict = Field(default_factory=dict)


@router.get("/options")
def get_options() -> dict:
    """
    配置页要渲染的取值集合与默认值。

    **前端不要自己硬编码这几个枚举** —— 后端加了一档主题、前端没跟着改，
    界面上就永远少一个选项，且没有任何测试会失败。
    """
    return {
        "version": PREFERENCE_VERSION,
        "themes": list(THEMES),
        "font_levels": list(FONT_LEVELS),
        "follow_up_modes": list(FOLLOW_UP_MODES),
        "window_bounds": {k: list(v) for k, v in WINDOW_BOUNDS.items()},
        "defaults": DEFAULTS,
    }


@router.get("")
def get_preferences(actor: str = "", session: Session = Depends(get_session)) -> dict:
    row = session.get(UserPreference, _actor(actor))
    return {"actor": _actor(actor), "prefs": merge(row.prefs if row else None)}


@router.put("")
def save_preferences(body: PreferencesIn, session: Session = Depends(get_session)) -> dict:
    actor = _actor(body.actor)
    try:
        validate_prefs(body.prefs)
    except PreferenceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    row = session.get(UserPreference, actor)
    current = merge(row.prefs if row else None)
    merged = {**current, **body.prefs}
    if "windows" in body.prefs:
        merged["windows"] = {**current["windows"], **body.prefs["windows"]}
    diff = strip_defaults(merged)

    if row is None:
        row = UserPreference(actor=actor, prefs=diff)
        session.add(row)
    else:
        # JSON 列要整体赋新对象才会被脏检测到，原地 mutate 不会落库
        row.prefs = diff

    record_audit(
        session,
        action="update_preferences",
        entity="user_preference",
        entity_id=actor,
        # 只记改了哪些项，不记取值全文 —— 对齐审计表「不存正文」的口径
        detail={"keys": sorted(k for k in body.prefs if k != "version")},
        actor=actor,
    )
    session.commit()
    return {"ok": True, "actor": actor, "prefs": merge(diff)}


@router.delete("")
def reset_preferences(actor: str = "", session: Session = Depends(get_session)) -> dict:
    """恢复全部默认。删行而不是写一份等于默认的值 —— 这样以后改默认值这个人会跟着变。"""
    resolved = _actor(actor)
    row = session.get(UserPreference, resolved)
    if row is not None:
        session.delete(row)
        record_audit(
            session,
            action="reset_preferences",
            entity="user_preference",
            entity_id=resolved,
            actor=resolved,
        )
        session.commit()
    return {"ok": True, "actor": resolved, "prefs": merge(None)}
