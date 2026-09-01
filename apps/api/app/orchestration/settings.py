"""编排层的模型配置。

沿用项目既有的 `AI_BASE_URL` / `AI_API_KEY`，不另起一套环境变量 ——
两个通道用同一把 key、同一个网关，分开配只会带来「改了一处没改另一处」。
"""

from __future__ import annotations

import os
from functools import lru_cache

from agentscope.model import OpenAIChatModel

from ..config import get_ai_settings

#: 一期默认模型。2026-09-02 由 Haiku 4.5 换到 Sonnet 5：
#: 六个岗位要做 ReAct（多轮工具调用 + 推理），Haiku 在这类任务上会更早停手、
#: 更容易漏掉该查的工具。临床场景里「少查一次」的代价高于多花的那点时间。
DEFAULT_MODEL = os.environ.get("AI_ORCHESTRATION_MODEL", "claude-sonnet-5")


@lru_cache(maxsize=1)
def _base() -> tuple[str, str]:
    s = get_ai_settings()
    return s.base_url, s.api_key


def build_chat_model(
    *,
    model_name: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    stream: bool = False,
) -> OpenAIChatModel:
    """按 AgentScope 的 OpenAI 兼容通道构造模型。

    第三方网关（`www.meatdc.com/v1`）是 OpenAI 兼容的，走 `client_args.base_url`
    即可，不需要为它写一个 provider 子类。
    """
    default_base, default_key = _base()
    return OpenAIChatModel(
        model_name=model_name or DEFAULT_MODEL,
        api_key=api_key or default_key,
        stream=stream,
        client_args={"base_url": base_url or default_base},
    )


def model_is_configured() -> bool:
    """密钥在不在。不在的话整条编排链路不可用，调用方应显式降级而不是假装成功。"""
    _, key = _base()
    return bool(key)
