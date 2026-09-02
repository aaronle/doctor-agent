"""
> **2026-09-03：这个模块只剩流式了。**
>
> 六个岗位的结构化生成已改走 `agents/runtime.py`（AgentScope 模型层 +
> 工具调用 schema）。随之删掉的有 `complete_json`、`extract_json_object`
> 与重试信号 `_Retry` —— 后者是一个从模型自由文本里**抠 JSON** 的函数，
> 连同它在安全层里留下的两条补丁规矩（「只输出 JSON 对象」
> 「字符串内不得出现半角双引号」）。那两条不是洁癖：未转义的半角引号
> 会截断 JSON、整份输出被丢弃，是真出过的事故。
>
> 输出形状由协议保证之后，这一整条链路就没有存在的理由了。
>
> **留下的是流式**：Copilot 对话与病历流式生成 —— 它们要的是逐字吐出，
> 不是结构化对象。换模型时挖出的三个坑（温度判据、400 不该重试、
> 日志字段名）都在这条路径上继续有效，测试也都还在。

OpenAI 兼容网关客户端，对齐 Ticket System 的接入方式。

刻意保持薄：只负责「发请求、重试、记账、把响应解析成 JSON 对象」，
不掺任何临床语义。临床约束在 agents/ 里。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import AsyncIterator

import httpx

from .config import get_ai_settings
from .obs import event

logger = logging.getLogger("doctor_agent.llm")

# 重试常量随 complete_json 一起删了：流式没有重试（一次连接吐到底，
# 中途断了重来会让医生看到重复的半句），结构化生成的重试交给
# openai SDK —— 它的默认策略不重试 4xx，正好是当初那条规矩要的。

# 够装下最长的一份七段病历；再大只会拖慢首屏而没有实际收益
MAX_TOKENS = 4096

# 已废弃 temperature 的模型：发过去会 400。
#
# 用**显式清单**而不是「试一次看报不报错」：后者要么在首屏多花一次往返，
# 要么把结果缓存起来 —— 那等于把网关的行为变成隐式状态，出问题时更难查。
# 清单短、变化慢，加一行的成本远低于一次线上降级。
#
# 代价要说清楚：这些模型上我们**无法固定温度**，可复现性依赖模型自身。
# 病历复核时若发现两次输出不一致，先想到这一条。
MODELS_WITHOUT_TEMPERATURE = ("claude-sonnet-5", "claude-opus-5", "claude-fable-5")


def _accepts_temperature(model: str) -> bool:
    return not any(model.startswith(m) for m in MODELS_WITHOUT_TEMPERATURE)


class LlmError(RuntimeError):
    """
    模型通道不可用或返回不可解析。调用方据此降级到本地规则。

    解析失败时带上 `raw_excerpt`（模型原文片段）。只有原文能说清楚
    「模型到底吐了什么」—— 只有一句异常消息时，格式类问题基本无从定位。
    """

    def __init__(self, message: str, *, raw_excerpt: str = "") -> None:
        super().__init__(message)
        self.raw_excerpt = raw_excerpt


@dataclass
class LlmResult:
    data: dict
    model: str
    elapsed_ms: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    request_bytes: int = 0
    raw_text: str = ""


@dataclass
class ChatMessage:
    role: str
    content: str

    def as_dict(self) -> dict:
        return {"role": self.role, "content": self.content}


@dataclass
class LlmClient:
    settings: object = field(default_factory=get_ai_settings)

    @property
    def configured(self) -> bool:
        return self.settings.configured

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.settings.api_key}",
            "Content-Type": "application/json",
        }

    def _body(self, messages: list[ChatMessage], *, model: str, json_mode: bool, stream: bool) -> dict:
        body: dict = {
            "model": model,
            "messages": [m.as_dict() for m in messages],
            "enable_thinking": False,
            # 必须显式给：网关默认上限偏小，临床结构化 JSON 会被截断，
            # 表现为「括号未闭合」而全部降级到本地规则。
            "max_tokens": MAX_TOKENS,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if stream:
            body["stream"] = True
        # 结构化临床输出要可复现：同一份上下文两次生成的病历应当一致，否则无法复核。
        #
        # 但**不是所有模型都收这个参数**。claude-sonnet-5 已废弃 temperature，
        # 带上直接 400：`temperature is deprecated for this model`。
        # 2026-09-02 换模型时就是栽在这里 —— 三个岗位同时降级。
        #
        # 早先写的是 `if "haiku" in model`，那是把模型名当判据、纯属巧合地成立。
        # 现在的判据是**这个模型收不收 temperature**，那是它的真实属性。
        if _accepts_temperature(model):
            body["temperature"] = 0
        return body

    async def stream_text(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        agent_key: str = "",
    ) -> AsyncIterator[str]:
        """流式返回纯文本增量。用于对话问答与语音追问建议。"""
        if not self.configured:
            raise LlmError("模型通道未配置")

        target_model = model or self.settings.fast_model
        body = self._body(messages, model=target_model, json_mode=False, stream=True)
        payload = json.dumps(body, ensure_ascii=False)
        started = time.monotonic()

        try:
            async with httpx.AsyncClient(timeout=self.settings.timeout_seconds) as client:
                async with client.stream(
                    "POST",
                    f"{self.settings.base_url}/chat/completions",
                    headers=self._headers(),
                    content=payload.encode("utf-8"),
                ) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        chunk = line[5:].strip()
                        if not chunk or chunk == "[DONE]":
                            continue
                        try:
                            parsed = json.loads(chunk)
                        except json.JSONDecodeError:
                            continue
                        delta = (parsed.get("choices") or [{}])[0].get("delta", {})
                        piece = delta.get("content")
                        if piece:
                            yield piece
        except httpx.HTTPError as exc:
            self._log(agent_key, target_model, 1, len(payload), type(exc).__name__, started)
            raise LlmError(f"模型流式请求失败：{type(exc).__name__}") from exc

        self._log(agent_key, target_model, 1, len(payload), "ok-stream", started)

    def _log(self, agent_key: str, model: str, attempt: int, request_bytes: int, status: str, started: float) -> None:
        """
        通道层事实。只记形状与耗时，绝不记密钥与病历内容。

        走 obs.event 而不是自己拼 JSON：字段名要跟其余事件一致（`ms` 而不是
        `elapsedMs`），否则 `jq 'select(.ms>15000)'` 这类跨事件查询会静默漏掉
        整整一类 —— 而 llm_call 恰恰是排查「哪一步慢」时最该看的一类。
        """
        event(
            "llm_call",
            agent=agent_key,
            model=model,
            attempt=attempt,
            request_bytes=request_bytes,
            status=status,
            ms=int((time.monotonic() - started) * 1000),
        )


def get_llm_client() -> LlmClient:
    global _client
    if _client is None:
        _client = LlmClient()
    return _client
