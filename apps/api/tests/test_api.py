from datetime import datetime
from uuid import uuid4

import pytest


def make_task(patient_id: str, encounter_id: str, task_type: str, expected: str) -> dict:
    nonce = uuid4().hex
    return {
        "schema_version": "task_request_v1",
        "request_id": f"req_{nonce}",
        "idempotency_key": f"{encounter_id}:{task_type}:{nonce}",
        "task_type": task_type,
        "runtime_mode": "mock",
        "actor": {
            "user_id": "doctor_001",
            "role": "outpatient_doctor",
            "organization_id": "pkuih",
            "department_id": "endocrinology",
        },
        "subject": {"patient_id": patient_id, "encounter_id": encounter_id},
        "trigger": {
            "source": "user_action",
            "event": f"run_{task_type}",
            "occurred_at": datetime.now().astimezone().isoformat(),
        },
        "context_ref": {
            "context_version": "context_v1",
            "data_cutoff_at": datetime.now().astimezone().isoformat(),
        },
        "expected_result_type": expected,
        "locale": "zh-CN",
        "trace_id": f"trace_{nonce}",
    }


def test_login_and_patient_list(client, auth_headers):
    login = client.post("/api/v1/auth/login", json={"username": "张医生", "password": "demo"})
    assert login.status_code == 200
    assert login.json()["access_token"] == "mock-token-doctor_001"

    patients = client.get("/api/v1/patients", headers=auth_headers)
    assert patients.status_code == 200
    assert len(patients.json()["patients"]) == 6
    assert patients.json()["data_classification"] == "MOCK_ONLY_NO_REAL_PATIENT_DATA"


def test_health_reports_versioned_mock_agents_and_database(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    health = response.json()
    assert health["release"] == "0.2.0-mvp"
    assert health["database"] == "ready"
    assert health["runtime_mode"] == "mock"
    assert health["data_classification"] == "MOCK_ONLY_NO_REAL_PATIENT_DATA"
    assert len(health["agents"]) == 6
    assert {agent["agent_version"] for agent in health["agents"]} == {"mvp-0.2.0"}


def test_condition_summary_task_reaches_ready(client, auth_headers):
    payload = make_task("MOCK-IM-001", "ENC-IM-001", "condition_summary", "condition_summary")
    created = client.post("/api/v1/agent-tasks", json=payload, headers=auth_headers)
    assert created.status_code == 202

    task = client.get(f'/api/v1/agent-tasks/{created.json()["task_id"]}', headers=auth_headers)
    body = task.json()
    assert body["status"] == "ready"
    assert body["result"]["subject"]["patient_id"] == "MOCK-IM-001"
    assert body["card"]["component"] == "condition_summary_card"
    assert body["result"]["evidence_refs"]
    assert body["result"]["runtime"]["mode"] == "mock_agent"
    assert body["result"]["runtime"]["agent_version"] == "mvp-0.2.0"


def test_supplemental_observation_flows_into_interview_and_record(client, auth_headers):
    observation = {
        "observation_id": "OBS-1",
        "text": "近期足部偶有轻微麻木感",
        "source": "doctor_selected",
        "occurred_at": datetime.now().astimezone().isoformat(),
    }
    for task_type, result_type in (
        ("voice_interview", "interview_note"),
        ("record_generation", "record_draft"),
    ):
        payload = make_task("MOCK-IM-001", "ENC-IM-001", task_type, result_type)
        payload["interaction_context"] = {"supplemental_observations": [observation]}
        created = client.post("/api/v1/agent-tasks", json=payload, headers=auth_headers)
        assert created.status_code == 202
        task = client.get(
            f'/api/v1/agent-tasks/{created.json()["task_id"]}', headers=auth_headers
        ).json()
        assert any(ref["ref_id"] == "OBS-1" for ref in task["result"]["evidence_refs"])
        if task_type == "voice_interview":
            segments = task["result"]["content"]["transcript_segments"]
            assert any(segment["text"] == "【补充观察】近期足部偶有轻微麻木感" for segment in segments)
        else:
            sections = task["result"]["content"]["sections"]
            present_illness = next(item for item in sections if item["section_id"] == "present_illness")
            assert "近期足部偶有轻微麻木感" in present_illness["ai_text"]
            assert "OBS-1" in present_illness["source_refs"]


def test_patient_encounter_mismatch_is_rejected(client, auth_headers):
    payload = make_task("MOCK-IM-001", "ENC-ORT-001", "condition_summary", "condition_summary")
    response = client.post("/api/v1/agent-tasks", json=payload, headers=auth_headers)
    assert response.status_code == 409


def test_red_risk_blocks_mock_write_back_until_resolved(client, auth_headers):
    risk_payload = make_task("MOCK-ORT-002", "ENC-ORT-002", "risk_management", "risk_alert")
    risk_created = client.post("/api/v1/agent-tasks", json=risk_payload, headers=auth_headers)
    risk_task = client.get(
        f'/api/v1/agent-tasks/{risk_created.json()["task_id"]}', headers=auth_headers
    ).json()
    assert risk_task["result"]["safety"]["blocking"] is True
    risk_detail = risk_task["result"]["content"]["alerts"][0]
    assert risk_detail["category"] == "专病与诊疗安全"
    assert "阻断" in risk_detail["impact"]
    assert risk_detail["assessment_refs"] == ["专病风险评估"]
    assert "并发症风险筛查" in risk_detail["skill_refs"]

    record_payload = make_task("MOCK-ORT-002", "ENC-ORT-002", "record_generation", "record_draft")
    record_created = client.post("/api/v1/agent-tasks", json=record_payload, headers=auth_headers)
    record_task = client.get(
        f'/api/v1/agent-tasks/{record_created.json()["task_id"]}', headers=auth_headers
    ).json()

    write_back = {
        "task_id": record_task["task_id"],
        "result_version": record_task["result_version"],
        "idempotency_key": f'wb:{record_task["task_id"]}',
        "target": "record",
        "confirmed_by_doctor": True,
    }
    blocked = client.post("/api/v1/write-back-requests", json=write_back, headers=auth_headers)
    assert blocked.status_code == 409
    acked = client.post(
        f'/api/v1/agent-tasks/{risk_task["task_id"]}/actions',
        json={
            "schema_version": "agent_result_action_v1",
            "result_version": risk_task["result_version"],
            "action": "acknowledge",
        },
        headers=auth_headers,
    )
    assert acked.status_code == 200
    in_progress = client.post(
        f'/api/v1/agent-tasks/{risk_task["task_id"]}/actions',
        json={
            "schema_version": "agent_result_action_v1",
            "result_version": risk_task["result_version"] + 1,
            "action": "start_action",
            "note": "已开启处置",
        },
        headers=auth_headers,
    )
    assert in_progress.status_code == 200

    resolved = client.post(
        f'/api/v1/agent-tasks/{risk_task["task_id"]}/actions',
        json={
            "schema_version": "agent_result_action_v1",
            "result_version": risk_task["result_version"] + 2,
            "action": "resolve",
            "note": "已完成急诊评估，Mock 演示",
        },
        headers=auth_headers,
    )
    assert resolved.status_code == 200
    refreshed_risk = client.get(
        f'/api/v1/agent-tasks/{risk_task["task_id"]}', headers=auth_headers
    ).json()
    assert refreshed_risk["result"]["content"]["alerts"][0]["status"] == "resolved"

    allowed = client.post("/api/v1/write-back-requests", json=write_back, headers=auth_headers)
    assert allowed.status_code == 200
    assert allowed.json()["mode"] == "mock"


def test_action_is_immutable_for_wrong_task_type(client, auth_headers):
    payload = make_task("MOCK-IM-001", "ENC-IM-001", "condition_summary", "condition_summary")
    created = client.post("/api/v1/agent-tasks", json=payload, headers=auth_headers)
    task = client.get(f'/api/v1/agent-tasks/{created.json()["task_id"]}', headers=auth_headers).json()
    reject = client.post(
        f'/api/v1/agent-tasks/{task["task_id"]}/actions',
        json={
            "schema_version": "agent_result_action_v1",
            "result_version": task["result_version"],
            "action": "resolve",
        },
        headers=auth_headers,
    )
    assert reject.status_code == 422


def test_retry_action_for_failed_task_is_recorded_even_without_result(client, auth_headers):
    payload = make_task("MOCK-GYN-001", "ENC-GYN-001", "record_generation", "record_draft")
    failed_created = client.post(
        "/api/v1/agent-tasks",
        json=payload,
        headers={**auth_headers, "X-Mock-Scenario": "invalid_schema"},
    )
    failed_task = client.get(
        f'/api/v1/agent-tasks/{failed_created.json()["task_id"]}', headers=auth_headers
    ).json()
    assert failed_task["result"] is None
    replay = client.post(
        f'/api/v1/agent-tasks/{failed_task["task_id"]}/actions',
        json={
            "schema_version": "agent_result_action_v1",
            "result_version": failed_task["result_version"],
            "action": "retry",
            "note": "任务重试",
        },
        headers=auth_headers,
    )
    assert replay.status_code == 200
    assert replay.json()["status"] == "recorded"


def test_risk_action_transition_is_state_guarded(client, auth_headers):
    payload = make_task("MOCK-ORT-001", "ENC-ORT-001", "risk_management", "risk_alert")
    created = client.post("/api/v1/agent-tasks", json=payload, headers=auth_headers)
    risk_task = client.get(f'/api/v1/agent-tasks/{created.json()["task_id"]}', headers=auth_headers).json()

    forbidden = client.post(
        f'/api/v1/agent-tasks/{risk_task["task_id"]}/actions',
        json={
            "schema_version": "agent_result_action_v1",
            "result_version": risk_task["result_version"],
            "action": "resolve",
            "note": "尝试直接关闭红色风险",
        },
        headers=auth_headers,
    )
    assert forbidden.status_code == 409

    acknowledged = client.post(
        f'/api/v1/agent-tasks/{risk_task["task_id"]}/actions',
        json={
            "schema_version": "agent_result_action_v1",
            "result_version": risk_task["result_version"],
            "action": "acknowledge",
        },
        headers=auth_headers,
    )
    assert acknowledged.status_code == 200
    updated = client.get(f'/api/v1/agent-tasks/{risk_task["task_id"]}', headers=auth_headers).json()
    assert updated["result"]["content"]["alerts"][0]["status"] == "acknowledged"


def test_task_action_recorded_in_result_for_non_risk_task(client, auth_headers):
    payload = make_task("MOCK-IM-001", "ENC-IM-001", "diagnosis_management", "diagnosis_management")
    created = client.post("/api/v1/agent-tasks", json=payload, headers=auth_headers)
    task = client.get(f'/api/v1/agent-tasks/{created.json()["task_id"]}', headers=auth_headers).json()
    action = client.post(
        f'/api/v1/agent-tasks/{task["task_id"]}/actions',
        json={
            "schema_version": "agent_result_action_v1",
            "result_version": task["result_version"],
            "action": "accept",
            "note": "采纳到诊断清单草稿",
        },
        headers=auth_headers,
    )
    assert action.status_code == 200
    updated = client.get(f'/api/v1/agent-tasks/{task["task_id"]}', headers=auth_headers).json()
    assert updated["result"]["content"]["last_action"] == "accept"


def test_failure_injection_never_returns_clinical_content(client, auth_headers):
    payload = make_task("MOCK-GYN-002", "ENC-GYN-002", "condition_summary", "condition_summary")
    response = client.post(
        "/api/v1/agent-tasks",
        json=payload,
        headers={**auth_headers, "X-Mock-Scenario": "invalid_schema"},
    )
    task = client.get(f'/api/v1/agent-tasks/{response.json()["task_id"]}', headers=auth_headers).json()
    assert task["status"] == "failed"
    assert task["result"] is None
    assert task["card"] is None


@pytest.mark.parametrize(
    ("task_type", "result_type"),
    [
        ("voice_interview", "interview_note"),
        ("condition_summary", "condition_summary"),
        ("record_generation", "record_draft"),
        ("differential_diagnosis", "diagnosis_candidates"),
        ("diagnosis_management", "diagnosis_management"),
        ("risk_management", "risk_alert"),
        ("comorbidity_management", "comorbidity_plan"),
    ],
)
def test_all_phase_one_task_routes_share_the_formal_contract(
    client, auth_headers, task_type, result_type
):
    payload = make_task("MOCK-IM-001", "ENC-IM-001", task_type, result_type)
    created = client.post("/api/v1/agent-tasks", json=payload, headers=auth_headers)
    assert created.status_code == 202
    task = client.get(f'/api/v1/agent-tasks/{created.json()["task_id"]}', headers=auth_headers).json()
    assert task["status"] == "ready"
    assert task["result"]["result_type"] == result_type
    assert task["result"]["schema_version"] == "semantic_result_v1"


def test_mock_results_have_product_ready_shapes_for_all_seven_functions(client, auth_headers):
    expected_shapes = {
        "voice_interview": ("transcript_segments", 4),
        "condition_summary": ("problems", 1),
        "record_generation": ("sections", 8),
        "differential_diagnosis": ("candidates", 1),
        "diagnosis_management": ("diagnoses", 1),
        "risk_management": ("alerts", 1),
        "comorbidity_management": ("conditions", 1),
    }
    result_types = {
        "voice_interview": "interview_note",
        "condition_summary": "condition_summary",
        "record_generation": "record_draft",
        "differential_diagnosis": "diagnosis_candidates",
        "diagnosis_management": "diagnosis_management",
        "risk_management": "risk_alert",
        "comorbidity_management": "comorbidity_plan",
    }
    for task_type, (field, minimum) in expected_shapes.items():
        payload = make_task("MOCK-IM-001", "ENC-IM-001", task_type, result_types[task_type])
        created = client.post("/api/v1/agent-tasks", json=payload, headers=auth_headers)
        task = client.get(f'/api/v1/agent-tasks/{created.json()["task_id"]}', headers=auth_headers).json()
        assert len(task["result"]["content"][field]) >= minimum
        if task_type == "record_generation":
            titles = {section["title"] for section in task["result"]["content"]["sections"]}
            assert {"主诉", "现病史", "既往史", "个人史", "过敏史", "辅助检查"} <= titles


def test_clarification_mock_effect_is_structured_and_blocking(client, auth_headers):
    payload = make_task("MOCK-IM-002", "ENC-IM-002", "voice_interview", "interview_note")
    created = client.post(
        "/api/v1/agent-tasks",
        json=payload,
        headers={**auth_headers, "X-Mock-Scenario": "clarification_required"},
    )
    task = client.get(f'/api/v1/agent-tasks/{created.json()["task_id"]}', headers=auth_headers).json()
    assert task["status"] == "needs_clarification"
    assert task["result"]["result_type"] == "clarification_request"
    assert task["result"]["content"]["questions"][0]["blocking"] is True
    assert task["result"]["safety"]["blocking"] is True


def test_data_conflict_and_degraded_mock_effects_are_visible(client, auth_headers):
    conflict = make_task("MOCK-ORT-001", "ENC-ORT-001", "condition_summary", "condition_summary")
    conflict_created = client.post(
        "/api/v1/agent-tasks",
        json=conflict,
        headers={**auth_headers, "X-Mock-Scenario": "data_conflict"},
    )
    conflict_task = client.get(
        f'/api/v1/agent-tasks/{conflict_created.json()["task_id"]}', headers=auth_headers
    ).json()
    assert conflict_task["result"]["conflicts"]

    degraded = make_task("MOCK-ORT-001", "ENC-ORT-001", "condition_summary", "condition_summary")
    degraded_created = client.post(
        "/api/v1/agent-tasks",
        json=degraded,
        headers={**auth_headers, "X-Mock-Scenario": "degraded_result"},
    )
    degraded_task = client.get(
        f'/api/v1/agent-tasks/{degraded_created.json()["task_id"]}', headers=auth_headers
    ).json()
    assert degraded_task["status"] == "degraded"
    assert degraded_task["result"]["uncertainties"]
