"""Master Agent —— 医生本人。

**它不是路由器。** 参考实现里那一层只做意图分发；这里它有自己的人格、记忆与
执业规则，workers 是他手下的专科助手。区别体现在三处：

1. **有记忆。** `InMemoryMemory` 按 session 保留，医生能记住这一场就诊里
   前面说过什么、已经让哪个 worker 做过什么。
2. **有规则。** `agent_configs/prompts/doctor-persona.md` 写的是执业口径
   （怎么问、什么时候必须转诊、什么话不能说），不是分发规则。
3. **有取舍。** worker 的回答对他是**建议**，不是结论；他可以不采纳，
   也可以要求补查。prompt 里明确要求他对冲突信息作出判断而不是并列转述。

## 为什么 worker 包成工具而不是流水线

医生看诊不是固定流程。同一个主诉，有人先问诊再看检验，有人先看危急值再决定
问什么。把 worker 做成可调用的工具、由 Master 决定叫谁，比写死顺序更贴近真实 ——
但**顺序建议**仍写进 prompt（`workflow` 字段），避免它每次都从头摸索。
"""

from __future__ import annotations

from agentscope.agent import ReActAgent
from agentscope.formatter import OpenAIChatFormatter
from agentscope.memory import InMemoryMemory
from agentscope.message import Msg, TextBlock
from agentscope.tool import Toolkit, ToolResponse

from ..obs import event
from .agent_loader import AgentProfile, load_all_agents
from .settings import build_chat_model
from ..skills import SkillManifest, load_all_skills
from .worker_factory import SAFETY_LAYER, build_worker


def _wrap_worker_as_tool(worker: ReActAgent, *, tool_name: str, description: str, worker_key: str):
    """把一个 worker 包成 Master 可调用的 async 工具。"""

    async def _tool(task: str, context: str = "") -> ToolResponse:
        composed = task if not context else f"{task}\n\n[主诊医生补充的上下文]\n{context}"
        try:
            reply: Msg = await worker(Msg("主诊医生", composed, "user"))
            text = reply.get_text_content() or str(reply.content)
            event("worker_done", worker=worker_key, chars=len(text))
        except Exception as exc:
            # 失败要如实报回去，让 Master 知道这一步没成 ——
            # 静默返回空串会让它以为「查过了，没发现」，那是最坏的一种失败。
            event("worker_failed", worker=worker_key, error=f"{type(exc).__name__}: {exc}")
            text = f"[{worker_key} 执行失败：{type(exc).__name__}: {exc}] 这一项没有结果，不要当作「已查过且无异常」。"
        return ToolResponse(content=[TextBlock(type="text", text=text)])

    _tool.__name__ = tool_name
    _tool.__doc__ = (
        f"{description}\n\n"
        "Args:\n"
        "    task: 交给这个助手的具体任务。**用你自己的临床语言说清要什么**，"
        "不要只转述患者原话。\n"
        "    context: 你已经掌握、对方需要知道的上下文（可选）。"
    )
    return _tool


def _master_prompt(
    profile: AgentProfile,
    entries: list[tuple[str, str, str]],
    *,
    patient_id: str | None,
) -> str:
    parts: list[str] = [SAFETY_LAYER]

    own = profile.resolve_prompt()
    if own:
        parts.append(own)

    roster = "\n".join(f"- `{tool}`（{display}）：{desc}" for tool, display, desc in entries)
    parts.append(f"# 你的专科助手\n\n{roster}")

    if profile.workflow:
        order = " → ".join(profile.workflow)
        parts.append(
            "# 常规顺序（建议，不是死规矩）\n\n"
            f"{order}\n\n"
            "看诊不是固定流程：危急值优先、患者不配合时跳过问诊、复诊直接看趋势，"
            "都由你判断。但**不要在没有依据时凭空跳步**。"
        )

    parts.append(
        "# 你怎么用这些助手\n\n"
        "1. 助手的回答对你是**建议**，不是结论。你可以不采纳，也可以要求补查。\n"
        "2. 助手之间给出**冲突信息**时，你要作出判断并说明理由，"
        "而不是把两种说法并列丢给使用者。\n"
        "3. 不要复述助手的完整输出 —— 它已经展示过了。你只补上判断、取舍与下一步。\n"
        "4. 同一个助手不要就同一件事反复调用。"
    )

    if patient_id:
        parts.append(f"# 本次就诊\n\n就诊人：`{patient_id}`。转派任务时把这个 ID 带给助手。")

    return "\n\n---\n\n".join(parts)


async def build_master(
    *,
    patient_id: str | None = None,
    only_workers: list[str] | None = None,
) -> ReActAgent:
    """装配 Master + 全部 worker。

    Args:
        patient_id: 本次就诊的就诊人 ID，注入 Master 与各 worker 的 prompt。
        only_workers: 只装这几个 worker（给单岗位试运行与回归集用）。
    """
    master_profile, worker_profiles = load_all_agents()
    skills = load_all_skills()

    toolkit = Toolkit()
    entries: list[tuple[str, str, str]] = []
    workers: dict[str, ReActAgent] = {}

    for name, profile in worker_profiles.items():
        if only_workers and name not in only_workers:
            continue
        manifests: list[SkillManifest] = []
        for skill_name in profile.skills:
            if skill_name not in skills:
                raise ValueError(f"worker {name!r} 声明了不存在的 skill：{skill_name!r}")
            manifests.append(skills[skill_name])

        worker = build_worker(profile, manifests, patient_id=patient_id)
        workers[name] = worker

        tool_name = profile.resolve_worker_tool_name()
        description = profile.description or manifests[0].description
        display = profile.display_name or manifests[0].display_name or name
        entries.append((tool_name, display, description))
        toolkit.register_tool_function(
            _wrap_worker_as_tool(worker, tool_name=tool_name, description=description, worker_key=name)
        )

    master = ReActAgent(
        name=master_profile.display_name or "主诊医生",
        sys_prompt=_master_prompt(master_profile, entries, patient_id=patient_id),
        model=build_chat_model(
            model_name=master_profile.model,
            base_url=master_profile.base_url,
            api_key=master_profile.resolve_api_key(),
        ),
        formatter=OpenAIChatFormatter(),
        toolkit=toolkit,
        # Master 有记忆：他要记住这一场就诊里已经让谁做过什么
        memory=InMemoryMemory(),
        max_iters=master_profile.max_iters or 12,
    )
    # 暴露给上层：单独驱动某个 worker（试运行、回归集）时不必再装一次
    master.workers = workers  # type: ignore[attr-defined]
    master.worker_tool_names = {t for t, _d, _x in entries}  # type: ignore[attr-defined]
    return master
