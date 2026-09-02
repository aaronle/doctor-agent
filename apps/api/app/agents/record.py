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


def _archived_history(ctx: dict) -> str:
    """
    主档里已记载的既往史 + 过敏史，拼成一段。

    过敏史这里写成「青霉素过敏」而不是「过敏史：青霉素」——
    后者读起来像个字段名，前者才是病历里的话。**主档没记过敏就整句不写**，
    绝不产出「否认过敏史」：那是一次没发生过的问答。
    """
    parts: list[str] = []
    history = str(ctx.get("past_history") or "").strip()
    if history:
        parts.append(history)

    allergies = ctx.get("allergies") or []
    named = [str(a).strip() for a in allergies if str(a).strip()]
    if named:
        parts.append("、".join(named) + "过敏")

    return "；".join(parts)


class RecordAgent(Agent):
    key = "record"
    version = "mvp-1.0.0"
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
    # 这不是 Sonnet 变差，是**这条提示词一直缺一半，只是被上一个模型的习惯盖住了**。
    # 判据要写在提示词里，不能指望模型替你补。
    role_prompt = (
        "你负责根据问诊与检查资料起草门诊病历。\n"
        "硬性要求：\n"
        f"1. 严格输出七段：{'、'.join(SECTION_LABELS.values())}。不增段、不减段、不改名。\n"
        "2. **每一段的资料来源是固定的，先认准来源再决定写什么：**\n"
        "   - 主诉、现病史：本次主诉与问诊对话。\n"
        "   - 既往史：**主档记载的既往史与过敏史**。主档里有就照写，"
        "不要因为本次问诊没问到就写「未采集」—— 那是既有档案，不是本次问出来的。\n"
        "   - 体格检查：只写上下文中已记录的体征，不生成未经证实的项。\n"
        "   - 辅助检查：只写上下文中已有的检验值与检查结论，**每一句都要带上是哪一项检查**。"
        "「未见异常」「大致正常」这类没有主语的话一律不许出现 —— "
        "写「心电图未见明显 ST-T 改变」可以，光写「未见异常」不行，"
        "因为没人知道你指的是哪一项、也无从核对。\n"
        f"3. **只有该段的来源里确实没有资料，才写「{UNCOLLECTED}」**，"
        f"且整段就是这三个字，不要拼在别的话前后（「否认药物过敏史{UNCOLLECTED}」这类是错的）。\n"
        "4. **本次问诊没有涉及的症状或病史，整句略过不写**（既往史里主档已记载的除外）。"
        "不要用「否认…」「无…」「未见…」去补位 —— 那意味着医生问过而患者否认，"
        "凭空写出来就是伪造问诊记录。少写一句是留白，编一句是造假。\n"
        "5. **病历里只写患者的事实，不写关于这份病历本身的话。**"
        "「否认表述均未采集」「本段无相关记录」这类自我说明不是病历内容，一律不要出现；"
        "该留白就按第 3 条写「未采集」三个字。\n"
        "6. 初步诊断中待排的写「待排」，不要表述成确诊。\n"
        "7. 每段是连贯的中文段落，不用列表符号。"
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
