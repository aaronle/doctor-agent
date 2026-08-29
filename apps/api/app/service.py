import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select

from .agent_registry import get_agent_profile
from .card_mapper import to_card
from .config import get_settings
from .database import AgentTaskRecord, AuditRecord, SessionLocal, TaskEventRecord
from .fixtures import get_fixture_by_patient
from .runtime import build_result
from .schemas import TaskEventV1, TaskRequestV1, TaskResponse


TERMINAL_STATUSES = {"ready", "degraded", "needs_clarification", "failed", "cancelled"}


def _now() -> datetime:
    return datetime.now(UTC)


def append_event(task_id: str, status: str, code: str, message: str) -> None:
    with SessionLocal() as session:
        task = session.get(AgentTaskRecord, task_id)
        if task is None:
            return
        sequence = (
            session.scalar(
                select(TaskEventRecord.sequence)
                .where(TaskEventRecord.task_id == task_id)
                .order_by(TaskEventRecord.sequence.desc())
                .limit(1)
            )
            or 0
        ) + 1
        occurred_at = _now()
        event = TaskEventV1(
            task_id=task_id,
            sequence=sequence,
            status=status,
            code=code,
            message=message,
            occurred_at=occurred_at,
            trace_id=task.trace_id,
        )
        session.add(
            TaskEventRecord(
                task_id=task_id,
                sequence=sequence,
                status=status,
                code=code,
                message=message,
                event_json=event.model_dump(mode="json"),
                occurred_at=occurred_at,
            )
        )
        task.status = status
        task.updated_at = occurred_at
        session.commit()


def record_audit(
    *, event_type: str, actor_user_id: str, trace_id: str, payload: dict, task: AgentTaskRecord | None = None
) -> str:
    event_id = f"audit_{uuid4().hex}"
    with SessionLocal() as session:
        session.add(
            AuditRecord(
                event_id=event_id,
                event_type=event_type,
                actor_user_id=actor_user_id,
                patient_id=task.patient_id if task else None,
                encounter_id=task.encounter_id if task else None,
                task_id=task.id if task else None,
                trace_id=trace_id,
                payload=payload,
                occurred_at=_now(),
            )
        )
        session.commit()
    return event_id


async def run_mock_task(task_id: str, scenario: str) -> None:
    with SessionLocal() as session:
        initial_task = session.get(AgentTaskRecord, task_id)
        if initial_task is None:
            return
        profile = get_agent_profile(initial_task.task_type)
    delay = get_settings().mock_step_delay_ms / 1000
    await asyncio.sleep(delay)
    append_event(task_id, "preparing", "CONTEXT_LOADING", "正在读取本次就诊、历史病历和最新检验结果")
    await asyncio.sleep(delay)
    append_event(
        task_id,
        "running",
        "AGENT_RUNNING",
        f"正在执行{profile.display_name}并进行结构和安全校验",
    )
    if scenario == "timeout":
        await asyncio.sleep(delay)
        append_event(task_id, "failed", "TASK_FAILED", "任务超时，已安全停止；医生输入未受影响")
        return
    if scenario in {"runtime_failure", "invalid_schema"}:
        await asyncio.sleep(delay)
        message = "Mock Runtime 执行失败" if scenario == "runtime_failure" else "结果未通过 Schema 安全校验"
        append_event(task_id, "failed", "TASK_FAILED", message)
        return
    await asyncio.sleep(delay)
    with SessionLocal() as session:
        task = session.get(AgentTaskRecord, task_id)
        if task is None or task.status == "cancelled":
            return
        request = TaskRequestV1.model_validate(task.request_json)
        fixture = get_fixture_by_patient(task.patient_id)
        if fixture is None:
            append_event(task_id, "failed", "TASK_FAILED", "患者 Mock Fixture 不存在")
            return
        result = build_result(task_id=task_id, request=request, fixture=fixture, scenario=scenario)
        task.result_json = result.model_dump(mode="json")
        task.result_version += 1
        task.updated_at = _now()
        session.commit()
        completed_task = task
    final_status = (
        "needs_clarification"
        if scenario == "clarification_required"
        else "degraded"
        if scenario == "degraded_result"
        else "ready"
    )
    append_event(
        task_id,
        final_status,
        "CLARIFICATION_REQUIRED"
        if final_status == "needs_clarification"
        else "TASK_DEGRADED"
        if final_status == "degraded"
        else "RESULT_READY",
        "需要补充关键上下文" if final_status == "needs_clarification" else "结果已生成，等待医生复核",
    )
    record_audit(
        event_type="mock_agent_completed",
        actor_user_id=completed_task.actor_user_id,
        trace_id=completed_task.trace_id,
        payload={
            "agent_id": profile.agent_id,
            "agent_name": profile.display_name,
            "agent_version": profile.version,
            "runtime_mode": "mock_agent",
            "result_status": final_status,
        },
        task=completed_task,
    )


def task_to_response(task: AgentTaskRecord) -> TaskResponse:
    result = None
    card = None
    if task.result_json:
        from .schemas import SemanticResultV1

        result = SemanticResultV1.model_validate(task.result_json)
        card = to_card(result)
    return TaskResponse(
        task_id=task.id,
        status=task.status,
        event_url=f"/api/v1/agent-tasks/{task.id}/events",
        result_version=task.result_version,
        result=result,
        card=card,
    )
