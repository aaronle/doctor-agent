"""
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

# 仅这两类错误值得重试：限流与网关侧故障。4xx 参数错误重试只会重复失败。
RETRYABLE_STATUS = {429, 500, 502, 503, 504}

# 退避比 Ticket System 的 500/1500 更长：这里一次首屏会并发发四个岗位的请求，
# 网关一次瞬时 502 就会同时打掉四个、整页降级。实测并发本身没问题，
# 是抖动窗口比 2 秒重试窗口长，因此把总重试窗口拉到约 6 秒。
BACKOFF_MS = (500, 1500, 4000)
MAX_ATTEMPTS = len(BACKOFF_MS) + 1

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

    async def complete_json(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        agent_key: str = "",
    ) -> LlmResult:
        """调用模型并返回解析后的 JSON 对象。失败抛 LlmError，由调用方降级。"""
        if not self.configured:
            raise LlmError("模型通道未配置")

        target_model = model or self.settings.fast_model
        body = self._body(messages, model=target_model, json_mode=True, stream=False)
        payload = json.dumps(body, ensure_ascii=False)
        started = time.monotonic()

        last_error: str = ""
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                async with httpx.AsyncClient(timeout=self.settings.timeout_seconds) as client:
                    response = await client.post(
                        f"{self.settings.base_url}/chat/completions",
                        headers=self._headers(),
                        content=payload.encode("utf-8"),
                    )
                if response.status_code in RETRYABLE_STATUS:
                    last_error = f"HTTP {response.status_code}"
                    raise _Retry()
                if response.status_code >= 400:
                    # **不在白名单里的 4xx 直接失败，不重试。**
                    #
                    # 早先这里只有 raise_for_status()，抛出的 HTTPStatusError 落进下面
                    # 那个通用 `except httpx.HTTPError`，于是 400 照样退避重试四次 ——
                    # 上面白名单写的「4xx 参数错误重试只会重复失败」被下面的处理器架空了。
                    # 2026-09-02 换模型时三个岗位各白等 8 秒才降级，就是这个原因。
                    #
                    # 而且要**带上网关的原话**。只报一句 HTTPStatusError 什么线索都没有；
                    # 网关其实明说了 `temperature is deprecated for this model`。
                    detail = response.text[:200].replace("\n", " ")
                    last_error = f"HTTP {response.status_code}"
                    self._log(agent_key, target_model, attempt, len(payload), last_error, started)
                    raise LlmError(f"模型通道拒绝请求（HTTP {response.status_code}，不重试）：{detail}")
                response.raise_for_status()
                data = response.json()
            except _Retry:
                self._log(agent_key, target_model, attempt, len(payload), last_error, started)
                if attempt < MAX_ATTEMPTS:
                    await asyncio.sleep(BACKOFF_MS[attempt - 1] / 1000)
                    continue
                raise LlmError(f"模型通道重试 {MAX_ATTEMPTS} 次仍失败：{last_error}") from None
            except httpx.HTTPError as exc:
                last_error = type(exc).__name__
                self._log(agent_key, target_model, attempt, len(payload), last_error, started)
                if attempt < MAX_ATTEMPTS:
                    await asyncio.sleep(BACKOFF_MS[attempt - 1] / 1000)
                    continue
                raise LlmError(f"模型通道请求失败：{last_error}") from exc

            text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            usage = data.get("usage") or {}

            # 解析失败时**带着纠错提示重问**，而不是去修补那串坏 JSON。
            #
            # 不能原样重发：temperature 固定为 0，同一请求必然得到同一份坏输出，
            # 重试纯属浪费调用与时间。把上一轮的坏输出和错误原因回灌进去，
            # 请求变了，模型才有机会改对。
            #
            # 也不做猜测性修补 —— 半截 JSON 补全后会变成一份看起来正常、
            # 实则残缺的临床结论，这比降级到本地规则危险得多。
            try:
                parsed = extract_json_object(text)
            except LlmError as exc:
                self._log(agent_key, target_model, attempt, len(payload), "bad-json", started)
                if attempt < MAX_ATTEMPTS:
                    body["messages"] = [
                        *body["messages"],
                        {"role": "assistant", "content": text[:2000]},
                        {
                            "role": "user",
                            "content": (
                                f"上面的输出不是合法 JSON（{exc}）。"
                                "最常见的原因是字符串值内部出现了半角双引号 \" —— 引用原文请改用中文引号「」。"
                                "请重新输出一次完整且合法的 JSON 对象，内容不变，只修正格式。"
                            ),
                        },
                    ]
                    payload = json.dumps(body, ensure_ascii=False)
                    await asyncio.sleep(BACKOFF_MS[attempt - 1] / 1000)
                    continue
                raise LlmError(f"模型连续返回不可解析的 JSON：{exc}", raw_excerpt=text) from exc

            elapsed_ms = int((time.monotonic() - started) * 1000)
            self._log(agent_key, target_model, attempt, len(payload), "ok", started)
            return LlmResult(
                data=parsed,
                model=target_model,
                elapsed_ms=elapsed_ms,
                prompt_tokens=int(usage.get("prompt_tokens") or 0),
                completion_tokens=int(usage.get("completion_tokens") or 0),
                total_tokens=int(usage.get("total_tokens") or 0),
                request_bytes=len(payload),
                raw_text=text,
            )

        raise LlmError("模型通道不可用")

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


class _Retry(Exception):
    """内部信号：本次响应属于可重试状态码。"""


def extract_json_object(text: str) -> dict:
    """
    从模型输出里取出第一个完整 JSON 对象。

    只做两件事：剥 Markdown 围栏、按括号深度扫描配对。
    刻意不做猜测性修补 —— 截断或非对象一律报错，
    宁可降级到本地规则，也不让半截 JSON 变成看起来正常的临床结论。
    """
    if not text:
        raise LlmError("模型返回为空")

    body = text.strip()
    if body.startswith("```"):
        body = body.split("\n", 1)[1] if "\n" in body else ""
        if body.rstrip().endswith("```"):
            body = body.rstrip()[:-3]
        body = body.strip()

    start = body.find("{")
    if start == -1:
        raise LlmError("模型返回中没有 JSON 对象")

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(body)):
        char = body[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(body[start : index + 1])
                except json.JSONDecodeError as exc:
                    raise LlmError(f"模型返回的 JSON 无法解析：{exc.msg}") from exc

    raise LlmError("模型返回的 JSON 不完整（括号未闭合）")


_client: LlmClient | None = None


def get_llm_client() -> LlmClient:
    global _client
    if _client is None:
        _client = LlmClient()
    return _client
