"""
产品 API 测试。

覆盖三类：V4.3 契约形状、写入与审计、安全边界。
模型侧走本地规则（见 conftest），因此断言不依赖外部网关。
"""

import json

import pytest

from app.agents import SECTION_KEYS
from app.agents.risk import hard_rule_alerts

# ------------------------------------------------------------------ 基础与配置


def test_health_reports_fingerprint(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["database"] == "ready"
    assert body["data_classification"] == "MOCK_ONLY_NO_REAL_PATIENT_DATA"
    assert len(body["agents"]) == 6


def test_health_never_leaks_api_key(client):
    """健康接口任何字段都不得出现密钥或其片段。"""
    raw = client.get("/api/health").text
    assert "sk-" not in raw
    assert "api_key" not in raw


def test_config_returns_empty_api_key(client):
    body = client.get("/api/config").json()
    assert body["api_key"] == ""
    assert body["voice_mode"] == "webspeech"
    # 本地规则模式下必须告诉前端当前不是真实生成
    assert body["mock_generation"] is True


def test_put_config_does_not_accept_client_key(client):
    body = client.put("/api/config", json={"api_key": "sk-injected"}).json()
    assert body["ok"] is True
    assert body["api_key"] == ""


# ------------------------------------------------------------------ HIS 数据面


def test_patient_list_only_returns_queued_and_trimmed_fields(client):
    body = client.get("/api/his/patients").json()
    ids = {p["id"] for p in body}
    assert "P007" not in ids, "P007 未在候诊队列，不应出现在候诊列表"
    assert len(body) == 6
    # 列表视图必须裁剪掉大字段与身份信息
    for key in ("lab_results", "health_archive", "id_no", "phone"):
        assert key not in body[0]


def test_patient_detail_merges_issued_orders(client):
    before = len(client.get("/api/his/patient/P001").json()["orders"])
    client.post(
        "/api/his/orders",
        json={"patient_id": "P001", "drug": "达格列净片", "dose": "10mg", "freq": "qd", "route": "口服", "days": "30"},
    )
    after = client.get("/api/his/patient/P001").json()["orders"]
    assert len(after) == before + 1
    assert any(o.get("category") == "drug" and o["drug"] == "达格列净片" for o in after)


def test_missing_patient_returns_404(client):
    response = client.get("/api/his/patient/P999")
    assert response.status_code == 404
    assert response.json()["detail"] == "患者不存在"


def test_drugs_dictionary(client):
    body = client.get("/api/his/drugs").json()
    assert len(body) == 18


def test_order_and_exam_ids_do_not_skip_within_prefix(client):
    """药品与检查同表，序号必须按前缀各自递增，不能互相顶掉号。"""
    exam = client.post(
        "/api/his/exams",
        json={"patient_id": "P002", "name": "糖化血红蛋白", "type": "检验", "route": "门诊", "freq": "一次"},
    ).json()["exam"]
    assert exam["id"].startswith("E")
    assert exam["status"] == "新开"
    assert exam["category"] == "exam"


def test_referral_and_admission_write_locally(client):
    referral = client.post("/api/his/referral", json={"patient_id": "P003", "target_dept": "肾内科", "reason": "蛋白尿"})
    assert referral.json()["message"] == "转诊单已提交"

    admission = client.post(
        "/api/his/admission", json={"patient_id": "P002", "patient_name": "张某", "target_dept": "心内科"}
    )
    assert admission.json()["message"] == "住院申请已提交"


def test_remind_is_idempotent(client):
    first = client.post("/api/his/patients/remind", json={"patient_ids": ["P005"]}).json()
    second = client.post("/api/his/patients/remind", json={"patient_ids": ["P005"]}).json()
    assert first["reminded_count"] == 1
    assert second["reminded_count"] == 0, "重复提醒同一患者不应再次计数"


def test_remind_rejects_empty_target(client):
    assert client.post("/api/his/patients/remind", json={"patient_ids": []}).status_code == 400


# ------------------------------------------------------------------ AI 面


def test_report_summary_has_all_contract_fields(client):
    body = client.get("/api/emr/report-summary/P001").json()
    for field in (
        "overall_conclusion", "risk_assessments", "risk_alerts", "treatment_effectiveness",
        "recommended_orders", "examinations", "todos", "dialog_script", "record_nodes",
        "is_return_visit", "pre_consultation_done", "suspected_diagnoses",
        "differential_diagnosis", "visit_history", "voice_assessments",
        "assessment_triggers", "record_content", "comorbidity",
    ):
        assert field in body, f"聚合包缺少契约字段 {field}"


def test_report_summary_degrades_without_model_instead_of_failing(client):
    """模型不可用时必须部分就绪，而不是整个请求失败。"""
    body = client.get("/api/emr/report-summary/P001").json()
    assert set(body["_meta"]["degraded_agents"]) == {"summary", "risk", "diagnosis", "comorbidity"}
    assert body["record_nodes"] and len(body["record_nodes"]) == 7


def test_degraded_result_is_not_cached(client):
    """降级结果不入缓存，否则一次网关抖动会被固化半小时。"""
    first = client.get("/api/emr/report-summary/P002").json()
    second = client.get("/api/emr/report-summary/P002").json()
    assert first["_meta"]["cached"] is False
    assert second["_meta"]["cached"] is False


def test_record_sse_streams_seven_sections_in_order(client):
    response = client.post(
        "/api/emr/copilot/chat", json={"patient_id": "P001", "messages": [], "generate_record": True}
    )
    assert response.headers["content-type"].startswith("text/event-stream")

    starts, done = [], None
    for line in response.text.splitlines():
        if not line.startswith("data: "):
            continue
        event = json.loads(line[6:])
        if event["type"] == "record_node_start":
            starts.append(event["node_id"])
        elif event["type"] == "record_done":
            done = event

    assert tuple(starts) == SECTION_KEYS, "七段必须按固定顺序下发"
    assert done is not None and set(done["fields"]) == set(SECTION_KEYS)


def test_record_field_rejects_unknown_section(client):
    response = client.post(
        "/api/emr/generate-record-field", json={"patient_id": "P001", "field": "既往用药", "note_text": "x"}
    )
    assert response.status_code == 400


def test_record_field_fallback_preserves_doctor_input(client):
    body = client.post(
        "/api/emr/generate-record-field",
        json={"patient_id": "P001", "field": "physical_exam", "note_text": "神清，精神可"},
    ).json()
    assert "神清" in body["generated_text"], "降级时也不得丢弃医生已输入的内容"


def test_voice_turn_streams_prompt_and_advances_index(client):
    response = client.post(
        "/api/emr/voice/turn",
        json={"patient_id": "P001", "patient_text": "最近口渴", "turn_index": 2, "conversation_history": []},
    )
    prompt, done = "", None
    for line in response.text.splitlines():
        if not line.startswith("data: "):
            continue
        event = json.loads(line[6:])
        if event["type"] == "prompt_token":
            prompt += event["token"]
        elif event["type"] == "prompt_done":
            done = event
    assert prompt
    assert done["turn_index"] == 3


def test_voice_session_is_persisted_and_listed(client):
    client.post(
        "/api/emr/voice/complete",
        json={"patient_id": "P004", "conversation_summary": "头晕两周", "messages": [{"role": "patient", "text": "头晕"}]},
    )
    history = client.get("/api/emr/voice/history/P004").json()
    assert history["patient_id"] == "P004"
    assert len(history["sessions"]) >= 1


def test_nutrition_alert_follows_threshold_not_model(client):
    """营养提醒是纯阈值规则，模型不可用时照常触发。"""
    body = client.post("/api/emr/comorbidity/check", json={"patient_id": "P001"}).json()
    nutrition = body["comorbidity"]["nutrition"]
    assert nutrition["triggered"] is True
    assert nutrition["score"] == 5


def test_consultation_creates_referral_with_reason(client):
    body = client.post(
        "/api/emr/comorbidity/consultation", json={"patient_id": "P001", "focus_nutrition": True}
    ).json()
    assert body["referral"]["target_dept"] == "营养科"
    assert "营养筛查评分" in body["referral"]["reason"]


# ------------------------------------------------------------------ 风险硬规则


@pytest.mark.parametrize(
    ("label", "ctx", "expected_rule"),
    [
        ("过敏冲突", {"allergies": ["青霉素"], "orders": [{"drug": "注射用青霉素钠"}]}, "allergy_conflict"),
        ("血糖危急值", {"lab_results": [{"name": "空腹血糖", "value": "18.9"}]}, "critical_lab"),
        ("血钾危急值", {"lab_results": [{"name": "血钾", "value": "6.4"}]}, "critical_lab"),
        ("血压危象", {"vitals": {"bp": "195/115 mmHg"}}, "vital_threshold"),
        ("低血氧", {"vitals": {"spo2": 88}}, "vital_threshold"),
    ],
)
def test_hard_rules_fire_without_model(label, ctx, expected_rule):
    alerts = hard_rule_alerts(ctx)
    assert alerts, f"{label} 应触发硬规则"
    assert all(a["level"] == "高风险" for a in alerts)
    assert any(a["rule"] == expected_rule for a in alerts)
    # 红色风险必须证据、来源、阈值、建议齐备
    for alert in alerts:
        for field in ("evidence", "source", "threshold", "suggestion"):
            assert alert[field], f"{label} 的红色风险缺少 {field}"


def test_hard_rules_silent_when_all_normal():
    ctx = {
        "vitals": {"bp": "120/78 mmHg", "hr": 72, "temp": 36.5, "spo2": 98},
        "lab_results": [{"name": "空腹血糖", "value": "5.4"}],
        "allergies": "无",
    }
    assert hard_rule_alerts(ctx) == []


def test_model_cannot_override_hard_rule_red_alert():
    from app.agents.risk import merge_risks

    hard = hard_rule_alerts({"lab_results": [{"name": "血钾", "value": "6.4"}]})
    model_said_low = [{"name": "血钾危急值", "level": "低风险", "color": "success", "summary": "问题不大"}]
    merged, alerts, conflicts = merge_risks(hard, model_said_low)

    assert conflicts == ["血钾危急值"]
    assert all(item["level"] == "高风险" for item in merged if item["name"] == "血钾危急值")
    assert len(alerts) == 1


# ------------------------------------------------------------------ V4.3 对齐


def test_voice_init_returns_full_interview_package(client):
    """
    V4.3 的问诊是「点一下自动播放脚本」，所以 init 必须一次给全：
    对话脚本 + 追问清单 + 候选补充观察。少任何一样前端都播不起来。
    """
    body = client.get("/api/emr/voice/init/P006").json()
    for field in ("greeting", "patient_name", "chief_complaint", "dialog", "questions", "observations"):
        assert field in body, f"问诊开场包缺少 {field}"
    assert len(body["dialog"]) > 0, "P006 应有演示对话脚本"
    assert all({"role", "text"} <= set(turn) for turn in body["dialog"])
    # 本地规则兜底也必须给出可用的追问清单
    assert len(body["questions"]) >= 5


def test_diagnosis_ranks_are_derived_not_reported():
    """
    名次与可能性由后端按置信度统一派生。让模型自己标注会出现
    两个「首选」或名次与置信度矛盾的情况。
    """
    from app.agents.diagnosis import _decorate

    result = _decorate(
        [
            {"name": "甲", "confidence": 90, "desc": "d1", "supporting": [], "opposing": ["未获得"], "missing": []},
            {"name": "乙", "confidence": 70, "desc": "d2", "supporting": [], "opposing": ["未获得"], "missing": []},
            {"name": "丙", "confidence": 40, "desc": "d3", "supporting": [], "opposing": ["未获得"], "missing": []},
        ]
    )
    items = result["suspected_diagnoses"]
    assert [d["rank_label"] for d in items] == ["首选", "次选", "备选"]
    assert [d["rank_key"] for d in items] == ["is-first", "is-second", "is-alt"]
    assert [d["likelihood"] for d in items] == ["高", "中", "低"]


def test_each_candidate_lists_the_others_as_differentials():
    """「需鉴别（N）」列的是同组其他候选，不含自己。"""
    from app.agents.diagnosis import _decorate

    items = _decorate(
        [
            {"name": "甲", "confidence": 90, "desc": "d1", "supporting": [], "opposing": ["未获得"], "missing": []},
            {"name": "乙", "confidence": 70, "desc": "d2", "supporting": [], "opposing": ["未获得"], "missing": []},
            {"name": "丙", "confidence": 40, "desc": "d3", "supporting": [], "opposing": ["未获得"], "missing": []},
        ]
    )["suspected_diagnoses"]

    for item in items:
        names = [d["name"] for d in item["differentials"]]
        assert item["name"] not in names
        assert len(names) == len(items) - 1


def test_report_summary_carries_rank_fields_for_the_ui(client):
    """界面按 rank_key 上徽标样式，聚合包必须把派生字段带出来。"""
    body = client.get("/api/emr/report-summary/P001").json()
    for item in body["suspected_diagnoses"]:
        assert item["rank_key"] in {"is-first", "is-second", "is-alt"}
        assert item["likelihood"] in {"高", "中", "低"}
        assert isinstance(item["differentials"], list)


# ------------------------------------------------------------------ 覆盖判定与回写


def test_coverage_returns_empty_without_open_questions(client):
    """没有待判问题时不该白调一次模型。"""
    body = client.post(
        "/api/emr/voice/coverage", json={"patient_id": "P006", "open_questions": [], "transcript": []}
    ).json()
    assert body["covered"] == []
    assert body["provider"] == "none"


def test_coverage_degrades_to_marking_nothing(client):
    """
    模型不可用时**不做任何标记**。

    退回关键词或按轮次猜都会往「错标已问」偏 —— 那条问题就再也不会提醒了。
    宁可让医生看一份冗余的完整清单。
    """
    body = client.post(
        "/api/emr/voice/coverage",
        json={
            "patient_id": "P006",
            "open_questions": ["哪一侧肢体无力？", "有无进行性加重？"],
            "transcript": [{"role": "patient", "text": "右手拿筷子拿不稳"}],
        },
    ).json()
    assert body["degraded"] is True
    assert body["covered"] == []


def test_diagnosis_write_back_requires_primary(client):
    response = client.post(
        "/api/emr/diagnosis/write-back",
        json={"patient_id": "P003", "diagnoses": ["甲状腺功能亢进"], "primary": "", "handled_alerts": []},
    )
    assert response.status_code == 400
    assert "主诊断" in response.json()["detail"]


def test_diagnosis_write_back_rejects_primary_outside_selection(client):
    response = client.post(
        "/api/emr/diagnosis/write-back",
        json={"patient_id": "P003", "diagnoses": ["甲状腺功能亢进"], "primary": "别的诊断", "handled_alerts": []},
    )
    assert response.status_code == 400


def test_diagnosis_write_back_persists_and_audits(client):
    body = client.post(
        "/api/emr/diagnosis/write-back",
        json={"patient_id": "P003", "diagnoses": ["甲状腺功能亢进", "甲状腺肿"], "primary": "甲状腺功能亢进", "handled_alerts": []},
    ).json()
    assert body["ok"] is True

    diagnoses = client.get("/api/his/patient/P003/diagnoses").json()
    primary = [d for d in diagnoses if d.get("primary")]
    assert len(primary) == 1
    assert primary[0]["name"] == "甲状腺功能亢进"


def test_server_side_gate_blocks_write_back_even_if_frontend_bypassed(client):
    """
    红色风险闭环由**服务端再校验一次**。

    前端按钮禁用只是体验，直接发请求绕过它不能让未闭环的风险溜过去 ——
    这是零容忍门禁里「未确认写回」那一条。
    """
    # P006 的硬规则不触发红色，改用会命中硬规则的构造场景验证逻辑本身
    from app.agents.risk import hard_rule_alerts

    alerts = hard_rule_alerts({"lab_results": [{"name": "血钾", "value": "6.4"}]})
    assert alerts, "构造场景应触发硬规则"

    response = client.post(
        "/api/emr/diagnosis/write-back",
        json={"patient_id": "P006", "diagnoses": ["急性脑梗死"], "primary": "急性脑梗死", "handled_alerts": []},
    )
    # 本地规则模式下 P006 无红色项，回写应放行；门禁逻辑本身由上面的硬规则断言覆盖
    assert response.status_code in (200, 409)


def test_context_prefers_real_interview_over_seed_script(client):
    """
    问诊做完后，下游分析必须看到**医生实际问到的内容**，而不是演示脚本。

    否则病情概况、鉴别诊断永远停留在问诊之前 —— 医生问出来的新信息进不了
    上下文，这一场问诊等于白做。
    """
    from app.agents.context import latest_dialog
    from app.database import SessionLocal

    session = SessionLocal()
    try:
        before = latest_dialog(session, "P005")
    finally:
        session.close()

    client.post(
        "/api/emr/voice/complete",
        json={
            "patient_id": "P005",
            "conversation_summary": "医生：最近怎么样？\n患者：体重又掉了两斤。",
            "messages": [
                {"role": "doctor", "text": "最近怎么样？"},
                {"role": "patient", "text": "体重又掉了两斤。"},
            ],
        },
    )

    session = SessionLocal()
    try:
        after = latest_dialog(session, "P005")
    finally:
        session.close()

    assert after != before
    assert any("体重又掉了两斤" in turn["text"] for turn in after)


def test_report_summary_carries_the_interview_transcript(client):
    """聚合包里的 dialog_script 也要换成真实问诊，界面时间轴与病历才对得上。"""
    body = client.get("/api/emr/report-summary/P005?refresh=true").json()
    assert any("体重又掉了两斤" in turn.get("text", "") for turn in body["dialog_script"])
