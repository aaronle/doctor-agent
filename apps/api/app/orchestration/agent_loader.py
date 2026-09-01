"""Agent 定义加载器：解析 `agent_configs/*.yaml`。

三层结构，与用户定的一致：

```
Master Agent（医生本人：性格 / 记忆 / 规则）
   └── Worker（一期的六个岗位）
          └── Skill（SKILL.md，正文即 system prompt）
                 └── Tool（进程内临床工具 / 将来的 MCP 工具）
```

**Master 是医生，不是路由器。** 参考项目里那一层叫 router，只做分发；这里它有
自己的人格、记忆与红线 —— 它是"这位医生"，workers 是他手下的专科助手。
所以 `agent_configs/doctor.yaml` 里有 persona 与 rules，而不只是分发规则。

**Agent 集合是静态注册的，不做运行时动态发现。** 想加一个 worker 就加一个 YAML，
不必改代码；但"有哪些 worker"必须是可审阅的清单，而不是扫目录扫出来的惊喜 ——
临床系统里"多出一个会说话的智能体"是需要有人签字的事。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

CONFIG_DIR = Path(__file__).resolve().parents[2] / "agent_configs"


class AgentConfigError(Exception):
    """YAML 解析或校验失败。同样一律抛出，不静默跳过。"""


@dataclass(frozen=True)
class AgentProfile:
    """一个 Agent 的完整定义。除 name 外均可缺省，回退全局配置。"""

    name: str
    config_dir: Path
    #: 空 = Master Agent（医生本人）；非空 = Worker
    skills: tuple[str, ...] = ()
    display_name: str = ""
    description: str = ""
    worker_tool_name: str = ""
    prompt: str | None = None
    prompt_file: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key_env: str | None = None
    max_iters: int | None = None
    #: Master 专用：worker 的调用顺序建议，写进 Master 的 prompt
    workflow: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_master(self) -> bool:
        return not self.skills

    def resolve_worker_tool_name(self) -> str:
        return self.worker_tool_name or f"call_{self.name.replace('-', '_')}"

    def resolve_prompt(self) -> str | None:
        """该 Agent 显式定义的 prompt 文本（内联或文件）；未定义返回 None。"""
        if self.prompt is not None:
            return self.prompt
        if self.prompt_file:
            path = (self.config_dir / self.prompt_file).resolve()
            if not path.exists():
                raise AgentConfigError(f"{self.name}：prompt-file 不存在 {path}")
            return path.read_text(encoding="utf-8").strip()
        return None

    def resolve_api_key(self) -> str | None:
        return os.environ.get(self.api_key_env) if self.api_key_env else None


def _as_tuple(value: object) -> tuple[str, ...]:
    if not value:
        return ()
    if isinstance(value, str):
        return tuple(s.strip() for s in value.split() if s.strip())
    if isinstance(value, list):
        return tuple(str(v).strip() for v in value if str(v).strip())
    raise AgentConfigError(f"期望字符串或列表，得到 {type(value).__name__}")


def load_agent(path: Path) -> AgentProfile:
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise AgentConfigError(f"{path}：顶层必须是映射")

    name = raw.get("name")
    if not isinstance(name, str) or not name:
        raise AgentConfigError(f"{path}：缺少必填字段 name")
    if name != path.stem:
        raise AgentConfigError(f"{path}：name（{name}）必须与文件名（{path.stem}）一致")

    if raw.get("prompt") is not None and raw.get("prompt-file"):
        raise AgentConfigError(f"{path}：prompt 与 prompt-file 互斥，只能有一个")

    return AgentProfile(
        name=name,
        config_dir=path.parent,
        skills=_as_tuple(raw.get("skills")),
        display_name=str(raw.get("display-name") or ""),
        description=str(raw.get("description") or ""),
        worker_tool_name=str(raw.get("worker-tool-name") or ""),
        prompt=raw.get("prompt"),
        prompt_file=raw.get("prompt-file"),
        model=raw.get("model"),
        base_url=raw.get("base-url"),
        api_key_env=raw.get("api-key-env"),
        max_iters=raw.get("max-iters"),
        workflow=_as_tuple(raw.get("workflow")),
    )


def load_all_agents(config_dir: Path | None = None) -> tuple[AgentProfile, dict[str, AgentProfile]]:
    """返回 `(master, workers)`。没有 master 或有多个 master 都视为配置错误。"""
    root = config_dir or CONFIG_DIR
    if not root.exists():
        raise AgentConfigError(f"agent_configs 目录不存在：{root}")

    masters: list[AgentProfile] = []
    workers: dict[str, AgentProfile] = {}
    for path in sorted(root.glob("*.yaml")):
        profile = load_agent(path)
        if profile.is_master:
            masters.append(profile)
        else:
            workers[profile.name] = profile

    if len(masters) != 1:
        names = [m.name for m in masters] or ["（无）"]
        raise AgentConfigError(f"必须且只能有一个 Master Agent（skills 为空的那个），当前：{names}")
    if not workers:
        raise AgentConfigError(f"{root} 下没有任何 worker")
    return masters[0], workers
