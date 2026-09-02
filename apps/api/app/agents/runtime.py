"""岗位运行时：一次结构化生成。

## 它取代了什么

在此之前，六个岗位走 `app/llm.py` 的 `complete_json`：手写 httpx 客户端、
手写重试退避、手写 token 记账，以及 `extract_json_object` —— 一个从模型
自由文本里**抠 JSON 出来**的函数。为了让那个函数有活路，安全层里还长出了
两条规矩：「只输出 JSON 对象本身」和「字符串内不得出现半角双引号」。

第二条不是洁癖，是真事故：未转义的半角引号会截断 JSON 字符串，
整份输出解析失败被丢弃，而日志里什么都看不到。

**这一整条链路的存在，是因为「让模型输出 JSON」被当成了一个措辞问题。**
它不是。用工具调用的参数 schema 去约束，输出形状由协议保证，
不再需要恳求模型配合，也就不需要抠、不需要那两条规矩。

## 为什么是工具调用，不是 `response_format`

AgentScope 的 `OpenAIChatModel` 支持 `structured_model=` 参数，走的是 OpenAI 的
`chat.completions.parse`（`response_format: json_schema`）。**本项目的第三方网关
不支持它** —— 实测会原样返回自然语言，然后在 Pydantic 那里炸成
`Invalid JSON: expected value at line 1 column 1`。

而**工具调用网关是支持的**。所以这里显式构造一个「提交结果」工具，
把 Pydantic schema 作为它的参数表，再用 `tool_choice="required"` 逼模型调它。
这也正是 `ReActAgent` 内部实现结构化输出的办法。

不直接用 `ReActAgent` 的原因是它只回一个 `Msg`，**token 用量拿不到** ——
而控制台的成本显示和 `agent_runs` 的记账都依赖它。这里直接调模型层，
`ChatResponse.usage` 就在手上。岗位本身也没有工具要调（上下文是预先装配好的），
套一层 ReAct 循环只是徒增一轮开销。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from agentscope.formatter import OpenAIChatFormatter
from agentscope.message import Msg
from pydantic import BaseModel, ValidationError

from ..model_gateway import build_chat_model

#: 提交结果的工具名。模型只会调这一个，名字对使用者不可见。
SUBMIT_TOOL = "submit_result"


class GenerationError(RuntimeError):
    """一次结构化生成失败。调用方据此降级到本地规则。"""

    def __init__(self, message: str, *, raw_excerpt: str = "") -> None:
        super().__init__(message)
        #: 失败时留一段模型原文，便于定位「它到底说了什么」。
        #: 成功的输出不留 —— 那会让日志变成病历副本。
        self.raw_excerpt = raw_excerpt


@dataclass
class Generation:
    data: dict
    model: str
    elapsed_ms: int
    prompt_tokens: int
    completion_tokens: int

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


def _tool_schema(output_model: type[BaseModel]) -> dict:
    """Pydantic 模型 → 工具参数 schema。

    `$defs` 会原样带过去 —— 嵌套模型（如病历七段、共病条目）靠它引用，
    剥掉的话模型收到的是一堆无法解析的 `$ref`。
    """
    return {
        "type": "function",
        "function": {
            "name": SUBMIT_TOOL,
            "description": "提交本次生成的结构化结果。所有字段都必须填写。",
            "parameters": output_model.model_json_schema(),
        },
    }


async def generate(
    *,
    system: str,
    user: str,
    output_model: type[BaseModel],
    model_name: str,
) -> Generation:
    """跑一次结构化生成。失败一律抛 `GenerationError`。"""
    model = build_chat_model(model_name=model_name)
    formatter = OpenAIChatFormatter()
    messages = await formatter.format(
        [Msg("system", system, "system"), Msg("user", user, "user")]
    )

    started = time.perf_counter()
    try:
        response = await model(
            messages,
            tools=[_tool_schema(output_model)],
            tool_choice="required",
        )
    except Exception as exc:  # 网关错误、超时、鉴权失败
        raise GenerationError(f"{type(exc).__name__}: {exc}") from exc
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    calls = [b for b in (response.content or []) if b.get("type") == "tool_use"]
    if not calls:
        # 模型没调工具而是直接说了话。**必须当失败处理** ——
        # 拿一段自然语言去填结构化字段，界面上会显示成一份内容错位的病历。
        text = "".join(
            str(b.get("text") or "") for b in (response.content or []) if b.get("type") == "text"
        )
        raise GenerationError("模型未按结构化格式作答", raw_excerpt=text[:500])

    payload: Any = calls[0].get("input")
    if not isinstance(payload, dict):
        raise GenerationError(f"工具入参不是对象：{type(payload).__name__}", raw_excerpt=str(payload)[:500])

    try:
        # **用 Pydantic 再校验一次。** schema 约束的是模型「应该」怎么填，
        # 而网关与模型都可能少给一个必填字段。这一步把「形状不对」
        # 在进入业务代码之前拦下来，异常信息也直接指出是哪个字段。
        validated = output_model.model_validate(payload)
    except ValidationError as exc:
        raise GenerationError(f"结构化输出不合 schema：{exc}", raw_excerpt=str(payload)[:500]) from exc

    usage = response.usage
    return Generation(
        data=validated.model_dump(),
        model=model_name,
        elapsed_ms=elapsed_ms,
        prompt_tokens=getattr(usage, "input_tokens", 0) or 0,
        completion_tokens=getattr(usage, "output_tokens", 0) or 0,
    )
