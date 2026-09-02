"""通用 Worker 工厂：`AgentProfile + [SkillManifest]` → AgentScope `ReActAgent`。

**一份代码，六个 worker 复用，函数体里没有一个 `if worker == ...`。**
加一个 worker 只需要加一个 YAML 和一份 SKILL.md；改这里的代码说明抽象错了。

system prompt 的拼装顺序：

```
[平台安全层]            ← 不可编辑，随代码发布
[Worker 自身 prompt]    ← agent_configs/<name>.yaml 的 prompt / prompt-file
[各 skill 的 SKILL.md 正文]  ← 按 skills 声明顺序拼接
[系统信息：当前日期、就诊人]
```

安全层放在最前，是因为**顺序即优先级** —— 后面的内容不得覆盖前面的红线。
"""

from __future__ import annotations

from datetime import datetime

from agentscope.agent import ReActAgent
from agentscope.formatter import OpenAIChatFormatter
from agentscope.memory import InMemoryMemory
from agentscope.tool import Toolkit

from ..agents.safety import SAFETY_LAYER
from .agent_loader import AgentProfile
from .settings import build_chat_model
from ..skills import SkillManifest
from .tools import TOOL_REGISTRY

PATIENT_ID_PLACEHOLDER = "<PATIENT_ID>"

WEEKDAY_CN = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]




def _system_prompt(
    profile: AgentProfile,
    manifests: list[SkillManifest],
    *,
    patient_id: str | None,
) -> str:
    parts: list[str] = [SAFETY_LAYER]

    own = profile.resolve_prompt()
    if own:
        parts.append(own)

    parts.extend(m.body for m in manifests)
    body = "\n\n---\n\n".join(parts)

    if any(m.requires_patient_context for m in manifests):
        # 用字符串替换而不是 str.format：正文里的 {} 会被 format 误当占位符
        body = body.replace(PATIENT_ID_PLACEHOLDER, patient_id or "")

    now = datetime.now()
    body += (
        f"\n\n---\n\n# 系统信息\n\n"
        f"当前日期：{now:%Y-%m-%d} {WEEKDAY_CN[now.weekday()]}"
        f"（服务端实时注入，患者说「上周/三天前」时以此换算）\n"
    )
    if patient_id:
        body += f"当前就诊人：`{patient_id}`（工具的 patient_id 参数一律用这个值）\n"
    return body


def _build_toolkit(manifests: list[SkillManifest]) -> Toolkit:
    """工具白名单 = 各 skill 声明的并集，保序去重。

    白名单里出现注册表没有的名字**直接抛错**：打错一个字就等于那个能力悄悄消失，
    而 Agent 看起来一切正常，只是再也不会去查那份数据了。
    """
    wanted: list[str] = []
    for m in manifests:
        for tool in m.all_tools:
            if tool not in wanted:
                wanted.append(tool)

    unknown = [t for t in wanted if t not in TOOL_REGISTRY]
    if unknown:
        raise ValueError(
            f"SKILL.md 声明了未注册的工具：{'、'.join(unknown)}；"
            f"可用：{'、'.join(sorted(TOOL_REGISTRY))}"
        )

    toolkit = Toolkit()
    for name in wanted:
        toolkit.register_tool_function(TOOL_REGISTRY[name])
    return toolkit


def build_worker(
    profile: AgentProfile,
    manifests: list[SkillManifest],
    *,
    patient_id: str | None = None,
) -> ReActAgent:
    """构造一个 worker。六个岗位共用这一份实现。"""
    if not manifests:
        raise ValueError(f"worker {profile.name!r} 未挂载任何 skill")

    return ReActAgent(
        name=profile.display_name or manifests[0].display_name or profile.name,
        sys_prompt=_system_prompt(profile, manifests, patient_id=patient_id),
        model=build_chat_model(
            model_name=profile.model,
            base_url=profile.base_url,
            api_key=profile.resolve_api_key(),
        ),
        formatter=OpenAIChatFormatter(),
        toolkit=_build_toolkit(manifests),
        memory=InMemoryMemory(),
        # 缺省 8 轮：够跑「查患者 → 查检验 → 查检查 → 出结论」这条最长链路，
        # 又不至于在模型钻牛角尖时无限转。
        max_iters=profile.max_iters or 8,
    )
