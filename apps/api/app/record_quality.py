"""
病历质控与完整性。

四项指标全部用**确定性规则**算，不交给模型 —— 让模型给自己的输出打分，
分数只会好看，不会有用。每一项都对应一条能说清楚的检查：

  结构完整性  七段是否齐全
  信息完整性  非「未采集」的段占比
  逻辑一致性  初步诊断提到的疾病，能否在其他段找到支撑
  用语规范性  是否出现未经问诊的否定表述（F03 红线，这项兼作红线监控）

遗漏清单同理：哪几段没采、哪些标准项没写，都是可核对的事实。
"""

from __future__ import annotations

import re

from .agents.record import SECTION_KEYS, SECTION_LABELS, UNCOLLECTED

# 未经问诊就写出来的否定表述。写「否认」意味着医生问过而患者否认，
# 凭空出现就是伪造问诊记录 —— 这是 F03 的红线，质控要盯住。
NEGATION_PATTERNS = ("否认", "无特殊", "未见异常", "无异常", "均无")

# 各段应当覆盖的标准项。缺了就进遗漏清单，不做扣分，只做提示。
EXPECTED_POINTS: dict[str, tuple[tuple[str, tuple[str, ...]], ...]] = {
    "present_illness": (
        ("起病时间", ("天", "周", "月", "年", "小时")),
        ("症状演变", ("加重", "缓解", "反复", "持续", "波动")),
    ),
    "physical_exam": (
        ("生命体征", ("血压", "体温", "脉搏", "心率")),
    ),
    "preliminary_diagnosis": (
        ("主要诊断", ()),
    ),
}


def _pct(numerator: int, denominator: int) -> int:
    return round(numerator / denominator * 100) if denominator else 0


def evaluate(fields: dict[str, str], *, dialog_text: str = "") -> dict:
    """
    对一份病历草稿做质控。

    dialog_text 是本次问诊的对话全文，用于判断「否认」类表述是不是真的问过 ——
    问过再写是规范记录，没问过写出来才是伪造。
    """
    filled = {key: str(fields.get(key) or "").strip() for key in SECTION_KEYS}

    structural = sum(1 for v in filled.values() if v)
    informational = sum(1 for v in filled.values() if v and v != UNCOLLECTED)

    # 逻辑一致性：初步诊断里的疾病名，去掉括注后取主干，看能否在其他段找到
    diagnosis_text = filled.get("preliminary_diagnosis", "")
    others = "".join(v for k, v in filled.items() if k != "preliminary_diagnosis")
    names = [n.strip() for n in re.split(r"[；;、\n\d.]+", re.sub(r"[（(].*?[)）]", "", diagnosis_text)) if n.strip()]
    supported = sum(1 for n in names if n[:3] and n[:3] in others)
    consistency = _pct(supported, len(names)) if names else 0

    # 用语规范性：出现否定表述但对话里没问过，即为不规范
    unverified: list[tuple[str, str]] = []
    for key, value in filled.items():
        for pattern in NEGATION_PATTERNS:
            if pattern in value and pattern not in dialog_text:
                unverified.append((key, f"出现「{pattern}」但问诊中未涉及"))
                break
    wording = _pct(len(SECTION_KEYS) - len(unverified), len(SECTION_KEYS))

    # 每条遗漏都带上 field / issue / type：
    # field 让界面能「点一下跳到那一段」，type 决定图标（❌/⚠️/ℹ️）。
    # 只给一句拼好的 text，界面就只能整句显示，既跳不过去也分不了级。
    gaps: list[dict] = []

    def add(key: str, issue: str, *, level: str, status: str, type_: str) -> None:
        gaps.append({
            "field": SECTION_LABELS[key],
            "field_key": key,
            "issue": issue,
            "text": f"{SECTION_LABELS[key]}{issue}",
            "level": level,
            "status": status,
            "type": type_,
        })

    for key in SECTION_KEYS:
        if not filled[key] or filled[key] == UNCOLLECTED:
            add(key, "尚未采集", level="warn", status="建议补充", type_="warning")

    for key, points in EXPECTED_POINTS.items():
        value = filled.get(key, "")
        if not value or value == UNCOLLECTED:
            continue
        for label, keywords in points:
            if keywords and not any(k in value for k in keywords):
                add(key, f"未写明{label}", level="warn", status="建议补充", type_="info")

    # 未经问诊的否定表述是红线，级别高于一般遗漏，图标用 ❌
    for key, issue in unverified:
        add(key, f"：{issue}", level="danger", status="须核实", type_="error")

    return {
        "completeness": _pct(informational, len(SECTION_KEYS)),
        "metrics": [
            {"name": "结构完整性", "value": _pct(structural, len(SECTION_KEYS)), "basis": "七段是否齐全"},
            {"name": "信息完整性", "value": _pct(informational, len(SECTION_KEYS)), "basis": "非「未采集」的段占比"},
            {"name": "逻辑一致性", "value": consistency, "basis": "初步诊断在其他段能否找到支撑"},
            {"name": "用语规范性", "value": wording, "basis": "是否出现未经问诊的否定表述"},
        ],
        "gaps": gaps,
    }
