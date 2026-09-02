"""Agent Skills 加载器：扫描 `skills/`，解析 SKILL.md。

## 为什么它不在 orchestration 里（2026-09-03 从那里搬出来）

SKILL.md 曾经只有编排层用，所以放在 `orchestration/skill_loader.py`。
现在**两条路径都从它取临床提示词** —— 产品路径的六个岗位不再自带
`role_prompt` 字符串，改读 `SkillManifest.clinical_body`。

搬家不是为了好看：留在原地会形成导入环
（`agents.base` → `orchestration` 包 → `master_agent` → `tools` → `agents.risk` → `agents.base`），
因为 `orchestration/__init__` 会把整套编排栈一起拉起来。
环本身是个信号 —— **被两边共用的东西不该住在其中一边**。

格式沿用 agentskills.io 标准（与 `reference/patient-full-stack/patient-agents`
同一套约定），这样两个项目的 skill 可以互相搬运，不必翻译。

标准字段：`name` / `description` / `license` / `compatibility` / `metadata`

本项目在 `metadata` 下的扩展字段：

| 字段 | 含义 |
| --- | --- |
| `display-name` | 中文展示名 |
| `version` | 版本号 |
| `domain` | 领域分类 |
| `tools` | 空格分隔的工具白名单（**进程内函数**，见下） |
| `mcp-tools` | 空格分隔的 MCP 工具白名单（接了 MCP server 后用） |
| `requires-patient-context` | `"true"`/`"false"`，是否注入 `<PATIENT_ID>` |
| `worker-tool-name` | Master Agent 暴露的工具函数名 |

**为什么同时留 `tools` 与 `mcp-tools`**：一期的临床工具是进程内 Python 函数
（数据来自本地 SQLite 与种子档案，没有真实 HIS 接口）。等 HIS 的 MCP server
就位，同名工具从 `tools` 迁到 `mcp-tools` 即可，SKILL.md 正文一个字不用改。
现在就把两个字段都认下来，是为了那次迁移不必改加载器。

正文（frontmatter 之后的 markdown）即该 skill 的 system prompt。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import frontmatter

#: 圈出「只有编排路径用得上」的工具调用段落。见 SkillManifest.clinical_body。
TOOLS_START = "<!--TOOLS:START-->"
TOOLS_END = "<!--TOOLS:END-->"

NAME_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
MAX_NAME_LEN = 64
MAX_DESC_LEN = 1024

SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"


class SkillLoadError(Exception):
    """SKILL.md 解析或校验失败。**一律抛出，不静默跳过** —— 静默跳过会让一个
    本该挂载的 skill 悄悄消失，而 Agent 看起来一切正常，只是不会用那个能力了。"""


@dataclass(frozen=True)
class SkillManifest:
    name: str
    description: str
    body: str
    skill_dir: Path
    license: str | None = None
    compatibility: str | None = None
    display_name: str = ""
    version: str = "1.0"
    domain: str = ""
    tools: list[str] = field(default_factory=list)
    mcp_tools: list[str] = field(default_factory=list)
    requires_patient_context: bool = False
    worker_tool_name: str = ""

    @property
    def clinical_body(self) -> str:
        """
        正文里**与工具无关**的那部分 —— 两条路径共用的临床要求。

        为什么要拆：同一份临床知识以前在两个地方各写一遍 ——
        `agents/<role>.py` 的 `role_prompt`（产品路径在跑）和这里的 SKILL.md
        （编排路径在跑）。**它们已经漂了**：2026-09-03 给风险岗位加的两条
        （依据里的数字不许自己算、阳性检查结论优先）只进了 .py，
        SKILL.md 至今没有 —— 没有任何东西会因此报错。

        不能整份共用，是因为正文里混着工具调用流程（「先调
        `run_hard_rule_risk_scan`」）。产品路径预先装配好上下文、不调工具，
        把这段发给它只会让模型去找不存在的工具。

        所以用 `<!--TOOLS:START-->` / `<!--TOOLS:END-->` 显式圈出工具相关段落：
        编排路径拿全文，产品路径拿这里剩下的部分。**判据是显式标记而不是标题文字** ——
        靠 `# 工作流程` 这种标题去猜，改个措辞就会静默地把临床要求一起吞掉。
        """
        out, skipping = [], False
        for line in self.body.splitlines():
            stripped = line.strip()
            if stripped == TOOLS_START:
                skipping = True
                continue
            if stripped == TOOLS_END:
                skipping = False
                continue
            if not skipping:
                out.append(line)
        return "\n".join(out).strip()

    @property
    def all_tools(self) -> list[str]:
        """工具白名单全集，保序去重。"""
        out: list[str] = []
        for t in [*self.tools, *self.mcp_tools]:
            if t not in out:
                out.append(t)
        return out


def _validate_name(name: str) -> None:
    if not name or len(name) > MAX_NAME_LEN:
        raise SkillLoadError(f"name 长度必须 1-{MAX_NAME_LEN}：{name!r}")
    if not NAME_PATTERN.fullmatch(name):
        raise SkillLoadError(
            f"name 必须为小写字母数字 + 连字符，且不以连字符开头/结尾、不含连续连字符：{name!r}"
        )


def _split_space(value: object) -> list[str]:
    if not value:
        return []
    return [s.strip() for s in str(value).split() if s.strip()]


def _as_bool(value: object) -> bool:
    return str(value).strip().lower() in {"true", "1", "yes"}


def load_skill(skill_dir: Path) -> SkillManifest:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        raise SkillLoadError(f"未找到 SKILL.md：{skill_md}")

    post = frontmatter.load(skill_md)
    fm = post.metadata
    body = post.content.strip()

    name = fm.get("name")
    description = fm.get("description")
    if not isinstance(name, str) or not name:
        raise SkillLoadError(f"{skill_md}：缺少必填字段 name")
    if not isinstance(description, str) or not description:
        raise SkillLoadError(f"{skill_md}：缺少必填字段 description")
    if len(description) > MAX_DESC_LEN:
        raise SkillLoadError(f"{skill_md}：description 超过 {MAX_DESC_LEN} 字")
    _validate_name(name)
    if name != skill_dir.name:
        raise SkillLoadError(f"{skill_md}：name（{name}）必须与目录名（{skill_dir.name}）一致")
    if not body:
        raise SkillLoadError(f"{skill_md}：正文为空 —— 正文就是这个 skill 的 system prompt")

    meta = fm.get("metadata") or {}
    if not isinstance(meta, dict):
        raise SkillLoadError(f"{skill_md}：metadata 必须是映射")

    return SkillManifest(
        name=name,
        description=description,
        body=body,
        skill_dir=skill_dir,
        license=fm.get("license"),
        compatibility=fm.get("compatibility"),
        display_name=str(meta.get("display-name") or ""),
        version=str(meta.get("version") or "1.0"),
        domain=str(meta.get("domain") or ""),
        tools=_split_space(meta.get("tools")),
        mcp_tools=_split_space(meta.get("mcp-tools")),
        requires_patient_context=_as_bool(meta.get("requires-patient-context")),
        worker_tool_name=str(meta.get("worker-tool-name") or ""),
    )


def load_all_skills(skills_dir: Path | None = None) -> dict[str, SkillManifest]:
    """加载全部 skill，按目录名排序保证顺序稳定。"""
    root = skills_dir or SKILLS_DIR
    if not root.exists():
        raise SkillLoadError(f"skills 目录不存在：{root}")
    out: dict[str, SkillManifest] = {}
    for path in sorted(p for p in root.iterdir() if p.is_dir()):
        if not (path / "SKILL.md").exists():
            continue
        manifest = load_skill(path)
        out[manifest.name] = manifest
    if not out:
        raise SkillLoadError(f"{root} 下没有任何 skill")
    return out
