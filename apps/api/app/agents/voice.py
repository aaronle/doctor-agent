"""
语音问诊智能体（F01）。

产出**问诊小结** —— 把一轮对话收敛成结构化摘要，供医生审阅后决定是否写进病历。

边界：这个岗位不替医生提问，也不据此下诊断。对话脚本是演示数据，小结是真实模型输出。

> 2026-09-03 删掉了 VoicePlanAgent（追问清单 + 补充观察）与 VoiceCoverageAgent
> （判定哪些追问已被回答）。这两个功能于 2026-09-02 按产品决策下线 ——
> 一期没有临床知识库，追问做不准，对医生是干扰。端点已删，类却留了一整天，
> 其中 VoiceCoverageAgent 全仓零引用。**功能下线要连着实现一起删**，
> 否则下一个人会以为它还在跑，照着它去改。
"""

from __future__ import annotations

from .base import Agent, require_list


class VoiceSummaryAgent(Agent):
    """收尾：把整轮问诊收敛成结构化小结。"""

    key = "voice"
    version = "mvp-1.1.0"
    context_fields = ("primary_diagnosis", "diagnoses", "past_history")
    role_prompt = (
        "你负责把一次门诊问诊对话收敛成结构化小结，供医生审阅后决定是否写入病历。\n"
        "硬性要求：\n"
        "1. 只归纳对话中**实际出现**的内容，不补全、不推断。\n"
        "2. chief_complaint 用患者自己的说法，不要改写成诊断名。\n"
        "3. 对话没有涉及的方面，在 gaps 中列出还需要补问什么。\n"
        "4. 不下诊断、不给治疗方案。"
    )
    output_schema = {
        "type": "object",
        "required": ["chief_complaint", "key_points", "gaps"],
        "properties": {
            "chief_complaint": {"type": "string"},
            "key_points": {"type": "array", "items": {"type": "string"}},
            "gaps": {"type": "array", "items": {"type": "string"}},
            "summary": {"type": "string"},
        },
    }

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        conversation = str(kwargs.get("conversation_summary") or "").strip()
        return f"以下是本次问诊对话：\n{conversation or '（无内容）'}\n\n请归纳为结构化小结。"

    def validate(self, data: dict, ctx: dict) -> dict:
        return {
            "chief_complaint": str(data.get("chief_complaint") or "").strip(),
            "key_points": [str(x).strip() for x in require_list(data, "key_points") if str(x).strip()],
            "gaps": [str(x).strip() for x in require_list(data, "gaps") if str(x).strip()],
            "summary": str(data.get("summary") or "").strip(),
        }

    def fallback(self, ctx: dict, **kwargs) -> dict:
        conversation = str(kwargs.get("conversation_summary") or "").strip()
        return {
            "chief_complaint": ctx.get("chief_complaint") or "",
            "key_points": [],
            "gaps": ["模型通道不可用，本次问诊未生成结构化小结，请人工整理。"],
            "summary": conversation[:500],
        }
