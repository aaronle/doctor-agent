"""Doctor Agent 编排层：Master（医生本人）→ Worker（六个岗位）→ Skill → Tool。

三层的分工：

- **Master**（`agent_configs/doctor.yaml`）：医生本人。有人格、记忆、执业规则；
  决定叫哪个助手、要不要采纳。它**不是**路由器。
- **Worker**（`agent_configs/<name>.yaml`）：一期的六个岗位。一份通用工厂组装，
  代码里没有 if/elif —— 加一个 worker 只需加一个 YAML + 一份 SKILL.md。
- **Skill**（`skills/<name>/SKILL.md`）：正文即 system prompt。格式沿用
  agentskills.io 标准，与参考项目同一套约定，skill 可以互相搬运。
- **Tool**（`orchestration/tools.py`）：进程内临床工具。一期没有真实 HIS 接口，
  数据来自本地 SQLite 与种子档案；每个工具的 docstring 标了【真实】/【规则】/【Mock】。
"""

from .agent_loader import AgentConfigError, AgentProfile, load_all_agents
from .master_agent import build_master
from .settings import DEFAULT_MODEL, model_is_configured
from ..skills import SkillLoadError, SkillManifest, load_all_skills
from .tools import TOOL_REGISTRY
from .worker_factory import SAFETY_LAYER, build_worker

__all__ = [
    "AgentConfigError", "AgentProfile", "load_all_agents",
    "SkillLoadError", "SkillManifest", "load_all_skills",
    "TOOL_REGISTRY", "SAFETY_LAYER", "build_worker", "build_master",
    "DEFAULT_MODEL", "model_is_configured",
]
