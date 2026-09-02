"""
模型档位。

这批测试盯的都是**静默降级**：档位配错、被环境变量盖掉、或者存个草稿
就把岗位换成弱模型 —— 界面上全都看不出异样，产出质量却掉了。
"""

from __future__ import annotations

from app.agent_config import (
    DEFAULT_TIER_MODELS,
    FALLBACK_TIER,
    TIER_ENV,
    resolve_model,
    tier_models,
)
from app.agents import (
    comorbidity_agent,
    diagnosis_agent,
    record_agent,
    risk_agent,
    summary_agent,
    voice_plan_agent,
)

ALL_AGENTS = (summary_agent, record_agent, diagnosis_agent, risk_agent, comorbidity_agent, voice_plan_agent)


def test_tiers_actually_resolve_to_different_models():
    """
    档位在 2026-09-02 之前是个空壳：三个名字全指向同一个槽。
    「保留这层抽象」的理由是「将来能分开」—— 那就得真的分得开。
    """
    assert len(set(tier_models().values())) > 1, "三个档位又变成同一个模型了，抽象白留"


def test_every_agent_declares_a_known_tier():
    for agent in ALL_AGENTS:
        assert agent.model_tier in DEFAULT_TIER_MODELS, f"{agent.key} 的档位不认识：{agent.model_tier}"


def test_unknown_tier_falls_back_to_the_stronger_side():
    """
    档位名打错时宁可慢，不可弱。

    回落到快档的话，一个拼写错误就能把临床岗位悄悄降级 ——
    没有任何人会立刻发现，而产出质量已经掉了。
    """
    assert FALLBACK_TIER != "clinical_fast"
    assert resolve_model("typo_tier") == DEFAULT_TIER_MODELS[FALLBACK_TIER]


def test_base_default_tier_is_not_the_fast_one():
    """漏声明 model_tier 的新岗位，后果应该是「慢一点」而不是「弱一点」。"""
    from app.agents.base import Agent

    assert Agent.model_tier != "clinical_fast"


def test_ai_fast_model_does_not_override_tiers(monkeypatch):
    """
    **`AI_FAST_MODEL` 不参与档位解析，这是有意的。**

    生产 env 里它被设成了 sonnet。让它参与的话，档位拆分会被整体盖掉 ——
    代码里三档分开、线上三档一样，而且不报错。这个项目已经因为
    「env 盖住代码缺省」栽过一次（产品路径以为换了 Sonnet，实际一直跑 Haiku）。
    """
    from app import config

    monkeypatch.setenv("AI_FAST_MODEL", "some-global-model")
    config.get_ai_settings.cache_clear()
    try:
        assert resolve_model("clinical_fast") == DEFAULT_TIER_MODELS["clinical_fast"]
        assert resolve_model("clinical_safety") == DEFAULT_TIER_MODELS["clinical_safety"]
    finally:
        config.get_ai_settings.cache_clear()


def test_each_tier_can_be_overridden_on_its_own(monkeypatch):
    monkeypatch.setenv(TIER_ENV["clinical_reasoning"], "some-other-model")
    assert resolve_model("clinical_reasoning") == "some-other-model"
    # 别的档位不受影响 —— 单档位覆盖就该只影响单档位
    assert resolve_model("clinical_fast") == DEFAULT_TIER_MODELS["clinical_fast"]


def test_all_tiers_override_switches_everything(monkeypatch):
    """应急整体切换：三档一起换，用于「先全切回某个模型再说」。"""
    from app.agent_config import ALL_TIERS_ENV

    monkeypatch.setenv(ALL_TIERS_ENV, "panic-model")
    assert set(tier_models().values()) == {"panic-model"}


# ---------------------------------------------------------------- 岗位分配


def test_record_is_on_the_fast_tier_because_it_was_measured():
    """
    六个岗位里**唯一有 A/B 数据**的一个：同一套 10 条回归集两个模型都是 10/10，
    耗时 45.8s → 5.0s。花 40 秒买不到任何东西。
    """
    assert record_agent.model_tier == "clinical_fast"


def test_risk_stays_on_the_reasoning_side_because_content_beat_speed():
    """
    risk 留在安全档。原来那句「用例太少所以不许动」的前提已经不成立
    （2026-09-02 用例补到 7 条），所以理由换成下面这个 —— 连同一次教训。

    ## 教训：n=1 的对比不叫对比

    结构校验 Haiku 8/8 / Sonnet 8/8 打平，26.8s 对 115.2s。照这个数就该换快档。
    我于是把两边内容摆开人工看，发现 Haiku 在 P001 漏了「双眼底照相：异常 ·
    NPDR 轻度」、Sonnet 写了，据此推翻了速度结论。

    **然后把它写成用例一跑，结论反了**：Sonnet 连着两轮漏、Haiku 连着两轮没漏。
    我那次比对每个模型只采了一个样本，采到的是抖动不是差异。
    ——「摆开看一眼」和「跑成用例」不是一回事，前者永远不能单独下结论。

    ## 那次比对真正找到的东西

    不是模型差异，是产品缺陷，两个模型都有：四个位置装不下 P001 的九个异常，
    丢哪个是随机的，而没有数值的影像/检查结论最容易被丢。已在 task_instruction
    里改成「阳性检查结论优先、同系统化验合并」。

    ## 那为什么还留在推理档

    剩下的差别里唯一**没法自动判**的是把散点合成一个临床判断（P004 血压 +
    颈动脉斑块 + 头晕头痛 → 脑血管事件风险，而不是三条并列）。它没有用例、
    也做不出用例，所以不能拿「用例打平」当换档理由 —— 打平只说明
    用例覆盖到的部分打平了。安全岗在这种不确定下取强的一侧。
    """
    assert risk_agent.model_tier == "clinical_safety"
    assert DEFAULT_TIER_MODELS["clinical_safety"] != DEFAULT_TIER_MODELS["clinical_fast"]


def test_risk_eval_set_still_covers_the_two_blind_spots():
    """
    上面那条结论的**依据**必须还在。

    只写 `model_tier == "clinical_safety"` 是守不住的：谁把 risk_must_cover
    从用例里删掉，断言照样绿，而那时「Haiku 会漏阳性检查」就再没人能复现了 ——
    结论会退化成一句无法查证的口头传统。所以这里直接查证据本身。
    """
    import json
    from pathlib import Path

    ds = json.loads(
        (
            Path(__file__).resolve().parents[1]
            / "app/data/eval_datasets/risk-safety-basic.json"
        ).read_text(encoding="utf-8")
    )
    kinds = [c["kind"] for case in ds["cases"] for c in case["checks"]]
    assert len(ds["cases"]) >= 7, "risk 回归集被缩水了"
    assert kinds.count("risk_must_cover") >= 5, "漏项校验被删了 —— 换档结论就没有依据了"
    assert "risk_evidence_grounded" in kinds


def test_unmeasured_agents_stay_on_the_stronger_side():
    """
    summary / diagnosis / comorbidity / voice 都没有 A/B 数据。

    而且算术上也没理由动前三个：它们在 report-summary 里**并发**跑，
    只要 risk 还是长杆，把它们换成快档一秒都省不下来。
    """
    for agent in (summary_agent, diagnosis_agent, comorbidity_agent, voice_plan_agent):
        assert agent.model_tier != "clinical_fast", f"{agent.key} 没有数据支撑就被降级了"


def test_saving_a_draft_without_a_tier_keeps_the_current_one(client):
    """
    在控制台只改 Prompt、没碰档位，存一次草稿不该把岗位悄悄换成快档。

    原先 DraftIn.model_tier 默认 "clinical_fast" —— 正是这种改法。
    """
    before = client.get("/api/admin/agents/risk").json()["running"]["model_tier"]
    r = client.put("/api/admin/agents/risk/draft", json={"role_prompt": "只改提示词", "params": {}})
    assert r.status_code == 200

    draft = client.get("/api/admin/agents/risk").json()["draft"]
    assert draft["model_tier"] == before, "存草稿把档位改掉了"


def test_health_reports_what_each_tier_resolves_to(client):
    """
    「生产在跑什么模型」必须一眼看得见。

    aiModels.fast 只代表不走档位的那些调用；六个岗位看的是 modelTiers。
    只报前者会让人以为岗位跑的是它 —— 这个误解在 09-02 真的发生过。
    """
    body = client.get("/api/health").json()
    assert set(body["modelTiers"]) == set(DEFAULT_TIER_MODELS)
    assert body["modelTiers"]["clinical_fast"] != body["modelTiers"]["clinical_safety"]
