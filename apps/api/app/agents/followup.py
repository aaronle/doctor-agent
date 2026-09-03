"""
AI 追问提示（F01）。

问诊**进行中**浮在医生智能体右上角的那份清单：该问的列出来，问到一条划掉一条。

两个岗位分工：

- `FollowUpPlanAgent` —— 问诊开始时算**一次**，出 6–10 条原子问项。
- `FollowUpCoverageAgent` —— 对话推进时**增量**调用，判定哪些已经问到了。

## 为什么它回来了

这两个岗位 2026-09-02 被下线过一次（当时叫 `voice_plan_agent` /
`voice_coverage_agent`），理由是「一期没有临床知识库，追问做不准，
建议错一条对医生是干扰」。

那个理由**对当时的做法成立，对现在这个不成立** —— 差别在清单从哪来：

| | 撤掉的那版 | 现在这版 |
| --- | --- | --- |
| 清单来源 | 教科书式的鉴别问诊清单 | **这位患者自己的上下文** |
| 需要知识库吗 | 需要 —— 「胸痛该问哪 12 条」得有出处 | 不需要 |
| 举例 | 「问 Levine 征」 | 「过敏史空着，没人问过」「主诉写了 5 年，病程细节没问」 |

「档案里过敏史是空的，这次该补问」不需要任何临床知识库，它只是把
**上下文里已经明摆着的缺口**说出来。这是能做准的那部分，也是这一版的边界。

## 判错的方向必须是安全的那边

覆盖判定只回「已覆盖」，不回「未覆盖」——没被提到的自然还开着。
于是模型漏判的默认后果是**继续提醒**，而不是**不再提醒**。

- 漏标已问 = 医生多扫一眼
- 错标已问 = 该问的问题再也不提醒了

两种错的代价差得远，所以规则是「**必须引用患者原话**，拿不准判未覆盖」，
且**降级时一条都不标**（见 `fallback`）。判定还必须单调：已标记的不回退，
这一条由调用方保证（服务端只把还开着的问题发下去，见 routers/emr.py）。
"""

from __future__ import annotations

from .base import Agent, require_list
from .schemas import FollowUpCoverageOut, FollowUpPlanOut

#: 清单长度上限。**不是越多越好。**
#:
#: 实测模型一次能列 15 条以上，但浮框里超过 8 条医生就不看了 ——
#: 一份看不完的清单和没有清单是同一个结果，还多占半个面板。
MAX_QUESTIONS = 8


class FollowUpPlanAgent(Agent):
    """开场：这次问诊该问什么。"""

    key = "followup_plan"
    version = "mvp-1.0.0"
    skill = "followup-prompt"
    output_model = FollowUpPlanOut
    # 既往史与本次异常是缺口的主要来源，主诉决定该往哪个方向追
    context_fields = (
        "chief_complaint", "primary_diagnosis", "past_history",
        "allergies", "allergy_status", "lab_results", "examinations",
    )

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        return (
            "请为这位患者列出本次问诊**该问而档案里还没有答案**的问题。\n"
            f"最多 {MAX_QUESTIONS} 条，按重要性排序，一条只问一件事。"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        questions = [str(x).strip() for x in require_list(data, "questions") if str(x).strip()]
        # 去重时保序：模型偶尔会把同一件事换个说法再列一遍
        seen: set[str] = set()
        unique = [q for q in questions if not (q in seen or seen.add(q))]
        return {"questions": unique[:MAX_QUESTIONS]}

    def fallback(self, ctx: dict, **kwargs) -> dict:
        """确定性兜底：只列**从上下文能直接看出来**的缺口，一条都不猜。

        这里刻意不给通用问诊模板（「疼多久了」这类）—— 模型不可用时给一份
        看起来像样、实际与这位患者无关的清单，比不给更糟：医生照着问完，
        会以为该问的都问过了。
        """
        gaps: list[str] = []
        if ctx.get("allergy_status") != "confirmed" and not ctx.get("allergies"):
            gaps.append("有没有药物过敏史？用过什么药起过疹子或不舒服吗？")
        for exam in ctx.get("examinations") or []:
            if isinstance(exam, dict) and exam.get("abnormal"):
                gaps.append(f"{exam.get('name') or '检查'}结果是异常的，这方面现在还有什么不舒服？")
        return {"questions": gaps[:MAX_QUESTIONS]}


class FollowUpCoverageAgent(Agent):
    """推进：清单里哪些已经问到了。"""

    key = "followup_coverage"
    version = "mvp-1.1.0"
    skill = "followup-coverage"
    output_model = FollowUpCoverageOut
    # 判定只看对话与清单，患者档案与它无关 —— 少送一份上下文也少一分跑偏。
    # 对话本身走 CONVERSATION_KEY 单独进来，不受这里的投影裁剪。
    context_fields = ()
    needs_exam_detail = False

    #: 本次问诊对话在 ctx 里的键。
    #:
    #: **刻意放在 ctx 而不是 kwargs。** 它本来就是上下文（这次就诊发生了什么），
    #: 而且 `validate()` 只拿得到 ctx —— 放 kwargs 的话，「引用必须出自对话」
    #: 这条硬约束就只能写在评测里，产品路径上没人管。
    CONVERSATION_KEY = "interview_conversation"

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        pending = [str(x).strip() for x in (kwargs.get("pending") or []) if str(x).strip()]
        conversation = str(ctx.get(self.CONVERSATION_KEY) or "").strip()
        listed = "\n".join(f"- {q}" for q in pending) or "（无）"
        return (
            f"【还开着的问题】\n{listed}\n\n"
            f"【本次问诊对话】\n{conversation or '（无内容）'}\n\n"
            "上面哪些问题，患者**已经在对话里回答过了**？"
            "每判定一条都要摘录能证明它的患者原话。找不到原话就不要列。"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        """留下**证明得了**的标记，丢掉证明不了的。

        判据是「能指出患者在哪句话里答了」，不是「模型觉得答过了」。所以：

        - 没有 `quote` → 丢
        - `quote` 不是对话里的原文（模型自己润色过／编的）→ 丢

        **丢单条，不整份拒绝。** 整份拒绝会触发降级，而降级意味着这一轮
        一条都不标 —— 那是把「有一条证据不硬」放大成「全部白跑」。
        丢单条的后果是漏标，正是安全的那个方向。
        """
        corpus = str(ctx.get(self.CONVERSATION_KEY) or "")
        covered = []
        for item in require_list(data, "covered"):
            if not isinstance(item, dict):
                continue
            question = str(item.get("question") or "").strip()
            quote = str(item.get("quote") or "").strip()
            if not question or not quote:
                continue
            if corpus and quote not in corpus:
                continue
            covered.append({"question": question, "quote": quote})
        return {"covered": covered}

    def fallback(self, ctx: dict, **kwargs) -> dict:
        """降级 = **一条都不标**。

        没有任何本地规则能替代语义判定 —— 按关键词匹配划掉问题，
        正是「错标已问」最容易发生的地方。宁可整份清单停在原地。
        """
        return {"covered": []}
