"""模型通道：按 AgentScope 的 OpenAI 兼容接口构造 ChatModel。

## 为什么不在 orchestration 里（2026-09-03 从那里搬出来）

它曾经只有编排层用，所以叫 `orchestration/settings.py`。现在**产品路径的六个岗位
也走它** —— `agents/runtime.py` 用同一个模型层做结构化生成，
`app/llm.py` 那套手写 httpx 客户端已经不需要了。

搬家和 `app/skills.py` 是同一个理由：留在原地会形成导入环
（`agents.base` → `orchestration` 包 → `master_agent` → `tools` → `agents.risk` → `agents.base`）。
**环是个信号，不是障碍** —— 它在说这个模块的位置错了。

原文档：

沿用项目既有的 `AI_BASE_URL` / `AI_API_KEY`，不另起一套环境变量 ——
两个通道用同一把 key、同一个网关，分开配只会带来「改了一处没改另一处」。
"""

from __future__ import annotations

import os
from functools import lru_cache

from agentscope.model import OpenAIChatModel

from .config import get_ai_settings

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

    第三方网关（`www.meatdc.com/v1`）是 OpenAI 兼容的，走 `client_kwargs.base_url`
    即可，不需要为它写一个 provider 子类。
    """
    default_base, default_key = _base()
    return OpenAIChatModel(
        model_name=model_name or DEFAULT_MODEL,
        api_key=api_key or default_key,
        stream=stream,
        client_kwargs={
            "base_url": base_url or default_base,
            # **重试窗口是实测调出来的，不能用 SDK 默认值。**
            #
            # openai SDK 默认 max_retries=2，退避 0.5s + 1s ≈ 1.5 秒。
            # 而本项目原先手写的 BACKOFF_MS = (500, 1500, 4000) 是约 6 秒，
            # 当初那段注释写着理由：首屏会**并发**发四个岗位的请求，
            # 网关一次瞬时 502 会同时打掉四个、整页降级；实测并发本身没问题，
            # 是抖动窗口比 2 秒重试窗口长。
            #
            # 4 次重试 → 0.5+1+2+4 ≈ 7.5 秒，覆盖住那个窗口。
            # 换运行时时这个常量差点丢掉 —— 它是用一次线上故障换来的。
            "max_retries": 4,
        },
    )


def model_is_configured() -> bool:
    """密钥在不在。不在的话整条编排链路不可用，调用方应显式降级而不是假装成功。"""
    _, key = _base()
    return bool(key)
