"""
Agent 运行时配置解析。

配置从代码里提出来：运行时读**已发布**的 AgentVersion，读不到才回落代码默认值。
这样调 Prompt、换模型档位、改阈值都不用发版，也让每次运行能记录到底用的哪一版。

平台安全层刻意**不**放进可配置范围 —— 它只能随代码发布。管理员能编辑的只有
岗位层 Prompt；安全层若可编辑，「不得自行确诊」这类红线就成了摆设。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_ai_settings
from .models import AgentVersion

# 模型档位是稳定别名。业务代码只认档位，不认具体模型名 ——
# 换 Haiku 版本或接院内模型时，医生端调用协议不动。
MODEL_TIERS: dict[str, str] = {
    "clinical_fast": "fast",
    "clinical_reasoning": "fast",
    "clinical_safety": "fast",
}

TIER_LABELS = {
    "clinical_fast": "快速档 · 短上下文结构化输出",
    "clinical_reasoning": "推理档 · 鉴别诊断与共病",
    "clinical_safety": "安全档 · 配合平台硬规则",
}


def resolve_model(tier: str) -> str:
    """把档位别名解析成实际 Model ID。未知档位一律回落 fast，不猜。"""
    ai = get_ai_settings()
    slot = MODEL_TIERS.get(tier, "fast")
    return ai.smart_model if slot == "smart" else ai.fast_model


@dataclass
class ResolvedConfig:
    agent_key: str
    version: str
    model_tier: str
    model: str
    role_prompt: str
    params: dict
    source: str  # published | code-default


def published_version(session: Session, agent_key: str) -> AgentVersion | None:
    return session.scalar(
        select(AgentVersion)
        .where(AgentVersion.agent_key == agent_key, AgentVersion.status == "published")
        .order_by(AgentVersion.published_at.desc())
        .limit(1)
    )


def resolve(session: Session, agent) -> ResolvedConfig:
    """解析某个岗位的生效配置。没有已发布版本时回落代码默认值。"""
    row = published_version(session, agent.key)
    if row is None:
        return ResolvedConfig(
            agent_key=agent.key,
            version=agent.version,
            model_tier="clinical_fast",
            model=resolve_model("clinical_fast"),
            role_prompt=agent.role_prompt,
            params={},
            source="code-default",
        )
    return ResolvedConfig(
        agent_key=row.agent_key,
        version=row.version,
        model_tier=row.model_tier,
        model=row.model or resolve_model(row.model_tier),
        role_prompt=row.role_prompt or agent.role_prompt,
        params=row.params or {},
        source="published",
    )


def prompt_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
