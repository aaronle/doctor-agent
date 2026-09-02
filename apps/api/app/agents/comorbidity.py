"""共病管理智能体（F07）。"""

from __future__ import annotations

from .schemas import DEPARTMENTS, ComorbidityOut
from .base import Agent, require_list

# 推荐科室取自闭集。放开自由生成会出现「代谢内分泌联合门诊」这类院内不存在的
# 科室名，医生点了会诊却找不到对应科室。

# 营养筛查评分超过该值即触发营养共病提醒，与 V4.3 界面一致
NUTRITION_ALERT_THRESHOLD = 3


class ComorbidityAgent(Agent):
    key = "comorbidity"
    version = "mvp-1.0.0"
    # 共病看的是病种组合与相互影响，不需要检查报告全文与检验趋势
    context_fields = (
        "primary_diagnosis", "diagnoses", "past_history", "lab_results",
        "orders", "nutrition_screening_score",
    )
    needs_exam_detail = False
    skill = "comorbidity-management"
    #: 科室闭集在代码里（DEPARTMENTS），SKILL.md 只留占位符 —— 值只有一个来源
    prompt_placeholders = {"<DEPARTMENTS>": lambda: "、".join(DEPARTMENTS)}
    output_model = ComorbidityOut

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        return (
            "识别该患者的共病组合，说明彼此的相互影响，并给出协同管理建议。\n"
            "依据仅限上下文中的既往史、诊断、检验值与用药。"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        conditions = require_list(data, "conditions")
        cleaned = []
        for item in conditions:
            if not isinstance(item, dict):
                raise ValueError("conditions 元素必须是对象")
            dept = str(item.get("recommended_dept") or "").strip()
            if dept not in DEPARTMENTS:
                raise ValueError(f"推荐科室不在字典内：{dept}")
            if item.get("risk_level") not in {"高危", "中危", "低危"}:
                raise ValueError(f"非法共病危险度：{item.get('risk_level')}")
            if not str(item.get("analysis") or "").strip():
                raise ValueError("共病缺少 analysis")
            cleaned.append(
                {
                    "name": str(item.get("name") or "").strip(),
                    "icd": str(item.get("icd") or "").strip(),
                    "duration": str(item.get("duration") or "").strip(),
                    "risk_level": item["risk_level"],
                    "analysis": item["analysis"].strip(),
                    "recommended_dept": dept,
                }
            )

        detected = bool(data.get("detected")) and bool(cleaned)
        return {
            "detected": detected,
            "risk_level": data.get("risk_level") or ("高风险" if detected else "低风险"),
            "summary": str(data.get("summary") or "").strip(),
            "recommendation": str(data.get("recommendation") or "").strip(),
            "conditions": cleaned,
            "nutrition": self.nutrition_alert(ctx),
        }

    @staticmethod
    def nutrition_alert(ctx: dict) -> dict:
        """营养共病提醒。纯阈值判断，不经模型。"""
        score = int(ctx.get("nutrition_screening_score") or 0)
        triggered = score > NUTRITION_ALERT_THRESHOLD
        return {
            "triggered": triggered,
            "score": score,
            "threshold": NUTRITION_ALERT_THRESHOLD,
            "message": (
                f"患者营养筛查评分 {score} 分（>{NUTRITION_ALERT_THRESHOLD} 分），存在营养风险，需要申请营养科会诊。"
                if triggered
                else ""
            ),
        }

    def fallback(self, ctx: dict, **kwargs) -> dict:
        """降级时不做共病推断，只把营养评分这条确定性规则的结果给出去。"""
        return {
            "detected": False,
            "risk_level": "低风险",
            "summary": "模型通道不可用，未进行共病识别。",
            "recommendation": "",
            "conditions": [],
            "nutrition": self.nutrition_alert(ctx),
        }
