"""病情概况智能体（F02）。"""

from __future__ import annotations

from .base import Agent, require_dict
from .context import abnormal_labs

RISK_LEVELS = ("高风险", "中风险", "低风险")


class SummaryAgent(Agent):
    key = "summary"
    version = "mvp-1.0.0"
    # 疗效评价要看趋势，因此保留检验历史值；检查报告只需结论
    context_fields = (
        "primary_diagnosis", "diagnoses", "past_history", "vitals",
        "lab_results", "orders", "examinations",
    )
    needs_lab_history = True
    needs_exam_detail = False
    skill = "condition-summary"
    output_schema = {
        "type": "object",
        "required": ["overall_conclusion", "treatment_effectiveness"],
        "properties": {
            "overall_conclusion": {
                "type": "object",
                "required": ["risk_level", "summary"],
                "properties": {
                    "risk_level": {"type": "string", "enum": list(RISK_LEVELS)},
                    "summary": {"type": "string", "description": "150 字以内的整体概要"},
                    "problems": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "问题清单，每条一句话",
                    },
                    "conflicts": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "并列陈述的矛盾信息；没有则为空数组",
                    },
                },
            },
            "treatment_effectiveness": {
                "type": "object",
                "required": ["ai_summary"],
                "properties": {"ai_summary": {"type": "string"}},
            },
        },
    }

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        return (
            "生成本次就诊的病情概要与疗效评价。\n"
            "概要须覆盖：主要诊断与病程、本次异常发现、合并症、需要关注的趋势。\n"
            "疗效评价基于 lab_results 里的 history 与 trend 字段，没有历史值就说明缺乏可比数据。"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        conclusion = require_dict(data, "overall_conclusion")
        if conclusion.get("risk_level") not in RISK_LEVELS:
            raise ValueError(f"非法风险等级：{conclusion.get('risk_level')}")
        if not str(conclusion.get("summary") or "").strip():
            raise ValueError("overall_conclusion.summary 不能为空")

        effectiveness = require_dict(data, "treatment_effectiveness")
        if not str(effectiveness.get("ai_summary") or "").strip():
            raise ValueError("treatment_effectiveness.ai_summary 不能为空")

        return {
            "overall_conclusion": {
                "risk_level": conclusion["risk_level"],
                "summary": conclusion["summary"].strip(),
                "problems": [str(p) for p in conclusion.get("problems", []) if str(p).strip()],
                "conflicts": [str(c) for c in conclusion.get("conflicts", []) if str(c).strip()],
            },
            "treatment_effectiveness": {"ai_summary": effectiveness["ai_summary"].strip()},
        }

    def fallback(self, ctx: dict, **kwargs) -> dict:
        """只陈述可核对的事实：主诉、诊断、异常项计数。不做任何推断。"""
        abnormal = abnormal_labs(ctx)
        names = "、".join(str(lab.get("name")) for lab in abnormal[:5])
        pieces = [f"{ctx.get('age')}岁{ctx.get('gender')}患者，{ctx.get('dept')}就诊。"]
        if ctx.get("chief_complaint"):
            pieces.append(f"主诉：{ctx['chief_complaint']}。")
        if ctx.get("primary_diagnosis"):
            pieces.append(f"主要诊断：{ctx['primary_diagnosis']}。")
        pieces.append(f"本次检验异常 {len(abnormal)} 项" + (f"（{names}）。" if names else "。"))

        return {
            "overall_conclusion": {
                "risk_level": ctx.get("risk_level") or "中风险",
                "summary": "".join(pieces) + "模型通道不可用，以上为结构化数据直接汇总，未做临床推断。",
                "problems": [
                    f"{lab.get('name')} {lab.get('value')}{lab.get('unit', '')}（参考 {lab.get('ref', '—')}）"
                    for lab in abnormal[:6]
                ],
                "conflicts": [],
            },
            "treatment_effectiveness": {
                "ai_summary": "模型通道不可用，未生成疗效评价。可查看检验历史值与趋势自行判断。"
            },
        }
