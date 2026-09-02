"""前端运行时配置。api_key 一律回空串，真实密钥不下发前端。"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..config import get_ai_settings
from ..schemas import StrictIn

router = APIRouter(prefix="/api/config", tags=["config"])


class ConfigIn(StrictIn):
    model_config = {"extra": "allow"}


def _current() -> dict:
    ai = get_ai_settings()
    return {
        # 恒为空串：前端不需要密钥，下发即等于公开
        "api_key": "",
        "base_url": ai.base_url,
        "model": ai.fast_model,
        "max_tokens": 4096,
        # 让前端知道当前是真实生成还是本地规则
        "mock_generation": not ai.configured,
        # 这里原来有个 `"voice_mode": "webspeech"`，注释写着「一期 ASR 走浏览器
        # Web Speech API」—— **那是假的**：全仓零行 SpeechRecognition，
        # 前端也只声明了这个字段的类型、从没读过它。
        # 一句写在接口契约里的假话，比没有这个字段危险得多。已于 2026-09-03 删除。
    }


@router.get("")
def get_config() -> dict:
    return _current()


@router.put("")
def put_config(_: ConfigIn) -> dict:
    # 模型通道由服务端环境变量决定，不接受前端改写；回显当前配置以兼容 V4.3 的调用
    return {"ok": True, **_current()}
