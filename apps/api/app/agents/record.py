"""
病历生成智能体（F03）。

七段是闭集。服务端按段切分下发，不透传模型自由文本 ——
否则流式过程中 node_id 会漂到枚举之外，前端无从对齐。
"""

from __future__ import annotations

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


class RecordAgent(Agent):
    key = "record"
    version = "mvp-1.0.0"
    # 病历要引用对话原文与检查结论，但不需要检验历史值
    context_fields = (
        "primary_diagnosis", "diagnoses", "past_history", "allergies",
        "vitals", "lab_results", "examinations", "dialog_script",
    )
    needs_exam_detail = False
    role_prompt = (
        "你负责根据问诊与检查资料起草门诊病历。\n"
        "硬性要求：\n"
        f"1. 严格输出七段：{'、'.join(SECTION_LABELS.values())}。不增段、不减段、不改名。\n"
        f"2. **上下文中没有提及的内容，一律写「{UNCOLLECTED}」。**"
        "绝对不允许写「否认药物过敏史」「无吸烟史」这类未经问诊的否定表述 —— "
        "写「否认」意味着医生问过而患者否认，凭空写出来就是伪造问诊记录。\n"
        "3. 不生成未经证实的体征。体格检查只写上下文中已记录的项。\n"
        "4. 初步诊断中待排的写「待排」，不要表述成确诊。\n"
        "5. 每段是连贯的中文段落，不用列表符号。"
    )
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
            f"任何一段没有可用资料就写「{UNCOLLECTED}」。{extra}"
        )

    def validate(self, data: dict, ctx: dict) -> dict:
        fields = require_dict(data, "fields")
        missing = [key for key in SECTION_KEYS if key not in fields]
        if missing:
            raise ValueError(f"病历缺少段落：{'、'.join(missing)}")
        cleaned = {key: str(fields.get(key) or "").strip() or UNCOLLECTED for key in SECTION_KEYS}
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
    role_prompt = (
        "你负责在医生已录入内容的基础上，续写门诊病历的**指定一段**。\n"
        "硬性要求：\n"
        "1. 保留医生原文的全部信息，只在其后补充或整理，不得删改原意。\n"
        "2. 上下文没有依据的内容不要补。宁可只回原文，也不要编造。\n"
        "3. **体格检查段只能写上下文中已记录的体征数值（如血压、心率、体温、BMI）。**"
        "绝对不允许补写「心肺听诊未闻异常」「腹软无压痛」「双下肢无浮肿」这类查体所见 —— "
        "这些体征只有医生真正查过才存在，凭空写出来就是伪造查体记录。\n"
        "4. 同理，未经问诊的「否认」「无」也不得出现。\n"
        "5. 只输出这一段的文本，不要写段名，不要写其他段。"
    )
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
