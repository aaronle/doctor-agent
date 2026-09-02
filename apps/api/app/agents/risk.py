"""
风险管理智能体（F06）。

本岗位与其他五个的关键差别：**硬规则独立于模型运行**。
过敏冲突、危急值、生命体征越界由纯代码判定；模型只负责在硬规则之外
补充需要临床推理的风险项。任何情况下模型都不能覆盖硬规则判定的红色风险。
"""

from __future__ import annotations

import re

from .base import Agent, require_list
from .context import abnormal_labs

LEVEL_COLOR = {"高风险": "danger", "中风险": "warning", "低风险": "success", "提示": "info"}

# 危急值：达到即触发红色，必须处置。阈值取国内门诊常用口径。
CRITICAL_LABS = {
    "空腹血糖": (2.8, 16.7, "mmol/L"),
    "餐后2h血糖": (None, 22.2, "mmol/L"),
    "血钾": (2.8, 6.0, "mmol/L"),
    "血钠": (120.0, 160.0, "mmol/L"),
    "血红蛋白": (60.0, None, "g/L"),
    "肌酐": (None, 445.0, "μmol/L"),
    "白细胞": (1.5, 30.0, "10^9/L"),
    "血小板": (30.0, None, "10^9/L"),
}

# 生命体征阈值：(低危急, 高危急)
VITAL_THRESHOLDS = {
    "systolic": (90, 180, "收缩压", "mmHg"),
    "diastolic": (50, 110, "舒张压", "mmHg"),
    "hr": (50, 120, "心率", "次/分"),
    "temp": (35.0, 39.0, "体温", "℃"),
    "spo2": (92, None, "血氧饱和度", "%"),
}


def _to_float(value) -> float | None:
    if value is None:
        return None
    try:
        return float(str(value).strip().split()[0])
    except (ValueError, IndexError):
        return None


def _parse_bp(vitals: dict) -> tuple[float | None, float | None]:
    """血压在 fixture 里是 '142/88 mmHg' 这种字符串，拆成收缩压与舒张压。"""
    raw = str(vitals.get("bp") or "")
    match = re.search(r"(\d+)\s*/\s*(\d+)", raw)
    if not match:
        return None, None
    return float(match.group(1)), float(match.group(2))


def hard_rule_alerts(ctx: dict) -> list[dict]:
    """
    纯代码风险判定。不调模型，因此模型不可用时这部分照常产出。

    返回的每一条都带证据、来源、阈值与处置建议 —— 红色风险缺一不可。
    """
    alerts: list[dict] = []

    # 1) 过敏冲突：在用医嘱命中过敏原
    #
    # 过敏史有**三种**状态，不是两种。这里以前只认两种，代价很具体：
    # 判据是「allergies 非空就是有过敏」，于是空字符串 = 无过敏 = 放行。
    # 而种子数据里七个患者有六个是空字符串 —— 那六个人从来没有人问过过敏史，
    # 界面和硬规则却一致地把他们当成「不过敏」。**这条拦截在六分之六的情况下等于没装。**
    #
    # | 状态 | 含义 | 硬规则 |
    # | --- | --- | --- |
    # | `confirmed` | 有明确过敏原 | 与在用医嘱比对，命中即高风险 |
    # | `denied` | 问过，患者否认 | 不产出任何项 —— 干净就是信息 |
    # | `unknown` | **没人问过** | 中风险：提醒补采，但不阻断就诊 |
    #
    # 「问过、没有」和「没问过」在临床上是两件事，这个仓库在别处一直分得很清
    # （安全层第 5 条「未问诊不写否认」、病历的「未采集」），唯独在过敏史上合并了。
    status = str(ctx.get("allergy_status") or "").strip().lower()
    allergies = ctx.get("allergies")
    allergy_terms: list[str] = []
    if isinstance(allergies, list):
        allergy_terms = [str(a).strip() for a in allergies if str(a).strip()]
    elif isinstance(allergies, str) and allergies.strip() and allergies.strip() not in {"无", "否认"}:
        allergy_terms = [allergies.strip()]

    # 没有显式状态时按有没有过敏原倒推，保证老数据不至于突然全变「未采集」
    if not status:
        status = "confirmed" if allergy_terms else "unknown"

    if status == "unknown":
        alerts.append(
            {
                "id": "hard_allergy_unknown",
                "name": "过敏史未采集",
                "level": "中风险",
                "color": "warning",
                "summary": "本次就诊未采集药物过敏史，开具处方前需补问。",
                "evidence": "患者档案中过敏史为空，且未记录「否认药物过敏史」",
                "source": "硬规则 · 过敏史采集状态",
                "threshold": "allergy_status = unknown 即触发",
                "suggestion": "问诊时补采药物过敏史；确认无过敏后在档案中显式记录「否认药物过敏史」。",
                "rule": "allergy_not_collected",
            }
        )

    for term in allergy_terms:
        for order in ctx.get("orders", []) or []:
            drug = str(order.get("drug") or order.get("name") or "")
            if term and drug and term in drug:
                alerts.append(
                    {
                        "id": f"hard_allergy_{drug}",
                        "name": "过敏冲突",
                        "level": "高风险",
                        "color": "danger",
                        "summary": f"患者对「{term}」过敏，当前医嘱含「{drug}」，存在用药冲突。",
                        "evidence": f"过敏史：{term}；在用医嘱：{drug}",
                        "source": "硬规则 · 过敏史与在用医嘱比对",
                        "threshold": "过敏原与医嘱药名匹配即触发",
                        "suggestion": "立即停用该药并更换替代方案，记录过敏反应类型。",
                        "rule": "allergy_conflict",
                    }
                )

    # 2) 危急值
    for lab in ctx.get("lab_results", []) or []:
        if not isinstance(lab, dict):
            continue
        name = str(lab.get("name") or "")
        if name not in CRITICAL_LABS:
            continue
        value = _to_float(lab.get("value"))
        if value is None:
            continue
        low, high, unit = CRITICAL_LABS[name]
        hit = None
        if low is not None and value < low:
            hit = f"低于危急值下限 {low}{unit}"
        elif high is not None and value > high:
            hit = f"超过危急值上限 {high}{unit}"
        if hit:
            alerts.append(
                {
                    "id": f"hard_critical_{name}",
                    "name": f"{name}危急值",
                    "level": "高风险",
                    "color": "danger",
                    "summary": f"{name} {value}{unit}，{hit}，需立即处置。",
                    "evidence": f"{name}：{value}{unit}（参考 {lab.get('ref', '—')}）",
                    "source": "硬规则 · 检验危急值",
                    "threshold": f"下限 {low if low is not None else '—'} / 上限 {high if high is not None else '—'} {unit}",
                    "suggestion": "按危急值流程复核标本并即时处理，记录处置时间与责任人。",
                    "rule": "critical_lab",
                }
            )

    # 3) 生命体征越界
    vitals = ctx.get("vitals") or {}
    if isinstance(vitals, dict):
        systolic, diastolic = _parse_bp(vitals)
        readings = {
            "systolic": systolic,
            "diastolic": diastolic,
            "hr": _to_float(vitals.get("hr")),
            "temp": _to_float(vitals.get("temp")),
            "spo2": _to_float(vitals.get("spo2")),
        }
        for key, value in readings.items():
            if value is None:
                continue
            low, high, label, unit = VITAL_THRESHOLDS[key]
            hit = None
            if low is not None and value < low:
                hit = f"低于 {low}{unit}"
            elif high is not None and value > high:
                hit = f"高于 {high}{unit}"
            if hit:
                alerts.append(
                    {
                        "id": f"hard_vital_{key}",
                        "name": f"{label}异常",
                        "level": "高风险",
                        "color": "danger",
                        "summary": f"{label} {value}{unit}，{hit}，需即时评估。",
                        "evidence": f"本次生命体征 {label}：{value}{unit}",
                        "source": "硬规则 · 生命体征阈值",
                        "threshold": f"下限 {low if low is not None else '—'} / 上限 {high if high is not None else '—'} {unit}",
                        "suggestion": "复测确认，排除急性事件后再继续门诊流程。",
                        "rule": "vital_threshold",
                    }
                )

    # 4) 阳性检查/影像结论
    #
    # 这条本来是交给模型的，实测**它做不稳**：P001 上下文里写着「双眼底照相：
    # 异常 · NPDR 轻度」，Haiku 与 Sonnet 各跑五轮，都是三次写进去、两次漏掉。
    # 提示词里加了「阳性检查优先」的取舍次序也没稳住 —— 因为根子不在措辞：
    # 风险项限 2–4 条，而 P001 有九个异常，四个位置装不下，丢谁近乎随机；
    # 影像结论没有数值，天然比化验值「不显眼」，最容易被挤掉。
    #
    # 但 `abnormal` 是上下文里的一个布尔字段，这压根不是判断题。
    # **确定的事情用确定的办法做**：由代码保证每条阳性检查都在场，
    # 模型的 2–4 个位置就腾出来放它真正该做的事（把散点合成临床判断）。
    #
    # 判中风险不判高风险：这里只保证「不丢」，不代表危急。
    # 顶部红色预警条只收高风险项，所以这条不会把预警条冲淡。
    for exam in ctx.get("examinations", []) or []:
        if not isinstance(exam, dict) or exam.get("abnormal") is not True:
            continue
        name = str(exam.get("name") or "").strip()
        if not name:
            continue
        conclusion = str(exam.get("conclusion") or "").strip() or "结论为异常"
        detail = str(exam.get("result") or "").strip()
        alerts.append(
            {
                "id": f"hard_exam_{exam.get('id') or name}",
                "name": f"{name}异常",
                "level": "中风险",
                "color": "warning",
                "summary": f"{name}{conclusion}，需在本次就诊中说明处置意见。",
                "evidence": f"{name}（{exam.get('date', '—')}）：{detail or conclusion}",
                "source": "硬规则 · 检查结论标记为异常",
                "threshold": "检查报告 abnormal=true 即触发",
                "suggestion": "结合临床判断是否需要复查、转专科或调整治疗，并在病历中记录。",
                "rule": "abnormal_examination",
            }
        )

    return alerts


class RiskAgent(Agent):
    key = "risk"
    # 配合平台硬规则，漏报有临床后果。回归集只有 1 条用例，
    # 在补足之前不动它 —— 它同时也是 report-summary 的长杆（52.2s）。
    model_tier = "clinical_safety"
    version = "mvp-1.0.0"
    # 风险判断看当前值与阈值，不需要历史趋势数组
    context_fields = (
        "primary_diagnosis", "diagnoses", "past_history", "allergies",
        "vitals", "lab_results", "orders", "examinations",
    )
    needs_exam_detail = False
    role_prompt = (
        "你负责门诊风险识别。对每一项风险给出三段式说明：依据（evidence，引用具体检验值或病史）、"
        "判断（assessment，说明风险性质与走向）、建议（suggestion，可执行的下一步）。"
        "分级只能取「高风险」「中风险」「低风险」之一。"
        "高风险必须同时具备证据、阈值来源与处置建议，三者缺一就降为中风险。"
        "不要重复系统已经通过硬规则识别出的风险项。"
        # evidence 是给医生「一眼回溯」用的：他扫一眼就要能在资料里指出这个数是哪来的。
        # 自己算出来的数（「超标 0.5 倍」）回溯不了 —— 医生得反推你拿哪两个数、怎么算的，
        # 而算错了外表和算对了一模一样。所以宁可只写原值和阈值，让医生自己比。
        "evidence 里的每个数字，只能是资料中原样出现的值，或公认的指南阈值（须写明是目标/参考值）；"
        "不要自己做加减乘除得出新数字，比较关系用文字表述（写「高于目标值」而不是「超标 0.5 倍」）。"
    )
    output_schema = {
        "type": "object",
        "required": ["risk_assessments"],
        "properties": {
            "risk_assessments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["name", "level", "evidence", "assessment", "suggestion"],
                    "properties": {
                        "name": {"type": "string", "description": "风险项名称，如「血糖控制评估」"},
                        "level": {"type": "string", "enum": ["高风险", "中风险", "低风险"]},
                        "summary": {"type": "string"},
                        "evidence": {"type": "string", "description": "依据，必须引用上下文中的具体数值或病史"},
                        "assessment": {"type": "string", "description": "判断"},
                        "suggestion": {"type": "string", "description": "建议"},
                    },
                },
            }
        },
    }

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        hard = kwargs.get("hard_alerts", [])
        hard_names = "、".join(a["name"] for a in hard) or "无"
        return (
            "评估该患者本次就诊的临床风险，产出 2–4 条风险项。\n"
            f"系统硬规则已识别的风险：{hard_names}。这些不要重复输出。\n"
            # 只说「2–4 条」是不够的：P001 有 7 项异常检验 + 2 项异常检查，
            # 四个位置装不下九个异常，**必然**要丢，而丢哪个完全随机。
            # 实测同一个模型两轮里，双眼底 NPDR 一轮写了一轮没写 ——
            # 影像/检查的阳性结论最容易被丢，因为它没有数值，不如化验值「显眼」。
            # 对医生来说这是最坏的丢法：化验单他自己会看，眼底报告他指望你提醒。
            # 所以这里给排序，不是加条数。
            "位置不够时按这个次序取舍：先保证每一条「异常」的检查/影像结论都有对应风险项，"
            "再收化验异常（同一系统的多项化验合并成一条，如血糖与糖化写在一起）。\n"
            "只使用上下文中出现的检验值、体征与病史；缺失的信息在 evidence 中写「未获得」。"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        items = require_list(data, "risk_assessments")
        cleaned = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError("risk_assessments 元素必须是对象")
            level = item.get("level")
            if level not in LEVEL_COLOR:
                raise ValueError(f"非法风险等级：{level}")
            for field in ("name", "evidence", "assessment", "suggestion"):
                if not str(item.get(field) or "").strip():
                    raise ValueError(f"风险项缺少必填字段 {field}")
            # 高风险必须证据、阈值、建议齐备，否则按规格降级为中风险
            cleaned.append(
                {
                    "id": item.get("id") or f"llm_risk_{index}",
                    "name": item["name"],
                    "level": level,
                    "color": LEVEL_COLOR[level],
                    "summary": item.get("summary") or item["assessment"],
                    "evidence": item["evidence"],
                    "assessment": item["assessment"],
                    "suggestion": item["suggestion"],
                    "source": "模型评估",
                }
            )
        return {"risk_assessments": cleaned}

    def fallback(self, ctx: dict, **kwargs) -> dict:
        """按异常检验项生成确定性风险条目。不编造判断，只陈述可核对的事实。"""
        items = []
        for index, lab in enumerate(abnormal_labs(ctx)):
            name = lab.get("name", "检验项")
            trend = lab.get("trend")
            items.append(
                {
                    "id": f"local_{index}",
                    "name": f"{name}异常",
                    "level": "中风险",
                    "color": "warning",
                    "summary": f"{name} {lab.get('value')}{lab.get('unit', '')}，参考范围 {lab.get('ref', '—')}。",
                    "evidence": f"{name}：{lab.get('value')}{lab.get('unit', '')}（参考 {lab.get('ref', '—')}）"
                    + (f"，趋势{trend}" if trend else ""),
                    "assessment": "该项超出参考范围，需结合临床评估。",
                    "suggestion": "复查确认并结合症状判断是否调整治疗方案。",
                    "source": "本地规则 · 检验值超范围",
                }
            )
        return {"risk_assessments": items}


def merge_risks(hard_alerts: list[dict], model_assessments: list[dict]) -> tuple[list[dict], list[dict], list[str]]:
    """
    合并硬规则与模型结果，返回 (全部风险项, 红色预警, 被硬规则压制的模型项名)。

    硬规则结果排在前面且不可被模型覆盖：模型给出的同名风险一律丢弃，
    名称回传给调用方留痕，便于评测时统计冲突率。
    """
    hard_names = {a["name"] for a in hard_alerts}
    merged = list(hard_alerts)
    conflicts = [item["name"] for item in model_assessments if item["name"] in hard_names]
    merged.extend(item for item in model_assessments if item["name"] not in hard_names)

    # risk_alerts 只收红色项，供界面顶部预警条使用
    alerts = [
        {"id": a["id"], "name": a["name"], "level": a["level"], "color": a["color"], "summary": a["summary"]}
        for a in merged
        if a.get("level") == "高风险"
    ]
    return merged, alerts, conflicts
