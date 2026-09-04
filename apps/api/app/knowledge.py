"""
临床知识库：镜像里的内置词条 + 库里的本院词条，读取时合并。

## 为什么是这个模型

容器是 `read_only: true`，只有 `/opt/doctor-agent/data` 这一个卷可写。
新增/编辑的词条写进镜像里的 JSON **一次部署就没了**，所以只能进库。

于是：**内置的是文件**（随版本更新的只读事实），**本院的进库**
（跟着数据卷活下来），同 key 以库为准。好处是升级不丢本院内容 ——
两边互不覆盖。

## 为什么删除是软删

内置词条真删不掉（文件在只读镜像里）。但医生说「这条不对，别再让模型查它」
是个合理诉求，所以在库里写一条**墓碑**（`deleted=True`），读取时跳过。
硬删一行做不到这件事 —— 那样只能删本院自己加的。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import KnowledgeEntry

_KB_PATH = Path(__file__).resolve().parent / "data/knowledge_base.json"

#: 正文允许的标签。**白名单，不是黑名单** —— 黑名单永远漏，
#: 而这里能出的漏洞是「医生打开词条时执行了别人写的脚本」。
_ALLOWED_TAGS = {
    "p", "br", "h3", "h4", "strong", "em", "b", "i", "u", "code",
    "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "span", "div",
}
_TAG = re.compile(r"</?\s*([a-zA-Z0-9]+)([^>]*)>")
#: 事件处理器属性与伪协议 —— 白名单标签上照样能挂脚本
_ATTR = re.compile(r"\s(on\w+|href|src|style|formaction|xlink:href)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)


def sanitize(html: str) -> str:
    """
    正文消毒。

    **这条以前不需要，现在需要了。** 原来的注释写着「正文由本仓库静态提供、
    无用户输入参与拼接，因此前端 v-html 渲染是安全的，内容变更走代码评审」——
    那个前提在正文可上传可编辑之后就不成立了。而 `/admin` 目前无登录，
    等于给了任何人一个往医生浏览器里注入脚本的口子。

    做法是**标签白名单 + 属性剥离**：
    - 不在白名单里的标签整个转义掉（不是删掉 —— 让人看得见自己写了什么）
    - 白名单标签上的 `on*` / `href` / `src` / `style` 一律剥掉，
      光有白名单不够：`<span onclick=...>` 里的 span 是合法的

    刻意不引入 HTML 解析库：多一个依赖就多一份供应链面，
    而这里要的只是「把尖括号里的东西管住」。
    """
    if not html:
        return ""

    def repl(m: re.Match) -> str:
        tag = m.group(1).lower()
        if tag not in _ALLOWED_TAGS:
            # 转义而不是删除：写的人要能看见自己那段被挡下来了
            return m.group(0).replace("<", "&lt;").replace(">", "&gt;")
        closing = m.group(0).lstrip().startswith("</")
        if closing:
            return f"</{tag}>"
        attrs = _ATTR.sub("", " " + (m.group(2) or "").strip())
        return f"<{tag}{attrs.rstrip()}>".replace("  ", " ")

    return _TAG.sub(repl, html)


def builtin() -> dict:
    """镜像里的内置词条。"""
    return json.loads(_KB_PATH.read_text(encoding="utf-8"))


def merged(session: Session) -> dict:
    """内置 + 本院，同 key 以库为准，墓碑跳过。"""
    out = {k: {**v, "source": "builtin"} for k, v in builtin().items()}
    for row in session.scalars(select(KnowledgeEntry)).all():
        if row.deleted:
            out.pop(row.key, None)
            continue
        out[row.key] = {
            "title": row.title,
            "content": row.content,
            "keywords": list(row.keywords or []),
            "source": "local",
        }
    return out


def upsert(session: Session, key: str, title: str, keywords: list[str], content: str) -> KnowledgeEntry:
    row = session.get(KnowledgeEntry, key)
    if row is None:
        row = KnowledgeEntry(key=key)
        session.add(row)
    row.title = title
    row.keywords = [k.strip() for k in keywords if str(k).strip()]
    row.content = sanitize(content)
    row.deleted = False          # 覆盖会把墓碑一并抹掉 —— 「删了又加回来」要能生效
    return row


def remove(session: Session, key: str) -> bool:
    """软删。内置词条也能删 —— 在库里写墓碑，读取时跳过。"""
    if key not in merged(session):
        return False
    row = session.get(KnowledgeEntry, key)
    if row is None:
        row = KnowledgeEntry(key=key, title="", keywords=[], content="")
        session.add(row)
    row.deleted = True
    return True


def validate_import(raw: object) -> list[str]:
    """批量导入前校验，返回逐条问题。空列表 = 可以入库。

    和测试集同一条原则：**全对才收**。一半词条入库、一半报错，
    使用者无从知道究竟进去了哪些。
    """
    errs: list[str] = []
    if not isinstance(raw, dict):
        return ["顶层必须是一个 JSON 对象：{ 词条key: { title, keywords, content } }"]
    if not raw:
        return ["没有任何词条"]
    for key, v in raw.items():
        if not isinstance(v, dict):
            errs.append(f'"{key}" 必须是对象')
            continue
        if not str(v.get("title") or "").strip():
            errs.append(f'"{key}" 缺 title')
        kw = v.get("keywords")
        if not isinstance(kw, list) or not kw:
            errs.append(f'"{key}" 的 keywords 必须是非空数组 —— 没有关键词就永远匹配不上')
        if not str(v.get("content") or "").strip():
            errs.append(f'"{key}" 正文为空 —— 空词条对模型没有任何用处')
    return errs
