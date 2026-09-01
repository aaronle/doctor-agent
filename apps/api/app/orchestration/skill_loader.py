"""Agent Skills 加载器：扫描 `skills/`，解析 SKILL.md。

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

NAME_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
MAX_NAME_LEN = 64
MAX_DESC_LEN = 1024

SKILLS_DIR = Path(__file__).resolve().parents[2] / "skills"


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
