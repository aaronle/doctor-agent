"""
预问诊（患者候诊时自己填）。

三件事分开测：**登录**（确认是本人）、**问题集**（科室定义）、
**答案落地**（医生看得到、病历用得上）。

贯穿其中的一条安全约束：**患者自报的过敏史不改档案状态**。
患者在手机上点一下「没有过敏」，与医生问过并确认，是两件事 ——
后者才是 `allergy_status` 的判据。混为一谈会消掉那条提醒医生去问的告警，
而下游的过敏冲突红线正建立在它之上。
"""

from __future__ import annotations


# ─────────────────────────────────────────────── 登录


def test_login_needs_both_id_and_name(client):
    """病人号与姓名**两项都对**才放行。"""
    ok = client.post("/api/previsit/login", json={"patient_id": "P009", "name": "郑某某"})
    assert ok.status_code == 200
    body = ok.json()
    assert body["patient_id"] == "P009"
    assert body["dept"] == "妇科"


def test_login_does_not_say_which_field_was_wrong(client):
    """
    对不上时**不说是哪一项错了**。

    说了就等于：拿到一个病人号的人可以逐个试姓名，直到不再报「姓名错误」——
    那是一份可枚举的患者名单。两种错法必须返回同一句话、同一个状态码。
    """
    wrong_name = client.post("/api/previsit/login", json={"patient_id": "P009", "name": "王某某"})
    wrong_id = client.post("/api/previsit/login", json={"patient_id": "P999", "name": "郑某某"})

    assert wrong_name.status_code == wrong_id.status_code == 404
    # **判据是两次回复完全一致**，不是「文案里不许出现某个词」——
    # 对称地提到两项（「病人号与姓名对不上」）恰恰是对的，它不指认任何一项。
    # 第一版按关键词断言，把这句正确的文案判成了泄露
    assert wrong_name.json()["detail"] == wrong_id.json()["detail"]
    for singling_out in ("姓名错误", "姓名不对", "患者不存在", "病人号不存在", "无此患者"):
        assert singling_out not in wrong_name.json()["detail"]


def test_login_returns_nothing_clinical(client):
    """
    登录返回体里**不能有任何临床数据**。

    患者这条路只填自己的情况；诊断、检验、风险一个字都不该下发到这个端 ——
    「界面不显示」不算数，接口不给才算。
    """
    body = client.post("/api/previsit/login", json={"patient_id": "P009", "name": "郑某某"}).json()
    forbidden = {
        "suspected_diagnoses", "lab_results", "risk_level", "orders",
        "past_history", "primary_diagnosis", "vitals", "diagnoses",
    }
    assert not (forbidden & set(body)), f"泄露了临床字段：{forbidden & set(body)}"


# ─────────────────────────────────────────────── 问题集


def test_questions_are_common_plus_department(client):
    """通用题 + 本科室题。科室没有专属题时只给通用题，不报错。"""
    gyn = client.get("/api/previsit/questions/P009").json()
    assert [q["key"] for q in gyn["common"]][:1] == ["chief_complaint"]
    assert "lmp" in [q["key"] for q in gyn["dept"]], "妇科要问末次月经"
    assert gyn["dept_name"] == "妇科"


def test_questions_avoid_jargon(client):
    """
    题面**不用术语**。「末次月经」患者不一定懂，问的是同一件事，
    但要用他们说得出口的话问。
    """
    gyn = client.get("/api/previsit/questions/P009").json()
    labels = " ".join(q["label"] for q in gyn["common"] + gyn["dept"])
    for jargon in ("末次月经", "主诉", "既往史", "阴性", "阳性", "依从性"):
        assert jargon not in labels, f"题面里出现了术语：{jargon}"


def test_every_question_offers_an_out(client):
    """
    每题都要有「不确定 / 记不清 / 没有」这类出口。

    逼患者在不知道的时候选一个，产出的是**看起来像数据的猜测** ——
    而它会一路进到病历里，比空着更糟。
    """
    gyn = client.get("/api/previsit/questions/P009").json()
    outs = ("不确定", "记不清", "说不好", "说不清", "没有", "没在", "都没有",
            "已绝经", "已经绝经", "最近没测", "其他")
    for q in gyn["common"] + gyn["dept"]:
        # 能自由填字的题，出口就是那个输入框本身 —— 不必再给一个「不确定」选项
        if q["type"] in ("text", "pair", "date", "multi_text"):
            has_out = bool(q.get("options")) or q["type"] in ("text", "pair", "date")
            assert has_out, f"{q['key']} 既不能填字也没有选项"
            continue
        assert any(any(o in opt for o in outs) for opt in q["options"]), f"{q['key']} 没有给出口"


# ─────────────────────────────────────────────── 答案落地


def _answer(client, patient="P009"):
    return client.post("/api/previsit/answers", json={
        "patient_id": patient,
        "name": "郑某某",
        "answers": {
            "chief_complaint": {"choices": ["阴道出血"], "text": ""},
            "duration": {"choice": "1–4 周"},
            "allergy": {"choice": "有", "text": "青霉素"},
            "lmp": {"date": "2026-05-28"},
            "cycle_regular": {"choice": "不太规律"},
        },
    })


def test_answers_are_visible_to_the_doctor(client):
    """医生端读得到，且带上「谁填的、什么时候填的」。"""
    assert _answer(client).status_code == 200
    got = client.get("/api/previsit/answers/P009").json()
    assert got["submitted_at"], "没有提交时间，医生分不清是这次还是上次填的"
    assert got["answers"]["lmp"]["date"] == "2026-05-28"
    assert got["source"] == "patient", "来源必须标出来，不能和医生问出来的混在一起"


def test_patient_reported_allergy_does_not_change_the_record(client):
    """
    **患者自报过敏不改档案状态。**

    P004 档案里是 `unknown`（没人问过），患者自己填了「没有过敏」——
    档案必须还是 `unknown`，那条提醒医生补问的中风险告警必须还在。
    """
    before = client.get("/api/his/patient/P004").json()["allergy_status"]
    assert before == "unknown", "这条用例的前提是档案原本没采集过"

    client.post("/api/previsit/answers", json={
        "patient_id": "P004", "name": "陈某",
        "answers": {"allergy": {"choice": "没有", "text": ""}},
    })

    after = client.get("/api/his/patient/P004").json()
    assert after["allergy_status"] == "unknown", "患者点一下就把档案改了 —— 告警会被消掉"

    alerts = client.get("/api/emr/red-alerts/P004").json()["alerts"]
    assert any(a.get("rule") == "allergy_not_collected" for a in alerts), "补问提醒不该消失"


def test_patient_reported_allergy_is_surfaced_for_confirmation(client):
    """
    但也**不能就这么埋着**。医生端要能看到「患者自填：青霉素 · 待确认」，
    否则这次采集等于白做。
    """
    _answer(client)
    got = client.get("/api/previsit/answers/P009").json()
    assert got["answers"]["allergy"]["text"] == "青霉素"
    assert got["needs_confirmation"] is True


def test_answers_reach_the_record_context(client):
    """
    病历上下文里要带上预问诊，并且**标明是患者自述**。

    与医生问出来的分开：来源不同，可信度不同，写进病历的措辞也该不同。
    """
    _answer(client)
    from app.agents.context import build_context
    from app.database import SessionLocal
    from app.models import Patient

    with SessionLocal() as session:
        patient = session.get(Patient, "P009")
        ctx = build_context(session, patient)

    assert "previsit" in ctx, "病历岗位拿不到预问诊，等于这个功能没接上"
    assert ctx["previsit"]["source"] == "patient"
    assert ctx["previsit"]["answers"]["lmp"]["date"] == "2026-05-28"


def test_resubmitting_replaces_instead_of_appending(client):
    """
    重填是**覆盖**不是追加。同一次就诊里两份互相矛盾的答案，
    医生没有办法判断该信哪一份。
    """
    _answer(client)
    client.post("/api/previsit/answers", json={
        "patient_id": "P009", "name": "郑某某",
        "answers": {"duration": {"choice": "半年以上"}},
    })
    got = client.get("/api/previsit/answers/P009").json()
    assert got["answers"]["duration"]["choice"] == "半年以上"
    assert "chief_complaint" not in got["answers"], "上一份没被覆盖掉"


def test_answers_require_matching_name(client):
    """提交也要校验姓名 —— 否则拿到病人号就能替别人填。"""
    bad = client.post("/api/previsit/answers", json={
        "patient_id": "P009", "name": "李某某", "answers": {"duration": {"choice": "今天"}},
    })
    assert bad.status_code == 404


def test_record_prompt_demands_a_source_label(client):
    """
    病历提示词必须要求模型**标出「患者自述」**。

    患者手机上点的和医生问出来的，可信度不同。混在一起写，
    病历上就再也分不出哪句是医生确认过的 —— 而病历是要被别的科室、
    别的医院读的，来源丢了就补不回来。

    过敏那一项额外再钉一次：**不得当作已确认写进既往史**。
    """
    from app.agents.record import RecordAgent

    ctx_with = {"previsit": {"source": "patient", "answers": {"lmp": {"date": "2026-05-28"}}}}
    prompt = RecordAgent().task_instruction(ctx_with)
    assert "患者自述" in prompt
    assert "过敏" in prompt and "不得" in prompt

    # 没填过预问诊时不要凭空多出这段 —— 提示词越长，模型越容易漏掉别的约束
    assert "患者自述" not in RecordAgent().task_instruction({})


# ─────────────────────────────── 确认病例（2026-09-08，演示态）


def test_confirm_record_is_blocked_by_open_red_lines(client):
    """
    确认病例与确认诊断**受同一道门禁**。

    它是「这份病历我认了，可以回填 HIS」的意思 —— 与回写诊断同一量级的动作，
    没有理由只拦一个。红线未处置时必须拦住。
    """
    client.post("/api/emr/analysis/unlock", json={"patient_id": "P009", "reason": "skipped"})
    alerts = client.get("/api/emr/red-alerts/P009").json()
    open_red = [a["id"] for a in alerts["alerts"] if a["level"] == "高风险"]
    assert open_red, "P009 得有未处置红线，否则这条用例是空过的"

    blocked = client.post("/api/emr/record/confirm", json={
        "patient_id": "P009", "fields": {"chief_complaint": "阴道不规则出血"}, "handled_alerts": [],
    })
    assert blocked.status_code == 409

    passed = client.post("/api/emr/record/confirm", json={
        "patient_id": "P009", "fields": {"chief_complaint": "阴道不规则出血"}, "handled_alerts": open_red,
    })
    assert passed.status_code == 200, passed.text


def test_confirm_record_says_it_did_not_write_to_his(client):
    """
    **演示态：不真的回填 HIS。**

    而返回体必须说出来。这个仓库最不能出现的一种东西是伪造的成功文案 ——
    医生看到「已回填 HIS」就会停止核对，而实际什么都没发生。
    真接 HIS 之前，宁可说「已确认，尚未回填」。
    """
    client.post("/api/emr/analysis/unlock", json={"patient_id": "P003", "reason": "skipped"})
    body = client.post("/api/emr/record/confirm", json={
        "patient_id": "P003", "fields": {"chief_complaint": "甲状腺复诊"}, "handled_alerts": [],
    }).json()

    assert body["written_to_his"] is False
    assert "尚未" in body["message"] or "未回填" in body["message"]
    assert "已回填" not in body["message"]


def test_confirm_record_leaves_an_audit_trail(client):
    """确认是个有后果的动作，必须留痕 —— 谁、什么时候、认的哪一版。"""
    from app.database import SessionLocal
    from app.models import AuditLog

    client.post("/api/emr/analysis/unlock", json={"patient_id": "P003", "reason": "skipped"})
    client.post("/api/emr/record/confirm", json={
        "patient_id": "P003", "fields": {"chief_complaint": "甲状腺复诊"}, "handled_alerts": [],
    })
    with SessionLocal() as session:
        rows = session.query(AuditLog).filter_by(entity="record_confirm").all()
    assert rows, "确认病例没留审计"


def test_confirm_record_is_visible_afterwards(client):
    """确认过的要能读回来，否则医生刷新一下就不知道自己认没认过。"""
    client.post("/api/emr/analysis/unlock", json={"patient_id": "P003", "reason": "skipped"})
    client.post("/api/emr/record/confirm", json={
        "patient_id": "P003", "fields": {"chief_complaint": "甲状腺复诊"}, "handled_alerts": [],
    })
    state = client.get("/api/emr/visit-state/P003").json()
    assert state["record_confirmed"] is True
