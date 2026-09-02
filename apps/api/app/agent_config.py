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
# 换模型或接院内模型时，医生端调用协议不动。
#
# **2026-09-02：三个档位真正分开了。** 在此之前它们全都指向同一个槽，
# 三个名字一个模型 —— 抽象在，但没起任何作用。
#
# 每个档位一个环境变量，未配置时回落到下面的缺省。不再复用 fast/smart
# 两个槽：那两个槽是给「快/慢」这种二分用的，而档位表达的是**岗位性质**，
# 两者不是一回事，硬挤在一起就是现在这种「三选一实际只有二选一」。
DEFAULT_TIER_MODELS: dict[str, str] = {
    # 短上下文、结构化转写。record 实测 Haiku 5.0s / Sonnet 45.8s，
    # 而回归集两边都是 10/10 —— 花 40 秒买不到任何东西。
    "clinical_fast": "claude-haiku-4-5-20251001",
    # 要串证据、下结论、标依据。没有 A/B 数据，留在能力更强的一侧。
    "clinical_reasoning": "claude-sonnet-5",
    # 配合平台硬规则，漏报有临床后果。同样没有足够用例，不动。
    "clinical_safety": "claude-sonnet-5",
}

TIER_ENV = {
    "clinical_fast": "AI_MODEL_CLINICAL_FAST",
    "clinical_reasoning": "AI_MODEL_CLINICAL_REASONING",
    "clinical_safety": "AI_MODEL_CLINICAL_SAFETY",
}

TIER_LABELS = {
    "clinical_fast": "快速档 · 短上下文结构化输出",
    "clinical_reasoning": "推理档 · 鉴别诊断与共病",
    "clinical_safety": "安全档 · 配合平台硬规则",
}

#: 未知档位回落到哪一档。**回落到能力更强的一侧，不回落到快的那一侧** ——
#: 档位名打错时，宁可慢一点，也不要把一个临床岗位悄悄降级。
FALLBACK_TIER = "clinical_reasoning"


#: 应急整体覆盖：三档一起换。用于「先全切回某个模型再说」那种时刻。
ALL_TIERS_ENV = "AI_MODEL_ALL_TIERS"


def resolve_model(tier: str) -> str:
    """
    把档位别名解析成实际 Model ID。

    **`AI_FAST_MODEL` 在这里不起作用，这是有意的。**

    它在生产 env 里被设成了 sonnet（2026-09-02 换模型时加的）。如果让它
    参与档位解析，档位拆分会被它整体盖掉 —— 代码里三档分开、线上三档一样，
    而且不报错。这个项目已经因为「env 盖住代码缺省」栽过一次
    （产品路径以为换了 Sonnet，实际一直在跑 Haiku）。

    `AI_FAST_MODEL` 保留原义：**给不走档位的那些调用用**（Copilot 对话等）。
    岗位模型只认档位，档位只认自己那个环境变量。一处一个真相。
    """
    import os

    if tier not in DEFAULT_TIER_MODELS:
        tier = FALLBACK_TIER

    allover = os.environ.get(ALL_TIERS_ENV, "").strip()
    if allover:
        return allover
    return os.environ.get(TIER_ENV[tier], "").strip() or DEFAULT_TIER_MODELS[tier]


def tier_models() -> dict[str, str]:
    """三个档位当前各自解析到什么。健康接口用它如实上报。"""
    return {tier: resolve_model(tier) for tier in DEFAULT_TIER_MODELS}


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
        # 档位由岗位自己声明（Agent.model_tier），不再一律写死 clinical_fast。
        # 写死的那版让「三个档位」彻底成了摆设 —— 名字有三个，落点只有一个。
        tier = getattr(agent, "model_tier", FALLBACK_TIER)
        return ResolvedConfig(
            agent_key=agent.key,
            version=agent.version,
            model_tier=tier,
            model=resolve_model(tier),
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
