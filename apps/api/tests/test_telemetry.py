"""埋点。旁路系统 —— 它出问题不该让医生的操作失败。"""


def test_ingest_and_summarise(client):
    r = client.post("/api/telemetry/events", json={
        "session_id": "s1", "actor": "chen",
        "events": [
            {"event": "interview_start", "patient_id": "P008", "client_ts": 1},
            {"event": "tab_switch", "target": "预警评估", "client_ts": 2},
            {"event": "tab_switch", "target": "预警评估", "client_ts": 3},
            {"event": "tab_switch", "target": "病历管理", "client_ts": 4},
        ],
    })
    assert r.status_code == 200 and r.json()["accepted"] == 4

    u = client.get("/api/telemetry/usage?days=7").json()
    assert u["total_events"] >= 4
    counts = {x["event"]: x["count"] for x in u["by_event"]}
    assert counts["tab_switch"] >= 3
    # 细分到 target：「哪个标签页点得多」才是产品要问的
    targets = {(x["event"], x["target"]): x["count"] for x in u["by_target"]}
    assert targets[("tab_switch", "预警评估")] >= 2


def test_per_session_not_just_total(client):
    """人均次数不能只看总量 —— 一个人狂点就能把总量刷上去。"""
    for sid in ("a", "b"):
        client.post("/api/telemetry/events", json={
            "session_id": sid, "events": [{"event": "ping"}],
        })
    u = client.get("/api/telemetry/usage?days=7").json()
    assert u["sessions"] >= 2
    assert u["per_session"] > 0


def test_bad_payload_still_200(client):
    """**永远 200。** 埋点是旁路，报错会让医生以为自己的操作失败了。

    超长的事件名截断而不是拒收：一条脏数据的代价，远小于因为一条太长
    把整批退回去。
    """
    r = client.post("/api/telemetry/events", json={
        "session_id": "x",
        "events": [{"event": "E" * 500, "target": "T" * 500, "props": {"a": 1}}],
    })
    assert r.status_code == 200
    assert r.json()["accepted"] == 1


def test_batch_is_capped(client):
    """一次灌几万条要挡住 —— 埋点不该有能力把库写爆。"""
    r = client.post("/api/telemetry/events", json={
        "session_id": "flood",
        "events": [{"event": "spam"} for _ in range(500)],
    })
    assert r.json()["accepted"] == 200


def test_empty_batch_is_fine(client):
    r = client.post("/api/telemetry/events", json={"session_id": "e", "events": []})
    assert r.status_code == 200 and r.json()["accepted"] == 0


def test_training_summary_shape(client):
    """语料概览。**最要紧的是 edited 占比** —— 那是模型和医生的分歧率。"""
    s = client.get("/api/telemetry/training").json()
    for key in ("total", "trainable_count", "by_verdict", "by_agent", "recent"):
        assert key in s


def test_training_list_carries_no_record_text(client):
    """列表**不带病历正文**。

    概览页不需要原文；顺手把它塞进一个随手可访问的接口，
    等于给自己开了个数据出口。
    """
    from app.database import SessionLocal
    from app.models import TrainingSample

    inner = SessionLocal()
    try:
        inner.add(TrainingSample(
            patient_id="P-LEAK", agent_key="record", task="submit_record",
            context={"chief_complaint": "机密主诉"},
            ai_output={"present_illness": "机密现病史"},
            doctor_output={"present_illness": "机密定稿"},
            verdict="edited", changed={"present_illness": {"similarity": 0.5}},
        ))
        inner.commit()
    finally:
        inner.close()

    body = client.get("/api/telemetry/training").text
    assert "机密" not in body
