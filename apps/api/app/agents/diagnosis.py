"""
诊断智能体。一头承两个功能：

  F04 鉴别诊断 —— 候选诊断的支持 / 反对 / 缺失三类证据
  F05 诊断管理 —— 供医生勾选、标主诊断、回写的疑似诊断列表
"""

from __future__ import annotations

from .schemas import DiagnosisOut
from .base import Agent, require_list

# 置信度只允许 5 的倍数。不是为了好看：模型没有能力给出「73.6%」这种精度，
# 放开小数只会让界面显示出一个看起来很可信、实际无依据的数字。
CONFIDENCE_STEP = 5

# 界面按名次显示徽标：首选 / 次选 / 备选。名次由置信度排序派生，
# 不让模型自己report —— 否则可能出现两个「首选」或名次与置信度矛盾。
RANK_LABELS = ("首选", "次选")
RANK_KEYS = ("is-first", "is-second")

# 可能性徽标（高 / 中 / 低），用于「需鉴别」列表里的同组候选
LIKELIHOOD_BANDS = ((80, "高"), (55, "中"))


def _rank_of(index: int) -> tuple[str, str]:
    if index < len(RANK_LABELS):
        return RANK_LABELS[index], RANK_KEYS[index]
    return "备选", "is-alt"


def _likelihood_of(confidence: int) -> str:
    for threshold, label in LIKELIHOOD_BANDS:
        if confidence >= threshold:
            return label
    return "低"


class DiagnosisAgent(Agent):
    key = "diagnosis"
    version = "mvp-1.0.0"
    # 鉴别诊断要引用检查报告细节与检验趋势，是六个岗位里上下文最重的一个
    context_fields = (
        "primary_diagnosis", "diagnoses", "suspected_diagnoses", "past_history",
        "allergies", "vitals", "lab_results", "examinations",
    )
    needs_lab_history = True
    skill = "differential-diagnosis"
    output_model = DiagnosisOut

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        return (
            "基于患者上下文给出候选诊断与鉴别依据。\n"
            "只使用上下文里出现的检验值、体征、既往史与主诉作为证据。\n"
            "上下文已有 suspected_diagnoses 时，把它当作既往判断参考，但要用本次数据重新评估，不要照抄。"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        items = require_list(data, "suspected_diagnoses")
        if not items:
            raise ValueError("suspected_diagnoses 不能为空")

        cleaned = []
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("suspected_diagnoses 元素必须是对象")
            name = str(item.get("name") or "").strip()
            if not name:
                raise ValueError("候选诊断缺少 name")

            raw_confidence = item.get("confidence")
            if not isinstance(raw_confidence, (int, float)):
                raise ValueError(f"{name} 的 confidence 必须是数字")
            confidence = int(round(float(raw_confidence) / CONFIDENCE_STEP) * CONFIDENCE_STEP)
            confidence = max(0, min(100, confidence))

            opposing = [str(x).strip() for x in item.get("opposing", []) if str(x).strip()]
            if not opposing:
                # 规格要求：无反对证据必须显式写「未获得」，不允许空列表悄悄通过
                opposing = ["未获得"]

            cleaned.append(
                {
                    "name": name,
                    "confidence": confidence,
                    "icd": str(item.get("icd") or "").strip(),
                    "desc": str(item.get("desc") or "").strip(),
                    "suggestion": str(item.get("suggestion") or "").strip(),
                    "supporting": [str(x).strip() for x in item.get("supporting", []) if str(x).strip()],
                    "opposing": opposing,
                    "missing": [str(x).strip() for x in item.get("missing", []) if str(x).strip()],
                }
            )

        cleaned.sort(key=lambda d: d["confidence"], reverse=True)
        return _decorate(cleaned)

    def fallback(self, ctx: dict, **kwargs) -> dict:
        """降级时沿用种子里的既往疑似诊断，并明确标注证据未经本次评估。"""
        seeded = ctx.get("suspected_diagnoses") or []
        cleaned = []
        for item in seeded:
            if not isinstance(item, dict):
                continue
            cleaned.append(
                {
                    "name": item.get("name", ""),
                    "confidence": int(item.get("confidence") or 0),
                    "icd": item.get("icd", ""),
                    "desc": item.get("desc", ""),
                    "suggestion": "",
                    "supporting": ["模型通道不可用，未做本次证据评估"],
                    "opposing": ["未获得"],
                    "missing": ["需人工复核支持与反对证据"],
                }
            )
        cleaned.sort(key=lambda d: d["confidence"], reverse=True)
        return _decorate(cleaned)


def _decorate(cleaned: list[dict]) -> dict:
    """
    给已排序的候选补上界面需要的派生字段。

    V4.3 的鉴别诊断卡按名次显示「首选/次选/备选」徽标，每条下方的
    「需鉴别（N）」列出**同组的其他候选**及其可能性。这些都能从置信度
    排序派生，不需要模型额外产出，也就不会出现两个「首选」这种矛盾。
    """
    for index, item in enumerate(cleaned):
        item["rank"] = index
        item["rank_label"], item["rank_key"] = _rank_of(index)
        item["likelihood"] = _likelihood_of(item["confidence"])

    for index, item in enumerate(cleaned):
        item["differentials"] = [
            {
                "name": other["name"],
                "likelihood": other["likelihood"],
                "reason": other["desc"],
            }
            for j, other in enumerate(cleaned)
            if j != index
        ]

    return {
        "suspected_diagnoses": cleaned,
        # 界面的鉴别诊断区与诊断管理区读同一份数据的不同视图
        "differential_diagnosis": {
            "items": [
                {
                    "name": d["name"],
                    "supporting": d["supporting"],
                    "opposing": d["opposing"],
                    "missing": d["missing"],
                }
                for d in cleaned
            ]
        },
    }
