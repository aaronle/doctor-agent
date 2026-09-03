"""六个岗位的输出模型。

## 为什么从 JSON Schema dict 换成 Pydantic

在此之前，每个岗位手写一份 `output_schema` dict，**塞进提示词里让模型照着输出**，
回来再手写 `validate()` 逐字段检查类型、枚举、必填。这条链路上有三个问题：

1. **schema 只是建议。** 它是提示词里的一段文字，模型可以不照做 ——
   于是安全层里长出了「只输出 JSON 对象」「字符串内不得出现半角双引号」两条，
   而后者是在跟一个真实事故搏斗：未转义的半角引号会截断 JSON，整份输出被丢弃。
   用 AgentScope 的 `structured_model` 之后，输出形状由**工具调用的参数 schema**
   保证，不再是恳求模型配合。
2. **校验散落且不齐。** 比如共病：顶层 `risk_level` 的枚举写的是「高风险/中风险/低风险」，
   条目级写的是「高危/中危/低危」，提示词只说了后者，而 `validate()` **根本没检查顶层**。
   三处说法不一致、没有任何东西会报错 —— 这正是手写校验的典型下场。
3. **两份真相。** schema 在 `.py`、给模型看的说明在提示词，改一处忘一处不会有人发现。

Pydantic 模型同时是：给模型的 schema、回来的校验器、给人读的契约。**只有一份。**

## 留在 `validate()` 里的是什么

Pydantic 管**形状**，`validate()` 只管**临床归一化** —— 那些不是类型问题、
而是「产品要求它长成什么样」的规则：

- 诊断置信度取 5 的倍数（模型没有更细的精度，给了也是假的）
- 反对证据为空时补「未获得」（规格要求显式写出，不许空列表悄悄通过）
- 病历既往史缺失时用主档回填（那是确定的事实，不该交给概率）

这两类东西分开之后，各自都短了很多，也终于说得清各自在管什么。
"""

from __future__ import annotations

from typing import Literal

import json
import re

from pydantic import BaseModel, Field, model_validator


#: 模型把**列表**字段编码成字符串时用的标签。
#:
#: 实测（claude-sonnet-5）：`InterviewSummaryOut` 的 `key_points` 与 `gaps`
#: 两个相邻的 `list[str]` 会被**稳定地**糊成一个字符串 ——
#:
#:     key_points: "\n<item>患者主诉…</item>\n<item>…</item>\n</gaps>\n"
#:
#: 提示词里一个尖括号都没有，是模型自发这么编的。后果是 `interview_agent`
#: **100% 降级** —— 问诊小结这个岗位实际上从来没工作过，线上也一样。
#:
#: 定义在模块级而不是类属性：Pydantic 会把下划线开头的类属性收成
#: `ModelPrivateAttr`，`cls._ITEM_TAG.findall` 会炸。
_ITEM_TAG = re.compile(r"<item>(.*?)</item>", re.S)


class ToolCallModel(BaseModel):
    """
    所有输出模型的基类：把嵌套对象「被序列化成字符串」这件事拉平。

    实测（claude-sonnet-5，本项目网关）：工具调用的参数里，嵌套对象**约三次里有一次**
    会以 JSON 字符串的形式回来 ——

        overall_conclusion: '{"risk_level":"高风险",...}'   ← str，不是 dict

    Pydantic 直接判 `model_type` 失败，岗位随即静默降级到本地规则。
    界面上看是一段「模型通道不可用，以上为结构化数据直接汇总」的兜底文本，
    而模型其实答得好好的 —— **静默降级正是这个项目栽过的那种坑**。

    判据刻意收窄：只处理「以 `{` 或 `[` 开头、且能整段解析」的字符串。
    解析不了就原样留给 Pydantic 报错 —— 这不是第二个 `extract_json_object`，
    那个函数从自由文本里连蒙带猜地抠 JSON，而这里只是把一层多余的编码剥掉。
    """


    @model_validator(mode="before")
    @classmethod
    def _unwrap_stringified_objects(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        out = {}
        for key, value in data.items():
            # 列表被编码成 `<item>…</item>` 串。**这不是连蒙带猜**：
            # 它是一个明确的、可精确解析的编码，还原它只是把多余的一层剥掉。
            # 解析不出条目就原样留给 Pydantic 报错，不做任何猜测性的切分
            #（比如按换行拆）—— 那才会变成第二个 `extract_json_object`。
            if isinstance(value, str) and "<item>" in value:
                items = [x.strip() for x in _ITEM_TAG.findall(value) if x.strip()]
                if items:
                    out[key] = items
                    continue
            if isinstance(value, str) and value[:1] in "{[":
                try:
                    # `strict=False` 允许字符串值内部出现裸换行。
                    #
                    # 这不是放水，是这里的必需项：模型把一段多行的病情概要
                    # 序列化进字符串字段时不会转义 `\n`，而严格模式会报
                    # `Invalid control character` 直接拒掉整份输出 ——
                    # 于是岗位静默降级，而模型答得完全正确。
                    value = json.loads(value, strict=False)
                except (json.JSONDecodeError, ValueError):
                    pass          # 解析不了就别动，让 Pydantic 如实报错
            out[key] = value
        return out



#: 会诊科室闭集。**住在这里是因为它是输出契约的一部分** ——
#: 它同时是 Pydantic schema 的 enum（约束模型生成）、`validate()` 的判据、
#: 以及 SKILL.md 里 `<DEPARTMENTS>` 占位符的值。三处用同一个来源。
#:
#: 本院没有的科室不得出现：患者会照着去挂号，挂不到就是医院的事故。
DEPARTMENTS = (
    "内分泌科", "心内科", "神经内科", "肾内科", "消化内科", "呼吸内科",
    "血液科", "风湿免疫科", "普外科", "骨科", "妇科", "眼科",
    "营养科", "康复科", "精神心理科", "全科医学科",
)

#: 风险分级闭集。工作站顶部预警条按它取色，多一个值界面就没有对应样式。
RiskLevel = Literal["高风险", "中风险", "低风险"]

#: 共病危险度。**和上面不是一套词** —— 界面上共病卡片用的就是「高危/中危/低危」。
#: 以前顶层字段错用了 RiskLevel 的取值，靠的是没人校验才没炸。
ComorbidityLevel = Literal["高危", "中危", "低危"]


# ---------------------------------------------------------------- 病情概况


class OverallConclusion(ToolCallModel):
    risk_level: RiskLevel
    summary: str = Field(description="150 字以内的整体概要")
    problems: list[str] = Field(default_factory=list, description="问题清单，每条一句话")
    conflicts: list[str] = Field(
        default_factory=list,
        description="并列陈述的矛盾信息（如自述规律服药但血糖持续升高）；没有则为空数组",
    )


class TreatmentEffectiveness(ToolCallModel):
    ai_summary: str = Field(description="疗效评价；没有历史数据就写「缺乏可比历史数据」")


class SummaryOut(ToolCallModel):
    overall_conclusion: OverallConclusion
    treatment_effectiveness: TreatmentEffectiveness


# ---------------------------------------------------------------- 病历生成


class RecordFields(ToolCallModel):
    """病历七段。**闭集** —— 服务端按段切分流式下发，多一段前端无从对齐。"""

    chief_complaint: str = Field(description="主诉")
    present_illness: str = Field(description="现病史")
    past_history: str = Field(description="既往史")
    personal_history: str = Field(description="个人史")
    physical_exam: str = Field(description="体格检查")
    auxiliary_exam: str = Field(description="辅助检查")
    preliminary_diagnosis: str = Field(description="初步诊断")


class RecordOut(ToolCallModel):
    fields: RecordFields


# ---------------------------------------------------------------- 鉴别诊断


class SuspectedDiagnosis(ToolCallModel):
    name: str
    confidence: int = Field(ge=0, le=100, description="0–100，且必须是 5 的倍数")
    #: 原来写的是「不确定时留空，不要猜」—— 防编造的本意是对的，
    #: 但**结果是全部留空**：实测 P006 五条诊断（脑梗死、高血压、2型糖尿病、
    #: 高脂血症、颈动脉粥样硬化）一个编码都没给，而这些的 ICD-10 是确定的。
    #: 过度保守和编造一样，都是没把该给的信息给医生。
    icd: str = Field(
        default="",
        description="ICD-10 编码。常见诊断请给出（如 2型糖尿病 E11.9、原发性高血压 I10、"
                    "脑梗死 I63.9）；罕见诊断或亚型拿不准时留空，**不要猜一个近似的**",
    )
    desc: str = Field(description="一句话说明该诊断的临床含义")
    suggestion: str = Field(default="", description="针对该诊断的下一步建议，一句话，不要与 desc 重复")
    supporting: list[str] = Field(description="支持证据")
    opposing: list[str] = Field(description="反对证据；没有就写「未获得」，不能留空、不能编造")
    missing: list[str] = Field(description="还缺什么信息")


class DiagnosisOut(ToolCallModel):
    suspected_diagnoses: list[SuspectedDiagnosis] = Field(
        description="按 confidence 从高到低，最多 5 条"
    )


# ---------------------------------------------------------------- 风险管理


class RiskAssessment(ToolCallModel):
    name: str = Field(description="风险项名称，如「血糖控制评估」")
    level: RiskLevel
    summary: str = ""
    evidence: str = Field(description="依据，必须引用上下文中的具体数值或病史")
    assessment: str = Field(description="判断：风险性质与走向")
    suggestion: str = Field(description="建议：可执行的下一步，不是「建议关注」这类空话")


class RiskOut(ToolCallModel):
    risk_assessments: list[RiskAssessment] = Field(description="2–4 条")


# ---------------------------------------------------------------- 共病管理


class ComorbidityCondition(ToolCallModel):
    name: str
    icd: str = ""
    duration: str = ""
    risk_level: ComorbidityLevel
    analysis: str = Field(description="依据来自哪条病史或检验值")
    #: 科室闭集直接写进 schema 的 enum，模型在**生成时**就受约束，
    #: 而不是生成完再被 validate() 打回来降级。闭集本身仍只有 DEPARTMENTS 一个来源。
    recommended_dept: str = Field(
        description="会诊科室，必须取自本院科室闭集",
        json_schema_extra={"enum": list(DEPARTMENTS)},
    )


class ComorbidityOut(ToolCallModel):
    detected: bool
    risk_level: ComorbidityLevel | None = None
    summary: str = ""
    recommendation: str = ""
    conditions: list[ComorbidityCondition] = Field(default_factory=list)


# ---------------------------------------------------------------- 问诊小结


class InterviewSummaryOut(ToolCallModel):
    chief_complaint: str = Field(description="用患者自己的说法，不要改写成诊断名")
    key_points: list[str] = Field(description="只归纳对话中实际出现的内容")
    gaps: list[str] = Field(description="对话没有涉及、还需要补问的方面")
    summary: str = ""


# ---------------------------------------------------------------- AI 追问提示


class FollowUpPlanOut(ToolCallModel):
    """追问清单：这次问诊**该问**的问题。"""

    questions: list[str] = Field(
        description=(
            "追问问题清单，6–10 条。**每条只问一件事**（原子问项）——"
            "「疼多久了、有没有肿」是两条，不是一条。"
            "复合问句会让后面的覆盖判定必然出错：患者只答了一半，判「已问到」是错的，"
            "判「没问到」也是错的。用医生对患者说话的口气写，不要写成检查项名称。"
        )
    )


class CoveredItem(ToolCallModel):
    """一条被判定为「已问到」的问题，**必须带患者原话**。"""

    question: str = Field(description="原样抄回清单里的那条问题，不要改写")
    quote: str = Field(
        description=(
            "**患者原话**，从对话里逐字摘录，用来证明这条确实问到了。"
            "找不到能证明的原话就不要把这条列进来。"
        )
    )


class FollowUpCoverageOut(ToolCallModel):
    """覆盖判定：清单里哪些已经被问到了。

    只回「已覆盖」的，不回「未覆盖」—— 没被提到的自然还开着。
    这样漏判的默认后果是「继续提醒」，而不是「不再提醒」。
    """

    covered: list[CoveredItem] = Field(
        default_factory=list,
        description="已经问到的条目。拿不准的**一律不要列**，宁可漏标。",
    )


# ---------------------------------------------------------------- 病历单段续写


class RecordFieldOut(ToolCallModel):
    generated_text: str = Field(description="这一段的文本，不要写段名，不要写其他段")
