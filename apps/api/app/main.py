import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .agent_registry import public_agent_inventory
from .auth import CurrentActor, require_actor
from .config import get_settings
from .database import AgentTaskRecord, AuditRecord, SessionLocal, TaskEventRecord, get_session, init_database
from .fixtures import get_fixture_by_patient, list_fixtures, public_patient
from .schemas import (
    LoginRequest,
    LoginResponse,
    ResultActionV1,
    TaskRequestV1,
    TaskResponse,
    WriteBackRequest,
    WriteBackResponse,
)
from .service import TERMINAL_STATUSES, record_audit, run_mock_task, task_to_response


settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_database()
    yield


app = FastAPI(title="Doctor Agent Product API", version=settings.release, lifespan=lifespan)
allow_credentials = settings.environment != "local"
allow_origins = ["*"] if settings.environment == "local" else settings.cors_origin_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

TASK_ACTION_ALLOWED_TASK_STATES = {
    "running",
    "ready",
    "degraded",
    "needs_clarification",
    "failed",
    "cancelled",
}

RISK_ACTION_STATUS_MAP = {
    "acknowledge": {"new"},
    "start_action": {"new", "acknowledged"},
    "resolve": {"action_in_progress"},
    "false_positive": {"new", "acknowledged", "action_in_progress"},
    "dismiss_with_reason": {"new", "acknowledged", "action_in_progress"},
}


@app.get("/api/v1/health")
def health() -> dict[str, object]:
    database = "ready"
    try:
        with SessionLocal() as session:
            session.execute(text("SELECT 1"))
    except Exception:
        database = "unavailable"
    return {
        "status": "ok",
        "release": app.version,
        "database": database,
        "runtime_mode": settings.runtime_mode,
        "write_back_mode": settings.write_back_mode,
        "data_classification": "MOCK_ONLY_NO_REAL_PATIENT_DATA",
        "agents": public_agent_inventory(),
    }


@app.post("/api/v1/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest) -> LoginResponse:
    if settings.environment not in {"local", "test"}:
        raise HTTPException(status_code=501, detail="正式认证尚未接入，请配置医院 SSO")
    return LoginResponse(
        access_token="mock-token-doctor_001",
        doctor={"user_id": "doctor_001", "name": payload.username, "department": "内分泌科"},
        runtime_mode=settings.runtime_mode,
    )


@app.get("/api/v1/patients")
def patients(_: CurrentActor = Depends(require_actor)) -> dict:
    return {
        "data_classification": "MOCK_ONLY_NO_REAL_PATIENT_DATA",
        "patients": [public_patient(item) for item in list_fixtures()],
    }


@app.get("/api/v1/patients/{patient_id}")
def patient(patient_id: str, _: CurrentActor = Depends(require_actor)) -> dict:
    fixture = get_fixture_by_patient(patient_id)
    if fixture is None:
        raise HTTPException(status_code=404, detail="患者不存在或无权访问")
    return public_patient(fixture)


@app.post("/api/v1/agent-tasks", response_model=TaskResponse, status_code=status.HTTP_202_ACCEPTED)
def create_task(
    payload: TaskRequestV1,
    background_tasks: BackgroundTasks,
    actor: CurrentActor = Depends(require_actor),
    session: Session = Depends(get_session),
    x_mock_scenario: str = Header(default="success"),
) -> TaskResponse:
    if payload.actor.user_id != actor.user_id:
        raise HTTPException(status_code=403, detail="任务操作者与当前登录医生不一致")
    fixture = get_fixture_by_patient(payload.subject.patient_id)
    if fixture is None or fixture["encounter"]["encounter_id"] != payload.subject.encounter_id:
        raise HTTPException(status_code=409, detail="患者或就诊上下文不匹配")
    existing = session.scalar(
        select(AgentTaskRecord).where(AgentTaskRecord.idempotency_key == payload.idempotency_key)
    )
    if existing:
        return task_to_response(existing)
    if x_mock_scenario != "success" and settings.environment not in {"local", "test"}:
        raise HTTPException(status_code=400, detail="正式环境不允许故障注入")
    task_id = f"task_{uuid4().hex}"
    now = datetime.now(UTC)
    task = AgentTaskRecord(
        id=task_id,
        request_id=payload.request_id,
        idempotency_key=payload.idempotency_key,
        task_type=payload.task_type,
        status="accepted",
        patient_id=payload.subject.patient_id,
        encounter_id=payload.subject.encounter_id,
        actor_user_id=actor.user_id,
        trace_id=payload.trace_id,
        request_json=payload.model_dump(mode="json"),
        result_json=None,
        result_version=0,
        created_at=now,
        updated_at=now,
    )
    session.add(task)
    session.commit()
    session.refresh(task)
    record_audit(
        event_type="agent_task_created",
        actor_user_id=actor.user_id,
        trace_id=task.trace_id,
        payload={"task_type": task.task_type, "runtime_mode": payload.runtime_mode},
        task=task,
    )
    background_tasks.add_task(run_mock_task, task_id, x_mock_scenario)
    return task_to_response(task)


@app.get("/api/v1/agent-tasks/{task_id}", response_model=TaskResponse)
def get_task(
    task_id: str,
    actor: CurrentActor = Depends(require_actor),
    session: Session = Depends(get_session),
) -> TaskResponse:
    task = session.get(AgentTaskRecord, task_id)
    if task is None or task.actor_user_id != actor.user_id:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task_to_response(task)


@app.get("/api/v1/agent-tasks/{task_id}/events")
def task_events(
    task_id: str,
    actor: CurrentActor = Depends(require_actor),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    task = session.get(AgentTaskRecord, task_id)
    if task is None or task.actor_user_id != actor.user_id:
        raise HTTPException(status_code=404, detail="任务不存在")

    async def stream():
        last_sequence = 0
        while True:
            from .database import SessionLocal

            with SessionLocal() as event_session:
                rows = event_session.scalars(
                    select(TaskEventRecord)
                    .where(
                        TaskEventRecord.task_id == task_id,
                        TaskEventRecord.sequence > last_sequence,
                    )
                    .order_by(TaskEventRecord.sequence)
                ).all()
                for row in rows:
                    last_sequence = row.sequence
                    yield f"id: {row.sequence}\nevent: task_event\ndata: {json.dumps(row.event_json, ensure_ascii=False)}\n\n"
                current = event_session.get(AgentTaskRecord, task_id)
                if current is None or (current.status in TERMINAL_STATUSES and not rows):
                    break
            yield ": keep-alive\n\n"
            await asyncio.sleep(0.15)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/v1/agent-tasks/{task_id}/actions")
def task_action(
    task_id: str,
    payload: ResultActionV1,
    actor: CurrentActor = Depends(require_actor),
    session: Session = Depends(get_session),
) -> dict:
    task = session.get(AgentTaskRecord, task_id)
    if task is None or task.actor_user_id != actor.user_id:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.result_version != payload.result_version:
        raise HTTPException(status_code=409, detail="结果版本已变化，请刷新后处理")
    if task.status not in TASK_ACTION_ALLOWED_TASK_STATES:
        raise HTTPException(status_code=409, detail="该任务状态暂不可执行动作")
    if payload.action == "retry":
        audit_id = record_audit(
            event_type="agent_result_action",
            actor_user_id=actor.user_id,
            trace_id=task.trace_id,
            payload={
                "action": payload.action,
                "selected_paths": payload.selected_paths,
                "reason_code": payload.reason_code,
                "note": payload.note,
                "result_version": payload.result_version,
                "task_type": task.task_type,
                "retry": True,
            },
            task=task,
        )
        return {"status": "recorded", "audit_event_id": audit_id, "result_version": task.result_version}

    if task.result_json is None:
        raise HTTPException(status_code=409, detail="任务结果尚未生成，无法执行该操作")

    result = dict(task.result_json)
    allowed_actions = set(result.get("allowed_actions", []))
    if payload.action not in allowed_actions:
        raise HTTPException(status_code=422, detail="当前结果不支持该操作")

    if result.get("status") == "needs_clarification" and payload.action != "retry":
        raise HTTPException(status_code=409, detail="澄清状态下只能执行重试")
    if payload.action in {"reject", "report_error", "false_positive", "dismiss_with_reason"} and not (
        payload.reason_code or payload.note
    ):
        raise HTTPException(status_code=422, detail="该操作必须填写原因")

    if task.task_type == "risk_management":
        content = dict(result["content"])
        alerts = [dict(item) for item in content["alerts"]]
        current_status = alerts[0].get("status", "new") if alerts else "new"
        if payload.action in RISK_ACTION_STATUS_MAP:
            if current_status not in RISK_ACTION_STATUS_MAP[payload.action]:
                raise HTTPException(status_code=409, detail="该风险状态下不允许执行该处置动作")
        status_map = {
            "acknowledge": "acknowledged",
            "start_action": "action_in_progress",
            "resolve": "resolved",
            "false_positive": "false_positive",
            "dismiss_with_reason": "dismissed_with_reason",
        }
        if payload.action in status_map:
            for alert in alerts:
                alert["status"] = status_map[payload.action]
                alert["updated_at"] = datetime.now(UTC).isoformat()
                alert["updated_by"] = actor.user_id
                if payload.note:
                    alert["operator_note"] = payload.note
                if payload.reason_code:
                    alert["reason_code"] = payload.reason_code
            content["alerts"] = alerts
            result["content"] = content
            if status_map[payload.action] in {"resolved", "false_positive", "dismissed_with_reason"}:
                result["safety"]["blocking"] = False
            result["safety"]["requires_acknowledgement"] = result["safety"]["blocking"]
            task.result_json = result
            task.result_version += 1
            task.updated_at = datetime.now(UTC)
            session.commit()
        else:
            raise HTTPException(status_code=422, detail="风险管理当前仅支持处置与重试类动作")
    else:
        content = dict(result.get("content", {}))
        action_log = list(content.get("action_log", []))
        action_log.append(
            {
                "action": payload.action,
                "note": payload.note,
                "reason_code": payload.reason_code,
                "actor": actor.user_id,
                "recorded_at": datetime.now(UTC).isoformat(),
            }
        )
        content["action_log"] = action_log
        content["last_action"] = payload.action
        result["content"] = content
        task.result_json = result
        task.result_version += 1
        task.updated_at = datetime.now(UTC)
        session.commit()

    audit_id = record_audit(
        event_type="agent_result_action",
        actor_user_id=actor.user_id,
        trace_id=task.trace_id,
        payload={
            "action": payload.action,
            "selected_paths": payload.selected_paths,
            "reason_code": payload.reason_code,
            "note": payload.note,
            "result_version": payload.result_version,
            "task_type": task.task_type,
        },
        task=task,
    )
    return {"status": "recorded", "audit_event_id": audit_id, "result_version": task.result_version}


@app.post("/api/v1/write-back-requests", response_model=WriteBackResponse)
def write_back(
    payload: WriteBackRequest,
    actor: CurrentActor = Depends(require_actor),
    session: Session = Depends(get_session),
) -> WriteBackResponse:
    if settings.write_back_mode != "mock":
        raise HTTPException(status_code=503, detail="一期仅允许 Mock 写回")
    if not payload.confirmed_by_doctor:
        raise HTTPException(status_code=422, detail="写回前必须由医生明确确认")
    task = session.get(AgentTaskRecord, payload.task_id)
    if task is None or task.actor_user_id != actor.user_id:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.result_version != payload.result_version:
        raise HTTPException(status_code=409, detail="结果版本已变化，请刷新后再提交")
    critical = session.scalars(
        select(AgentTaskRecord).where(
            AgentTaskRecord.patient_id == task.patient_id,
            AgentTaskRecord.encounter_id == task.encounter_id,
            AgentTaskRecord.task_type == "risk_management",
        )
    ).all()
    for risk_task in critical:
        if not risk_task.result_json or not risk_task.result_json.get("safety", {}).get("blocking"):
            continue
        statuses = {item["status"] for item in risk_task.result_json["content"]["alerts"]}
        if not statuses.issubset({"resolved", "false_positive", "dismissed_with_reason"}):
            raise HTTPException(status_code=409, detail="存在未闭环红色风险，模拟写回已阻断")
    occurred_at = datetime.now(UTC)
    receipt_id = f"mock_writeback_{uuid4().hex}"
    record_audit(
        event_type="mock_write_back",
        actor_user_id=actor.user_id,
        trace_id=task.trace_id,
        payload={**payload.model_dump(), "receipt_id": receipt_id, "mode": "mock"},
        task=task,
    )
    return WriteBackResponse(
        receipt_id=receipt_id,
        mode="mock",
        status="simulated",
        task_id=task.id,
        occurred_at=occurred_at,
    )


@app.get("/api/v1/audit-events")
def audit_events(
    patient_id: str | None = None,
    actor: CurrentActor = Depends(require_actor),
    session: Session = Depends(get_session),
) -> dict:
    query = select(AuditRecord).where(AuditRecord.actor_user_id == actor.user_id)
    if patient_id:
        query = query.where(AuditRecord.patient_id == patient_id)
    rows = session.scalars(query.order_by(AuditRecord.occurred_at.desc()).limit(100)).all()
    return {
        "events": [
            {
                "event_id": row.event_id,
                "event_type": row.event_type,
                "patient_id": row.patient_id,
                "encounter_id": row.encounter_id,
                "task_id": row.task_id,
                "trace_id": row.trace_id,
                "payload": row.payload,
                "occurred_at": row.occurred_at,
            }
            for row in rows
        ]
    }


# The production image serves the built Vue application and API from one
# process. During local Vite development this directory does not exist and the
# API remains API-only.
PROJECT_ROOT = Path(__file__).resolve().parents[3]
WEB_DIST = PROJECT_ROOT / "apps" / "web" / "dist"
if WEB_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="web-assets")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def web_application(path: str) -> FileResponse:
        candidate = (WEB_DIST / path).resolve()
        if path and candidate.is_file() and WEB_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")
