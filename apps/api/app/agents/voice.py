"""
语音问诊智能体（F01）。

对齐 V4.3 的交互模型：点「语音问诊」后自动播放本次就诊的对话脚本，
播放过程中浮出「AI 追问提示」清单（已问到的逐条划掉），并累积「补充观察」。

边界要看清楚：这个岗位产出的是**给医生的追问清单与观察项**，
不是替医生向患者提问，更不是据此下诊断。对话脚本是演示数据，
清单与观察项是真实模型输出。
"""

from __future__ import annotations

from .base import Agent, require_list

# 追问清单的条数上限。V4.3 实测为 9–10 条，过长医生扫不完
MAX_QUESTIONS = 10
MAX_OBSERVATIONS = 14


class VoicePlanAgent(Agent):
    """
    问诊开始时一次性产出：追问清单 + 候选补充观察项。

    一次调用拿全，而不是每轮问一次 —— 对话是脚本播放的，
    每轮再调一次模型既拖慢播放，也会让清单前后不一致。
    """

    key = "voice"
    version = "mvp-1.1.0"
    # 追问要贴合本次主诉与既往史；带上全部检验值反而会诱导它去解读报告
    context_fields = ("primary_diagnosis", "diagnoses", "past_history", "allergies", "vitals")
    role_prompt = (
        "你在门诊问诊开始前，为医生准备一份**追问清单**和一组**候选补充观察项**。\n"
        "硬性要求：\n"
        f"1. questions 给 5–{MAX_QUESTIONS} 条，每条是医生可直接念出来的一句问话，不超过 20 字，以问号结尾。\n"
        "2. 追问要覆盖尚未澄清的关键信息：起病时间与诱因、症状侧别与进展、伴随症状、"
        "用药依从性、加重与缓解因素、既往同类发作。\n"
        f"3. observations 给 8–{MAX_OBSERVATIONS} 条，是问诊中**可能听到**的客观信息点，"
        "供医生一键勾选补录，每条不超过 20 字。\n"
        "4. 只依据患者上下文里已有的病史与诊断来拟定，不要臆造具体数值。\n"
        "5. 不下诊断、不给治疗建议、不评价患者。"
    )
    output_schema = {
        "type": "object",
        "required": ["questions", "observations"],
        "properties": {
            "questions": {
                "type": "array",
                "maxItems": MAX_QUESTIONS,
                "items": {"type": "string", "description": "医生可直接念出的一句追问"},
            },
            "observations": {
                "type": "array",
                "maxItems": MAX_OBSERVATIONS,
                "items": {"type": "string", "description": "问诊中可能听到的客观信息点"},
            },
        },
    }

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        return (
            f"患者本次主诉：{ctx.get('chief_complaint') or '未提供'}。\n"
            "为这次问诊准备追问清单与候选补充观察项。"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        questions = [str(q).strip() for q in require_list(data, "questions") if str(q).strip()]
        observations = [str(o).strip() for o in require_list(data, "observations") if str(o).strip()]
        if not questions:
            raise ValueError("questions 不能为空")
        return {
            "questions": questions[:MAX_QUESTIONS],
            "observations": observations[:MAX_OBSERVATIONS],
        }

    def fallback(self, ctx: dict, **kwargs) -> dict:
        """
        降级时给一组与病种无关的通用追问。

        刻意不按主诉去猜专科问题 —— 没有模型就没有可靠的专科判断，
        给通用问法是诚实的；观察项留空，让医生自己记。
        """
        return {
            "questions": [
                "这次的症状是什么时候开始的？",
                "有没有让它加重或缓解的情况？",
                "以前出现过类似情况吗？",
                "最近的药有按时吃吗？有没有漏服？",
                "还有没有其他不舒服？",
            ],
            "observations": [],
            "degraded_hint": "模型通道不可用，追问清单为通用问法，未生成补充观察项。",
        }


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
