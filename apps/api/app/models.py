"""
一期数据模型。

分三组：
  - 临床种子：从 references/ui-demo/extracted/fixtures/ 导入，运行期只读。
  - 运行时写入：医嘱、转诊、住院、问诊记录、病历草稿、提醒。
  - Agent 与治理：版本、每次运行记账、审计、请求日志。

一期只用虚构病例，不接真实患者数据。
"""

from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------- 临床种子


class Patient(Base):
    __tablename__ = "patients"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    gender: Mapped[str] = mapped_column(String(8))
    age: Mapped[int] = mapped_column(Integer)
    #: 出生日期 `YYYY-MM-DD`。**由 id_no 推导，不手工录**（见 seed.py）——
    #: 两处各录一次必然会漂，而修 fixture 时发现七个患者里五个已经漂了。
    #: 界面上只显示到月：门诊核对身份用不到日，写全反而把那一行挤爆。
    birth_date: Mapped[str] = mapped_column(String(16), default="")
    id_no: Mapped[str] = mapped_column(String(64), default="")
    phone: Mapped[str] = mapped_column(String(32), default="")
    visit_type: Mapped[str] = mapped_column(String(32), default="")
    dept: Mapped[str] = mapped_column(String(64), default="")
    doctor: Mapped[str] = mapped_column(String(64), default="")
    visit_date: Mapped[str] = mapped_column(String(32), default="")
    chief_complaint: Mapped[str] = mapped_column(Text, default="")
    primary_diagnosis: Mapped[str] = mapped_column(String(255), default="")
    risk_level: Mapped[str] = mapped_column(String(32), default="")
    is_return_visit: Mapped[bool] = mapped_column(Boolean, default=False)
    pre_consultation_done: Mapped[bool] = mapped_column(Boolean, default=False)
    nutrition_screening_score: Mapped[int] = mapped_column(Integer, default=0)
    in_queue: Mapped[bool] = mapped_column(Boolean, default=True)
    # 结构化临床明细整体存 JSON：一期不做跨患者的结构化检索，
    # 拆表只会增加迁移成本而没有查询收益。
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


class Drug(Base):
    __tablename__ = "drugs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


class SeedDocument(Base):
    """
    评估、病历七段、共病、对话脚本、时间轴、检查报告六类按患者维度的种子。

    它们形状各异且只按 patient_id 整取，用一张 kind + patient_id 的宽表比
    建六张结构近似的表更简单，也让新增种子类型不必改 schema。
    """

    __tablename__ = "seed_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    patient_id: Mapped[str] = mapped_column(String(32), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


# ---------------------------------------------------------------- 运行时写入


class Order(Base):
    """医嘱与检查申请。category 区分 drug / exam，与 V4.3 的响应字段一致。"""

    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    patient_id: Mapped[str] = mapped_column(String(32), index=True)
    category: Mapped[str] = mapped_column(String(16), index=True)
    name: Mapped[str] = mapped_column(String(128))
    dose: Mapped[str] = mapped_column(String(64), default="")
    freq: Mapped[str] = mapped_column(String(64), default="")
    route: Mapped[str] = mapped_column(String(64), default="")
    days: Mapped[str] = mapped_column(String(32), default="")
    exam_type: Mapped[str] = mapped_column(String(32), default="")
    status: Mapped[str] = mapped_column(String(32), default="新开")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Referral(Base):
    """转诊与会诊申请（含营养科会诊）。"""

    __tablename__ = "referrals"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    patient_id: Mapped[str] = mapped_column(String(32), index=True)
    target_dept: Mapped[str] = mapped_column(String(64), default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Admission(Base):
    __tablename__ = "admissions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    patient_id: Mapped[str] = mapped_column(String(32), index=True)
    patient_name: Mapped[str] = mapped_column(String(64), default="")
    target_dept: Mapped[str] = mapped_column(String(64), default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class InterviewSession(Base):
    """
    一场问诊的记录：对话、小结、结构化分析。

    **表名仍是 `voice_sessions`，是有意保留的。**

    2026-09-03 类名从 `VoiceSession` 改成 `InterviewSession` —— 因为「语音」
    在这个产品里名不副实：全仓零行语音识别代码（没有 SpeechRecognition、
    MediaRecorder、getUserMedia），实际形态是一个文本框，医生用系统的
    语音输入法或直接打字填，加一段脚本对话回放。

    但表名没跟着改：生产库里有真实的演示问诊记录，`create_all` 不做迁移，
    改名会建一张空表、把旧数据孤儿化。**为一个内部命名去冒丢数据的风险不划算。**
    等哪天有了迁移机制再一起改；在此之前，这段注释就是那个「为什么不一致」的答案。
    """

    __tablename__ = "voice_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    patient_id: Mapped[str] = mapped_column(String(32), index=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    messages: Mapped[list] = mapped_column(JSON, default=list)
    analysis: Mapped[dict] = mapped_column(JSON, default=dict)
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RecordDraft(Base):
    """病历草稿。七段存 JSON，每次生成递增 version，保留来源映射便于追溯。"""

    __tablename__ = "record_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(String(32), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    fields: Mapped[dict] = mapped_column(JSON, default=dict)
    provenance: Mapped[dict] = mapped_column(JSON, default=dict)
    provider: Mapped[str] = mapped_column(String(32), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Reminder(Base):
    __tablename__ = "reminders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(String(32), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------------------------------------------------------- Agent 与治理


class AgentVersion(Base):
    """
    Agent 配置版本。

    配置从代码里提出来，运行时读**已发布**版本，代码里的类属性只作兜底。
    这样调 Prompt、换模型档位、改阈值都不需要发版。

    同一 agent_key 同时只能有一个 published 版本；发布不覆盖旧版本，
    而是把旧版本置为 inactive 并新增一条 —— 历史可查、可回滚。
    """

    __tablename__ = "agent_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_key: Mapped[str] = mapped_column(String(32), index=True)
    version: Mapped[str] = mapped_column(String(32))
    # 模型档位是稳定别名，不把具体模型名散落在业务代码里
    model_tier: Mapped[str] = mapped_column(String(32), default="clinical_fast")
    model: Mapped[str] = mapped_column(String(64), default="")
    # 岗位层 Prompt。平台安全层不在此列 —— 它只能随代码发布，管理员不可编辑
    role_prompt: Mapped[str] = mapped_column(Text, default="")
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    prompt_bundle_version: Mapped[str] = mapped_column(String(32), default="")
    prompt_hash: Mapped[str] = mapped_column(String(64), default="")
    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)
    note: Mapped[str] = mapped_column(Text, default="")
    author: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentRun(Base):
    """
    每次 Agent 调用的记账。

    刻意不存完整病历：input_digest 只保留摘要与哈希，够定位问题，
    又不让一份可导出的运行日志变成病历副本。
    """

    __tablename__ = "agent_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_key: Mapped[str] = mapped_column(String(32), index=True)
    patient_id: Mapped[str] = mapped_column(String(32), index=True)
    model: Mapped[str] = mapped_column(String(64), default="")
    provider: Mapped[str] = mapped_column(String(32), default="")
    status: Mapped[str] = mapped_column(String(16), default="")
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    prompt_bundle_version: Mapped[str] = mapped_column(String(32), default="")
    input_digest: Mapped[dict] = mapped_column(JSON, default=dict)
    output: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor: Mapped[str] = mapped_column(String(64), default="")
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[str] = mapped_column(String(64), default="")
    patient_id: Mapped[str] = mapped_column(String(32), index=True, default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OperationLog(Base):
    __tablename__ = "operation_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(String(64), index=True)
    method: Mapped[str] = mapped_column(String(8), default="")
    path: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[int] = mapped_column(Integer, default=0)
    elapsed_ms: Mapped[float] = mapped_column(Float, default=0.0)
    error_code: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

class DeliveryRun(Base):
    """
    一次交付流水线运行。两条线共用这张表，靠 `lane` 区分。

    **功能线与智能体线并排、不合并**，理由见
    `docs/product/16-交付平台-CICD需求规格说明书.md` §1：阶段名看着一样，
    但失败的含义完全不同 —— 功能线失败是「构建挂了」，一眼看得见；
    智能体线失败是「输出退化了」，测试照样全绿。

    但它们的**记录结构**是一样的（一串有序阶段，各有状态与耗时），
    所以存一张表、查询时按 lane 分开。共用结构不等于共用判定。

    `stages` 用 JSON 而不是拆子表：阶段是整体替换的（每次上报覆盖当前快照），
    从来不需要单独查某一个阶段，拆表只会换来一次 join。
    """

    __tablename__ = "delivery_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    #: 上报方生成的幂等键。功能线用提交号，智能体线用 `<agent_key>@<草稿哈希>`。
    #: 同一个 key 重复上报是更新而不是新增 —— 部署脚本会分多次上报同一次运行。
    run_key: Mapped[str] = mapped_column(String(96), unique=True, index=True)
    lane: Mapped[str] = mapped_column(String(16), index=True)  # feature | agent
    title: Mapped[str] = mapped_column(String(255), default="")
    subtitle: Mapped[str] = mapped_column(Text, default="")
    #: running | passed | failed | deployed | blocked
    status: Mapped[str] = mapped_column(String(16), default="running", index=True)
    #: [{name, status, detail, elapsed_ms, note}]，有序
    stages: Mapped[list] = mapped_column(JSON, default=list)
    #: 提交号、分支、改动文件、构建日志尾部等
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class FeatureRelease(Base):
    """
    功能制品的发布记录。

    **只存功能线。** 智能体线的发布记录已经在 `agent_versions` 里
    （`status=published` + `published_at`），再存一份就会有两个真相，
    而且回滚走的是 `agent_versions` 那条路径 —— 复制过来的那份必然过期。
    发布历史接口在查询时把两边合成一条时间线，见 `routers/delivery.py`。
    """

    __tablename__ = "feature_releases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    commit: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(255), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    image: Mapped[str] = mapped_column(String(128), default="")
    #: current | superseded | rolled_back
    status: Mapped[str] = mapped_column(String(16), default="current", index=True)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    released_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EvalDatasetState(Base):
    """
    评测数据集的启停状态。

    只存开关，不存内容 —— 数据集本身是 `app/data/eval_datasets/*.json`，
    属于只读的事实；「这次跑不跑」是环境状态，两者分开。
    库里没有某个数据集的记录时，取文件里的 default_enabled。
    """

    __tablename__ = "eval_dataset_states"

    dataset_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


# ---------------------------------------------------------------- 数据沉淀


class TrainingSample(Base):
    """
    微调语料：一次「AI 给了什么 / 医生最后要了什么」的配对。

    ## 为什么单独一张表，而不是从 agent_runs 里捞

    `agent_runs.output` 里已经有模型的每一次输出。**但拿它去微调，等于让模型
    学它自己已经会的东西。** 真正的监督信号是**医生的修改**：AI 写「现病史：
    患者 3 天前晨起…」，医生改成「5 天前午后…」—— 那几个字的差异才是标注。

    所以这张表的主键信息是 `ai_output` / `doctor_output` 这一对，
    以及 `verdict`（采纳 / 改过 / 丢弃）。缺了 `doctor_output` 的行是**半成品**，
    只有参考价值，没有训练价值。

    ## trainable：合规闸，默认按数据来源定

    现在库里全是虚构演示数据（`source="fixture"`），怎么用都行，所以默认 True。
    **接真实 HIS 之后默认 False** —— 真实患者数据用于模型训练要过去标识化、
    伦理审批、患者知情同意，那是人来判断的事，不该由一行代码默认放行。

    `deidentified` 单独一列而不是并进 trainable：「能用」和「已脱敏」是两件事，
    合并成一个布尔值之后，将来没人说得清某一行到底过了哪一关。
    """

    __tablename__ = "training_samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    patient_id: Mapped[str] = mapped_column(String(32), index=True)
    #: 哪个岗位的产出（record / diagnosis / risk / …）
    agent_key: Mapped[str] = mapped_column(String(32), index=True)
    #: 这一对语料对应的动作（submit_record / write_back_diagnosis / …）
    task: Mapped[str] = mapped_column(String(48), index=True, default="")

    #: 送进模型的完整上下文。**存全量**（2026-09-04 产品决策）——
    #: 此前 agent_runs 刻意只存摘要哈希，那是为了不让运行日志变成病历副本；
    #: 而微调需要完整输入，这是一次显式的隐私权衡，由 trainable/deidentified 把关。
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    ai_output: Mapped[dict] = mapped_column(JSON, default=dict)
    #: 医生定稿。为空 = 还没定稿，这一行没有训练价值
    doctor_output: Mapped[dict] = mapped_column(JSON, default=dict)

    #: accepted（一字未改）/ edited（改过）/ discarded（整段丢弃）
    verdict: Mapped[str] = mapped_column(String(16), index=True, default="")
    #: 改了哪些字段、各改了多少 —— 用来快速筛「模型总在哪里写错」
    changed: Mapped[dict] = mapped_column(JSON, default=dict)

    #: 数据来源：fixture（虚构演示）/ his（真实院内）
    source: Mapped[str] = mapped_column(String(16), default="fixture")
    trainable: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    deidentified: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class UsageEvent(Base):
    """
    埋点：医生实际点了什么。

    ## 为什么不复用 operation_logs

    那张表是 **HTTP 级**的（method / path / status / 耗时），能回答
    「哪个接口调得多」，回答不了「哪个按钮点得多」—— 而后者才是产品要问的。
    大量交互根本不发请求：关掉追问提示浮框、调字号、全屏、拖窗口、切标签页。

    ## 一行一个事件，不做聚合

    聚合口径会变（今天想看按天、明天想看按科室），而原始事件只采一次。
    存原始行、查询时再聚合 —— 反过来做的话，改口径就得重新采数据。

    `props` 放事件特有的字段（比如字号档位、标签页名），不硬塞成列：
    每加一种事件就加一列，表会长成一堵墙。
    """

    __tablename__ = "usage_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    #: 一次浏览器会话。用来算「人均点了几次」，而不只是总次数
    session_id: Mapped[str] = mapped_column(String(64), index=True, default="")
    actor: Mapped[str] = mapped_column(String(64), default="")
    #: 事件名，如 interview_start / hints_dismiss / font_change / window_maximize
    event: Mapped[str] = mapped_column(String(64), index=True)
    #: 作用对象，如标签页名、按钮名。同一个 event 下的细分
    target: Mapped[str] = mapped_column(String(64), default="")
    patient_id: Mapped[str] = mapped_column(String(32), index=True, default="")
    props: Mapped[dict] = mapped_column(JSON, default=dict)
    #: 客户端时间戳（毫秒）。批量上报时服务端时间会挤在一起，
    #: 算「两次点击间隔」这类指标必须用客户端的
    client_ts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
