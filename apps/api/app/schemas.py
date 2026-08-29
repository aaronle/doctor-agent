from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


TaskType = Literal[
    "voice_interview",
    "condition_summary",
    "record_generation",
    "differential_diagnosis",
    "diagnosis_management",
    "risk_management",
    "comorbidity_management",
]
TaskStatus = Literal[
    "accepted",
    "preparing",
    "running",
    "needs_clarification",
    "ready",
    "degraded",
    "failed",
    "cancelled",
]


class Actor(BaseModel):
    user_id: str
    role: str = "outpatient_doctor"
    organization_id: str = "pkuih"
    department_id: str


class Subject(BaseModel):
    patient_id: str
    encounter_id: str


class Trigger(BaseModel):
    source: str = "user_action"
    event: str
    occurred_at: datetime


class ContextRef(BaseModel):
    context_version: str
    data_cutoff_at: datetime


class SupplementalObservation(BaseModel):
    observation_id: str
    text: str = Field(min_length=1, max_length=500)
    source: Literal["doctor_selected", "doctor_entered"] = "doctor_selected"
    occurred_at: datetime


class InteractionContext(BaseModel):
    supplemental_observations: list[SupplementalObservation] = Field(default_factory=list, max_length=30)


class TaskRequestV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["task_request_v1"] = "task_request_v1"
    request_id: str
    idempotency_key: str
    task_type: TaskType
    runtime_mode: Literal["mock", "agentscope"] = "mock"
    actor: Actor
    subject: Subject
    trigger: Trigger
    context_ref: ContextRef
    interaction_context: InteractionContext = Field(default_factory=InteractionContext)
    expected_result_type: str
    locale: Literal["zh-CN"] = "zh-CN"
    trace_id: str

    @model_validator(mode="after")
    def result_type_matches_task(self):
        expected = {
            "voice_interview": "interview_note",
            "condition_summary": "condition_summary",
            "record_generation": "record_draft",
            "differential_diagnosis": "diagnosis_candidates",
            "diagnosis_management": "diagnosis_management",
            "risk_management": "risk_alert",
            "comorbidity_management": "comorbidity_plan",
        }[self.task_type]
        if self.expected_result_type != expected:
            raise ValueError(f"expected_result_type 必须为 {expected}")
        return self


class TaskEventV1(BaseModel):
    schema_version: Literal["task_event_v1"] = "task_event_v1"
    task_id: str
    sequence: int
    status: TaskStatus
    code: str
    message: str
    occurred_at: datetime
    trace_id: str


class SemanticResultV1(BaseModel):
    schema_version: Literal["semantic_result_v1"] = "semantic_result_v1"
    task_id: str
    task_type: TaskType
    result_type: str
    status: Literal["ready", "degraded", "needs_clarification"]
    subject: Subject
    generated_at: datetime
    data_cutoff_at: datetime
    runtime: dict[str, str]
    content: dict[str, Any]
    evidence_refs: list[dict[str, Any]] = Field(default_factory=list)
    missing_data: list[str] = Field(default_factory=list)
    conflicts: list[str] = Field(default_factory=list)
    safety: dict[str, Any]
    uncertainties: list[str] = Field(default_factory=list)
    allowed_actions: list[str]
    trace_id: str


class CardViewModelV1(BaseModel):
    schema_version: Literal["card_view_model_v1"] = "card_view_model_v1"
    card_id: str
    task_id: str
    component: str
    title: str
    status: str
    badges: list[dict[str, Any]]
    meta: dict[str, str]
    sections: list[dict[str, Any]]
    evidence_actions: list[dict[str, Any]]
    primary_actions: list[str]
    secondary_actions: list[str]


class TaskResponse(BaseModel):
    task_id: str
    status: str
    event_url: str
    result_version: int
    result: SemanticResultV1 | None = None
    card: CardViewModelV1 | None = None


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class LoginResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    doctor: dict[str, str]
    runtime_mode: str


class ResultActionV1(BaseModel):
    schema_version: Literal["agent_result_action_v1"] = "agent_result_action_v1"
    result_version: int
    action: Literal[
        "accept",
        "partial_accept",
        "edit",
        "reject",
        "report_error",
        "retry",
        "acknowledge",
        "start_action",
        "resolve",
        "false_positive",
        "dismiss_with_reason",
    ]
    selected_paths: list[str] = Field(default_factory=list)
    edited_content: dict[str, Any] | None = None
    reason_code: str | None = None
    note: str | None = None


class WriteBackRequest(BaseModel):
    task_id: str
    result_version: int
    idempotency_key: str
    target: Literal["record", "diagnosis"]
    confirmed_by_doctor: bool


class WriteBackResponse(BaseModel):
    receipt_id: str
    mode: Literal["mock"]
    status: Literal["simulated"]
    task_id: str
    occurred_at: datetime
