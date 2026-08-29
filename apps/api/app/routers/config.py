"""前端运行时配置。api_key 一律回空串，真实密钥不下发前端。"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..config import get_ai_settings

router = APIRouter(prefix="/api/config", tags=["config"])


class ConfigIn(BaseModel):
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
        # 一期 ASR 走浏览器 Web Speech API，不可用时降级为手动输入
        "voice_mode": "webspeech",
    }


@router.get("")
def get_config() -> dict:
    return _current()


@router.put("")
def put_config(_: ConfigIn) -> dict:
    # 模型通道由服务端环境变量决定，不接受前端改写；回显当前配置以兼容 V4.3 的调用
    return {"ok": True, **_current()}
