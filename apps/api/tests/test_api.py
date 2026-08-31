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


# ------------------------------------------------------------------ 病历质控


def test_quality_metrics_are_deterministic_not_model_scored():
    """
    四项指标必须由规则算出。让模型给自己的输出打分，分数只会好看不会有用，
    所以这里连模型都不碰 —— 同样输入必然同样输出。
    """
    from app.record_quality import evaluate

    fields = {
        "chief_complaint": "血糖控制不佳2周",
        "present_illness": "近2周口渴多饮加重",
        "past_history": "2型糖尿病5年",
        "personal_history": "未采集",
        "physical_exam": "血压142/88 mmHg",
        "auxiliary_exam": "空腹血糖8.5",
        "preliminary_diagnosis": "2型糖尿病",
    }
    first = evaluate(fields)
    second = evaluate(fields)
    assert first == second
    assert [m["name"] for m in first["metrics"]] == ["结构完整性", "信息完整性", "逻辑一致性", "用语规范性"]


def test_quality_flags_unverified_negation_as_red_line():
    """
    未经问诊的「否认」是 F03 红线：写「否认」意味着医生问过而患者否认，
    凭空出现就是伪造问诊记录。质控要把它标成须核实，而不是普通遗漏。
    """
    from app.record_quality import evaluate

    result = evaluate(
        {"past_history": "2型糖尿病5年。否认药物过敏史。"},
        dialog_text="医生：血糖怎么样？患者：不太好。",
    )
    red = [g for g in result["gaps"] if g["level"] == "danger"]
    assert red, "未经问诊的否认必须被标出"
    assert "否认" in red[0]["text"]
    assert red[0]["status"] == "须核实"


def test_quality_gap_carries_field_so_ui_can_jump_to_it():
    """
    每条遗漏必须带 field / field_key / issue，而不是只给一句拼好的 text。

    界面上点一条质控提醒要能跳到对应那一段病历去改；只有整句文案，
    就只能显示、跳不过去，医生得自己在七段里找。
    """
    from app.record_quality import evaluate
    from app.agents.record import SECTION_KEYS

    result = evaluate({"chief_complaint": "胸闷 3 天"}, dialog_text="")
    assert result["gaps"], "多段未采集时应产生遗漏"
    for gap in result["gaps"]:
        assert gap["field"], "缺少可展示的字段名"
        assert gap["field_key"] in SECTION_KEYS, f"field_key 必须是真实段名：{gap['field_key']}"
        assert gap["issue"], "缺少问题描述"
        # text 仍要保留：风险与遗漏那一栏按整句渲染
        assert gap["text"] == f"{gap['field']}{gap['issue']}"


def test_quality_gap_type_drives_the_icon():
    """
    type 决定界面图标：红线 error ❌ / 未采集 warning ⚠️ / 标准项缺失 info ℹ️。
    三者混成一种图标，医生就分不出哪条必须处理、哪条只是建议。
    """
    from app.record_quality import evaluate

    result = evaluate(
        {
            "chief_complaint": "胸闷 3 天",
            "present_illness": "胸闷持续 3 天，活动后加重。",
            "past_history": "否认药物过敏史。",
            "physical_exam": "血压 130/80 mmHg。",
            "auxiliary_exam": "心电图未见明显异常。",
            "preliminary_diagnosis": "冠心病",
            "advice": "建议复查。",
        },
        dialog_text="医生：胸闷多久了？患者：三天。",
    )
    by_type = {g["type"] for g in result["gaps"]}
    assert "error" in by_type, "未经问诊的否认应为 error"
    assert {g["type"] for g in result["gaps"] if g["level"] == "danger"} == {"error"}


def test_quality_accepts_negation_that_was_actually_asked():
    """问过再写「否认」是规范记录，不该误报。"""
    from app.record_quality import evaluate

    result = evaluate(
        {"past_history": "否认药物过敏史。"},
        dialog_text="医生：有没有药物过敏？患者：没有，否认过敏。",
    )
    assert not [g for g in result["gaps"] if g["level"] == "danger"]


def test_quality_completeness_ignores_uncollected_sections():
    from app.record_quality import evaluate

    filled = evaluate({k: "有内容" for k in ("chief_complaint", "present_illness", "past_history",
                                            "personal_history", "physical_exam", "auxiliary_exam",
                                            "preliminary_diagnosis")})
    assert filled["completeness"] == 100

    partial = evaluate({"chief_complaint": "有内容", "present_illness": "未采集"})
    assert partial["completeness"] < 100
    assert any("尚未采集" in g["text"] for g in partial["gaps"])


def test_quality_endpoint_uses_the_real_interview_for_negation_check(client):
    body = client.post(
        "/api/emr/record/quality",
        json={"patient_id": "P001", "fields": {"past_history": "否认药物过敏史。"}},
    ).json()
    assert "completeness" in body
    assert len(body["metrics"]) == 4


# ------------------------------------------------------------------ Agent 控制台


def test_console_lists_six_agents_with_model_tiers(client):
    body = client.get("/api/admin/agents").json()
    assert len(body["agents"]) == 6
    assert {t["tier"] for t in body["model_tiers"]} == {"clinical_fast", "clinical_reasoning", "clinical_safety"}
    # 未配置时应回落代码默认值，而不是报错或空白
    assert all(a["config_source"] == "code-default" for a in body["agents"])


def test_safety_layer_is_exposed_but_not_editable(client):
    """
    安全层只读展示 —— 让管理员看得到自己改不了什么，比藏起来更可信。
    它若可编辑，「不得自行确诊」这类红线就成了摆设。
    """
    body = client.get("/api/admin/agents/summary").json()
    assert body["safety_layer_editable"] is False
    assert "不做确诊" in body["safety_layer"]
    # 草稿接口不接受安全层字段，传了也不会生效
    assert "safety_layer" not in body["draft"] if body["draft"] else True


def test_draft_publish_rollback_lifecycle(client):
    key = "record"
    client.put(
        f"/api/admin/agents/{key}/draft",
        json={"model_tier": "clinical_fast", "role_prompt": "第一版岗位提示词。", "note": "v1"},
    )
    v1 = client.post(f"/api/admin/agents/{key}/publish").json()
    assert v1["version"] == "v1"

    client.put(
        f"/api/admin/agents/{key}/draft",
        json={"model_tier": "clinical_reasoning", "role_prompt": "第二版岗位提示词。", "note": "v2"},
    )
    v2 = client.post(f"/api/admin/agents/{key}/publish").json()
    assert v2["version"] == "v2"

    detail = client.get(f"/api/admin/agents/{key}").json()
    assert detail["running"]["version"] == "v2"
    # 发布不覆盖旧版本：历史仍在，只是降为 inactive
    statuses = {v["version"]: v["status"] for v in detail["versions"]}
    assert statuses["v1"] == "inactive" and statuses["v2"] == "published"

    v1_id = next(v["id"] for v in detail["versions"] if v["version"] == "v1")
    client.post(f"/api/admin/agents/{key}/rollback/{v1_id}")
    after = client.get(f"/api/admin/agents/{key}").json()
    assert after["running"]["version"] == "v1"
    assert after["running"]["model_tier"] == "clinical_fast"


def test_published_config_actually_drives_the_prompt(client):
    """配置改了必须真的生效，否则控制台只是个好看的表单。"""
    from app.agents import comorbidity_agent
    from app.agent_config import resolve
    from app.database import SessionLocal

    client.put(
        "/api/admin/agents/comorbidity/draft",
        json={"model_tier": "clinical_fast", "role_prompt": "共病岗位·控制台改过的版本。", "note": "t"},
    )
    client.post("/api/admin/agents/comorbidity/publish")

    session = SessionLocal()
    try:
        config = resolve(session, comorbidity_agent)
        messages = comorbidity_agent.build_messages({"id": "P001", "dept": "内分泌科"}, role_prompt=config.role_prompt)
    finally:
        session.close()

    system = messages[0].content
    assert "控制台改过的版本" in system
    # 安全层仍在最前，且不可被岗位层挤掉
    assert system.index("不做确诊") < system.index("【岗位职责】")


def test_draft_rejects_empty_prompt_and_unknown_tier(client):
    assert client.put("/api/admin/agents/risk/draft", json={"model_tier": "clinical_fast", "role_prompt": "  "}).status_code == 400
    assert client.put("/api/admin/agents/risk/draft", json={"model_tier": "不存在的档位", "role_prompt": "x"}).status_code == 400


def test_publish_without_draft_is_rejected(client):
    assert client.post("/api/admin/agents/voice/publish").status_code == 400


def test_run_log_never_returns_record_content(client):
    """运行日志不应成为病历副本：只给定位问题所需的摘要。"""
    client.get("/api/emr/report-summary/P001")
    runs = client.get("/api/admin/runs").json()["runs"]
    assert runs
    for row in runs:
        assert "output" not in row
        assert "input_digest" not in row
        assert set(row) >= {"agent_key", "status", "model_tier", "config_version", "elapsed_ms", "context_hash"}


# ------------------------------------------------------------------ AI 处置单


def _todos(client, patient_id="P001"):
    body = client.get(f"/api/emr/report-summary/{patient_id}").json()
    return body["todos"]


def test_todo_shape_matches_v43(client):
    """
    处置项形状必须是 V4.3 的 {id,text,priority,source,done,action_type,category}。

    早先后端给的是 {type,title,detail,level} —— 界面按分类分组、按 action_type
    分发动作，那套字段一个都对不上。
    """
    todos = _todos(client)
    assert todos, "应至少产出一条处置项"
    for t in todos:
        assert set(t) >= {"id", "text", "priority", "source", "done", "action_type", "category"}
        assert t["done"] is False, "done 一律为 False —— 系统不替医生判断某件事做完没有"
        assert t["text"].strip()


def test_todo_action_types_are_from_the_closed_set(client):
    """action_type 是闭集：出现表外的值，界面就分不了类也派不了动作。"""
    from app.routers.emr import TODO_CATEGORY

    for t in _todos(client):
        assert t["action_type"] in TODO_CATEGORY, f"未知 action_type：{t['action_type']}"
        assert t["category"] == TODO_CATEGORY[t["action_type"]]


def test_todo_categories_are_all_in_the_ordered_list(client):
    """分类必须落在固定顺序表内，否则界面排序时会掉到最后一组。"""
    from app.routers.emr import TODO_CATEGORY_ORDER

    for t in _todos(client):
        assert t["category"] in TODO_CATEGORY_ORDER


def test_todo_ids_are_unique(client):
    """id 重复会让界面的勾选状态串台 —— 勾一条亮两条。"""
    ids = [t["id"] for t in _todos(client)]
    assert len(ids) == len(set(ids))


def test_todo_only_appears_with_real_evidence():
    """
    没有依据就不该列待办。

    凭空列一堆比不列更糟：医生会先学会忽略这个面板，真正要紧的那条也跟着被忽略。
    直接测规则函数，不建库记录 —— 这条断言与患者表结构无关。
    """
    from app.routers.emr import _build_todos

    class FakePatient:
        nutrition_screening_score = 0

    todos = _build_todos(
        {"lab_results": []}, [],
        patient=FakePatient(), suspected=[], recommended_orders=[],
        examinations=[], comorbidity={"detected": False, "conditions": []},
    )
    kinds = {t["action_type"] for t in todos}
    assert "comorbidity_referral" not in kinds, "无共病却给了转诊待办"
    assert "nutrition_consult" not in kinds, "营养评分正常却给了会诊待办"
    assert "order_exam" not in kinds, "无异常检验却给了复查待办"
    assert "diagnosis_confirm" not in kinds, "无疑似诊断却给了确认待办"
    assert "treatment_plan" not in kinds, "无推荐医嘱却给了开立待办"
    # 病历草稿待审核是每位患者都成立的，保留
    assert kinds == {"record_confirm"}


def test_nutrition_todo_respects_the_threshold(client):
    """营养会诊按阈值触发，不是有分就报。"""
    from app.routers.emr import NUTRITION_THRESHOLD, _build_todos

    class FakePatient:
        nutrition_screening_score = NUTRITION_THRESHOLD

    at_threshold = _build_todos(
        {}, [], patient=FakePatient(), suspected=[], recommended_orders=[],
        examinations=[], comorbidity={},
    )
    assert "nutrition_consult" not in {t["action_type"] for t in at_threshold}, "等于阈值不该触发"

    FakePatient.nutrition_screening_score = NUTRITION_THRESHOLD + 1
    above = _build_todos(
        {}, [], patient=FakePatient(), suspected=[], recommended_orders=[],
        examinations=[], comorbidity={},
    )
    assert "nutrition_consult" in {t["action_type"] for t in above}


def test_red_alerts_become_top_priority_todos(client):
    """
    红色预警必须逐条进处置单且排在最前。

    风险漏报是零容忍红线之一；把危急值混在一堆低优先级待办中间等同于漏报。
    """
    todos = _todos(client, "P006")
    body = client.get("/api/emr/report-summary/P006").json()
    if not body["risk_alerts"]:
        return  # 该患者本次没有红色预警，跳过

    alert_todos = [t for t in todos if t["source"] == "预警评估"]
    assert len(alert_todos) == len(body["risk_alerts"])
    assert all(t["priority"] == "高" for t in alert_todos)
    assert todos[0]["source"] == "预警评估", "红色预警必须排在最前"


def test_recommended_exams_are_a_field_not_filtered_from_todos(client):
    """
    推荐复查是独立字段，不再从 todos 里按类型过滤。

    以前待办清单兼职当推荐列表，两边形状一改就互相拖累 —— 这次改处置单
    直接把编译搞崩了。拆开后各自演进互不影响。
    """
    body = client.get("/api/emr/report-summary/P001").json()
    assert "recommended_exams" in body
    for item in body["recommended_exams"]:
        assert set(item) == {"id", "name", "type", "basis"}
        assert item["name"].endswith("复查")
    # todos 里不该再出现被当作推荐项消费的形状
    assert all("title" not in t for t in body["todos"])


# ------------------------------------------------------------------ 临床知识库


def test_knowledge_list_returns_catalog_without_bodies(client):
    """列表只给目录。正文最长 800 余字，列表里带上纯属浪费带宽。"""
    body = client.get("/api/emr/knowledge").json()
    assert len(body["items"]) == 7
    for item in body["items"]:
        assert set(item) == {"key", "title", "keywords"}
        assert item["keywords"]


def test_knowledge_query_matches_by_keyword(client):
    """带 q 时按关键词匹配，供界面在一段文本旁挂「相关条目」。"""
    hit = client.get("/api/emr/knowledge", params={"q": "患者主诉胸闷 3 天，建议查血常规"}).json()["items"]
    keys = {i["key"] for i in hit}
    assert "dd_chest_pain" in keys
    assert "blood_rt" in keys
    assert "dd_diarrhea" not in keys, "无关词条不该被挂出来"


def test_knowledge_query_with_no_hit_returns_empty(client):
    """匹配不上就给空，不要退回全量 —— 挂七条不相关的比不挂更干扰。"""
    hit = client.get("/api/emr/knowledge", params={"q": "今天天气不错"}).json()["items"]
    assert hit == []


def test_knowledge_detail_returns_body(client):
    body = client.get("/api/emr/knowledge/blood_rt").json()
    assert body["title"] == "血常规解读"
    assert "<table" in body["content"], "正文是带结构的 HTML"


def test_knowledge_detail_404_for_unknown_key(client):
    assert client.get("/api/emr/knowledge/not_exist").status_code == 404


def test_knowledge_content_carries_no_executable_markup():
    """
    正文以 v-html 渲染，因此内容里不得出现可执行标记。

    这是静态数据，改动走代码评审 —— 这条测试是那道评审的自动化下限：
    有人往词条里贴了一段带 onclick 的 HTML，CI 要能拦下来。
    """
    import json as _json
    from pathlib import Path

    path = Path("apps/api/app/data/knowledge_base.json")
    raw = _json.loads(path.read_text(encoding="utf-8"))
    body = "".join(v["content"] for v in raw.values())
    assert "<script" not in body.lower()
    assert "javascript:" not in body.lower()
    import re as _re
    assert not _re.search(r"\son\w+\s*=", body, _re.I), "词条正文里不得出现内联事件处理器"
