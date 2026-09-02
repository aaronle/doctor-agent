"""
病历生成智能体（F03）。

七段是闭集。服务端按段切分下发，不透传模型自由文本 ——
否则流式过程中 node_id 会漂到枚举之外，前端无从对齐。
"""

from __future__ import annotations

import re

from .base import Agent, require_dict

# 病历七段，顺序即界面展示与流式下发顺序
RECORD_SECTIONS: tuple[tuple[str, str], ...] = (
    ("chief_complaint", "主诉"),
    ("present_illness", "现病史"),
    ("past_history", "既往史"),
    ("personal_history", "个人史"),
    ("physical_exam", "体格检查"),
    ("auxiliary_exam", "辅助检查"),
    ("preliminary_diagnosis", "初步诊断"),
)
SECTION_KEYS = tuple(key for key, _ in RECORD_SECTIONS)
SECTION_LABELS = dict(RECORD_SECTIONS)

# 未采集就必须留白。写「否认」等于替患者作了一次没发生过的问答。
UNCOLLECTED = "未采集"


def _allergy_sentence(ctx: dict) -> str:
    """
    既往史里那句过敏史。**由代码写，不交给模型。**

    三种状态对应三种写法，这是确定的映射，不是判断题：

    | allergy_status | 病历里写什么 |
    | --- | --- |
    | `confirmed` | `青霉素过敏` |
    | `denied` | `否认药物过敏史` |
    | `unknown` | **什么都不写** |

    交给模型的代价实测过：P004 / P005 两位「未采集」患者，模型照样写了
    「否认药物过敏史」—— 那是替患者作了一次没发生过的问答，而病历上看不出区别。
    十条回归里这两条稳定失败。

    `unknown` 留白而不是写「过敏史未采集」：病历里不写关于病历本身的话
    （见 SKILL.md 硬性要求）。医生需要知道这件事，但那由界面的黄色标记承担，
    不是往病历正文里塞一句自我说明。
    """
    status = str(ctx.get("allergy_status") or "").strip().lower()
    items = ctx.get("allergies") or []
    if isinstance(items, str):
        items = [items] if items.strip() else []
    named = [str(a).strip() for a in items if str(a).strip()]

    if not status:
        status = "confirmed" if named else "unknown"
    if status == "confirmed" and named:
        # 写成「青霉素过敏」而不是「过敏史：青霉素」—— 后者读起来像字段名，前者才是病历里的话
        return "、".join(named) + "过敏"
    if status == "denied":
        return "否认药物过敏史"
    return ""


_DENIAL_PATTERN = re.compile(r"[^。；;\n]*否认[^。；;\n]*过敏[^。；;\n]*[。；;]?")


def _strip_unauthorized_denial(text: str, ctx: dict) -> str:
    """
    过敏史未采集时，删掉模型自己写的「否认药物过敏史」。

    只在 `unknown` 时动手：`denied` 状态下那句话是**档案里的既有记录**，照写是对的。
    分不清这两者，正是这次改造要解决的问题本身，不能在这里又合并回去。
    """
    if str(ctx.get("allergy_status") or "").strip().lower() != "unknown":
        return text
    cleaned = _DENIAL_PATTERN.sub("", text).strip()
    return cleaned or UNCOLLECTED


def _archived_history(ctx: dict) -> str:
    """主档里已记载的既往史 + 过敏史，拼成一段。"""
    parts: list[str] = []
    history = str(ctx.get("past_history") or "").strip()
    if history:
        parts.append(history)
    allergy = _allergy_sentence(ctx)
    if allergy:
        parts.append(allergy)
    return "；".join(parts)


class RecordAgent(Agent):
    key = "record"
    version = "mvp-1.0.0"
    # 2026-09-02 由 Sonnet 换回 Haiku。**六个岗位里唯一有 A/B 数据的一个**：
    # 同一套 10 条回归集两个模型都是 10/10，而耗时 45.8s → 5.0s。
    # 这一段是「读证据 → 按七段转写」，不是推理，快档名副其实。
    model_tier = "clinical_fast"
    # 病历要引用对话原文与检查结论，但不需要检验历史值
    context_fields = (
        "primary_diagnosis", "diagnoses", "past_history", "allergies",
        "vitals", "lab_results", "examinations", "dialog_script",
    )
    needs_exam_detail = False
    # 2026-09-02 重写第 2–4 条。
    #
    # 原文只有一句「上下文中没有提及的内容一律写未采集」，**没说每一段的资料来源是什么**。
    # Haiku 会顺手把主档既往史抄进去，所以一直是 10/10；换 Sonnet 后它开始较真
    # 「本次问诊没问过既往史」，于是明明主档里写着「2型糖尿病 5 年」也填「未采集」——
    # 十条用例掉到三到五条。
    #
    skill = "record-generation"
    output_schema = {
        "type": "object",
        "required": ["fields"],
        "properties": {
            "fields": {
                "type": "object",
                "required": list(SECTION_KEYS),
                "properties": {key: {"type": "string"} for key in SECTION_KEYS},
            }
        },
    }

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        note = str(kwargs.get("note_text") or "").strip()
        extra = f"\n医生已录入的内容（须保留其含义，可整理措辞）：\n{note}" if note else ""
        return (
            "起草本次就诊的门诊病历七段。\n"
            "资料来源仅限患者上下文中的主诉、既往史、检验值、体征、对话脚本。"
            f"任何一段**它自己的来源里**没有可用资料，才写「{UNCOLLECTED}」——"
            "主档已记载的既往史属于有资料。"
            f"{extra}"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        fields = require_dict(data, "fields")
        missing = [key for key in SECTION_KEYS if key not in fields]
        if missing:
            raise ValueError(f"病历缺少段落：{'、'.join(missing)}")
        cleaned = {key: str(fields.get(key) or "").strip() or UNCOLLECTED for key in SECTION_KEYS}

        # 既往史是**主档里已有的事实**，不是这次问出来的，所以它不该取决于模型的心情。
        #
        # 提示词已经写清了「主档里有就照写」，Sonnet 大多数时候照做，但仍会偶尔
        # 填「未采集」—— 而这个模型上 temperature 已废弃，压不住抖动（见 15 号文档 §6）。
        # 与其把一条确定的事实交给概率，不如让代码兜底：模型漏了就补，写了就不动。
        #
        # 只在模型**整段留白**时才补。它若结合问诊补充了内容，那是它该做的事，不覆盖。
        if cleaned["past_history"] == UNCOLLECTED:
            archived = _archived_history(ctx)
            if archived:
                cleaned["past_history"] = archived
        else:
            # 模型写了既往史时，兜底不触发 —— 但那句过敏史仍然要管。
            #
            # 实测 P004 / P005（两位「过敏史未采集」的初诊患者）：模型照样写
            # 「否认药物过敏史」。病历上看不出任何异样，而事实是**没有人问过**。
            # 提示词里已经写明了，模型大多数时候照做；这个模型上 temperature 已废弃，
            # 压不住剩下那部分抖动。红线不能靠概率守。
            cleaned["past_history"] = _strip_unauthorized_denial(cleaned["past_history"], ctx)

        return {"fields": cleaned}

    def fallback(self, ctx: dict, **kwargs) -> dict:
        """
        降级时用结构化数据直接拼装，只填能从上下文确证的段落，
        其余一律留「未采集」—— 不猜、不补。
        """
        vitals = ctx.get("vitals") or {}
        vital_text = "、".join(
            f"{label}{vitals[key]}"
            for key, label in (("bp", "血压"), ("hr", "心率"), ("temp", "体温"), ("spo2", "血氧"))
            if vitals.get(key)
        )
        labs = ctx.get("lab_results") or []
        lab_text = "；".join(
            f"{lab.get('name')} {lab.get('value')}{lab.get('unit', '')}"
            for lab in labs
            if isinstance(lab, dict) and lab.get("name")
        )

        return {
            "fields": {
                "chief_complaint": ctx.get("chief_complaint") or UNCOLLECTED,
                "present_illness": UNCOLLECTED,
                "past_history": str(ctx.get("past_history") or "") or UNCOLLECTED,
                "personal_history": UNCOLLECTED,
                "physical_exam": vital_text or UNCOLLECTED,
                "auxiliary_exam": lab_text or UNCOLLECTED,
                "preliminary_diagnosis": ctx.get("primary_diagnosis") or UNCOLLECTED,
            }
        }


class RecordFieldAgent(Agent):
    """
    单段续写。语义是「基于医生已输入内容往下写」，不是整段重写 ——
    医生自己敲的字不能被模型悄悄替换掉。
    """

    key = "record_field"
    version = "mvp-1.0.1"
    context_fields = (
        "primary_diagnosis", "diagnoses", "past_history", "allergies",
        "vitals", "lab_results", "examinations", "dialog_script",
    )
    needs_exam_detail = False
    skill = "record-field-continuation"
    output_schema = {
        "type": "object",
        "required": ["generated_text"],
        "properties": {"generated_text": {"type": "string"}},
    }

    def task_instruction(self, ctx: dict, **kwargs) -> str:
        field = kwargs.get("field", "")
        label = SECTION_LABELS.get(field, field)
        note = str(kwargs.get("note_text") or "").strip()
        return (
            f"续写病历的「{label}」段。\n"
            f"医生已录入：{note or '（空）'}\n"
            "在此基础上补全该段，使其成为通顺完整的一段病历文本。"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        text = str(data.get("generated_text") or "").strip()
        if not text:
            raise ValueError("generated_text 不能为空")
        return {"generated_text": text}

    def fallback(self, ctx: dict, **kwargs) -> dict:
        """降级时原样返回医生输入，只补句号 —— 与 V4.3 的 mock 语义一致。"""
        note = str(kwargs.get("note_text") or "").strip()
        if note and note[-1] not in "。！？；.!?;":
            note += "。"
        return {"generated_text": note or UNCOLLECTED}
