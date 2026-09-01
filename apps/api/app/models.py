"""
一期数据模型。

分三组：
  - 临床种子：从 references/ui-demo/extracted/fixtures/ 导入，运行期只读。
  - 运行时写入：医嘱、转诊、住院、语音会话、病历草稿、提醒。
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


class VoiceSession(Base):
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
