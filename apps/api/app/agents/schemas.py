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

from pydantic import BaseModel, Field

#: 风险分级闭集。工作站顶部预警条按它取色，多一个值界面就没有对应样式。
RiskLevel = Literal["高风险", "中风险", "低风险"]

#: 共病危险度。**和上面不是一套词** —— 界面上共病卡片用的就是「高危/中危/低危」。
#: 以前顶层字段错用了 RiskLevel 的取值，靠的是没人校验才没炸。
ComorbidityLevel = Literal["高危", "中危", "低危"]


# ---------------------------------------------------------------- 病情概况


class OverallConclusion(BaseModel):
    risk_level: RiskLevel
    summary: str = Field(description="150 字以内的整体概要")
    problems: list[str] = Field(default_factory=list, description="问题清单，每条一句话")
    conflicts: list[str] = Field(
        default_factory=list,
        description="并列陈述的矛盾信息（如自述规律服药但血糖持续升高）；没有则为空数组",
    )


class TreatmentEffectiveness(BaseModel):
    ai_summary: str = Field(description="疗效评价；没有历史数据就写「缺乏可比历史数据」")


class SummaryOut(BaseModel):
    overall_conclusion: OverallConclusion
    treatment_effectiveness: TreatmentEffectiveness


# ---------------------------------------------------------------- 病历生成


class RecordFields(BaseModel):
    """病历七段。**闭集** —— 服务端按段切分流式下发，多一段前端无从对齐。"""

    chief_complaint: str = Field(description="主诉")
    present_illness: str = Field(description="现病史")
    past_history: str = Field(description="既往史")
    personal_history: str = Field(description="个人史")
    physical_exam: str = Field(description="体格检查")
    auxiliary_exam: str = Field(description="辅助检查")
    preliminary_diagnosis: str = Field(description="初步诊断")


class RecordOut(BaseModel):
    fields: RecordFields


# ---------------------------------------------------------------- 鉴别诊断


class SuspectedDiagnosis(BaseModel):
    name: str
    confidence: int = Field(ge=0, le=100, description="0–100，且必须是 5 的倍数")
    icd: str = Field(default="", description="不确定时留空，不要猜")
    desc: str = Field(description="一句话说明该诊断的临床含义")
    suggestion: str = Field(default="", description="针对该诊断的下一步建议，一句话，不要与 desc 重复")
    supporting: list[str] = Field(description="支持证据")
    opposing: list[str] = Field(description="反对证据；没有就写「未获得」，不能留空、不能编造")
    missing: list[str] = Field(description="还缺什么信息")


class DiagnosisOut(BaseModel):
    suspected_diagnoses: list[SuspectedDiagnosis] = Field(
        description="按 confidence 从高到低，最多 5 条"
    )


# ---------------------------------------------------------------- 风险管理


class RiskAssessment(BaseModel):
    name: str = Field(description="风险项名称，如「血糖控制评估」")
    level: RiskLevel
    summary: str = ""
    evidence: str = Field(description="依据，必须引用上下文中的具体数值或病史")
    assessment: str = Field(description="判断：风险性质与走向")
    suggestion: str = Field(description="建议：可执行的下一步，不是「建议关注」这类空话")


class RiskOut(BaseModel):
    risk_assessments: list[RiskAssessment] = Field(description="2–4 条")


# ---------------------------------------------------------------- 共病管理


class ComorbidityCondition(BaseModel):
    name: str
    icd: str = ""
    duration: str = ""
    risk_level: ComorbidityLevel
    analysis: str = Field(description="依据来自哪条病史或检验值")
    recommended_dept: str = Field(description="必须取自科室闭集")


class ComorbidityOut(BaseModel):
    detected: bool
    risk_level: ComorbidityLevel | None = None
    summary: str = ""
    recommendation: str = ""
    conditions: list[ComorbidityCondition] = Field(default_factory=list)


# ---------------------------------------------------------------- 问诊小结


class InterviewSummaryOut(BaseModel):
    chief_complaint: str = Field(description="用患者自己的说法，不要改写成诊断名")
    key_points: list[str] = Field(description="只归纳对话中实际出现的内容")
    gaps: list[str] = Field(description="对话没有涉及、还需要补问的方面")
    summary: str = ""
