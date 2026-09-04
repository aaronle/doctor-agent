"""
科室看板：两个维度 —— **诊疗进度** 与 **风险**。

产品定义（2026-09-04 与产品负责人确认）：

> 病人看板主要是从两个维度回顾：
> ① 诊疗进度：哪些病人我已经看过了，哪些还没有
>   （比如**做完检查但检验报告还没回来的**）
> ② 风险评估：哪些病人可能有风险或有危急值，哪些是普通病人

它不是运营报表（那面向科主任，是另一个人另一个场景），
也不只是「下一个看谁」的队列 —— 它要能**回顾**，所以已完成的也要在。
"""


def test_board_lists_every_patient_of_the_day(client):
    """看板要能回顾，所以**出队的也在** —— 只显示候诊队列就回顾不了今天。"""
    body = client.get("/api/his/board").json()
    ids = {r["patient_id"] for r in body["rows"]}
    assert len(ids) >= 7
    assert "P007" in ids, "P007 不在候诊队列，但今天该被回顾到"


def test_progress_has_a_pending_report_state(client):
    """**「做完检查但报告没回」必须是独立一档。**

    它既不是「没看过」（医生已经开了单、做了判断），
    也不是「已完成」（结论还没法下）。合并进任何一边，
    医生就看不出「这个人还欠我一个报告」。
    """
    rows = {r["patient_id"]: r for r in client.get("/api/his/board").json()["rows"]}
    assert rows["P005"]["progress"] == "pending_report"
    assert rows["P005"]["pending_exams"] == 2

    # 报告全回来的不算这一档
    assert rows["P006"]["progress"] != "pending_report"
    assert rows["P006"]["pending_exams"] == 0


def test_progress_states_are_a_closed_set(client):
    """进度是闭集 —— 多一个值界面就没有对应样式，那一行会渲染成裸文字。"""
    allowed = {"not_started", "pending_report", "interviewed", "done"}
    for r in client.get("/api/his/board").json()["rows"]:
        assert r["progress"] in allowed, f"{r['patient_id']} 的进度是 {r['progress']}"


def test_risk_dimension_counts_open_red_lines(client):
    """风险维度给的是**未处置的红线条数**，不是总数。

    已处置的还算在里面，医生会以为自己没处理完。
    """
    rows = {r["patient_id"]: r for r in client.get("/api/his/board").json()["rows"]}
    p008 = rows["P008"]
    assert p008["open_red"] >= 1, "P008 有头孢过敏 × 在用头孢呋辛的红线"
    assert p008["allergy_status"] == "confirmed"

    p003 = rows["P003"]
    assert p003["open_red"] == 0


def test_ordinary_patients_are_marked_as_such(client):
    """**「没有风险的普通病人」要能一眼认出来。**

    产品定义里明确要区分这一类 —— 看板不能只标危险的，
    否则医生仍要逐个确认「这个是真没事还是我漏看了」。
    """
    rows = client.get("/api/his/board").json()["rows"]
    assert any(r["risk_tier"] == "ordinary" for r in rows), "一个普通病人都没有，这一维就没意义"
    for r in rows:
        assert r["risk_tier"] in {"critical", "warning", "ordinary"}


def test_rows_sorted_by_what_needs_me_first(client):
    """排序是「**该我处理的排前面**」，不是按患者号。

    有未处置红线的 > 报告已回但没看的 > 其余。
    """
    rows = client.get("/api/his/board").json()["rows"]
    tiers = [r["risk_tier"] for r in rows]
    first_ordinary = tiers.index("ordinary") if "ordinary" in tiers else len(tiers)
    assert all(t != "critical" for t in tiers[first_ordinary:]), \
        "普通病人后面还排着 critical，说明没按轻重排"


def test_board_has_a_summary_line(client):
    """顶上要给一句总数 —— 医生先看的是「今天还剩几个要处理」。"""
    body = client.get("/api/his/board").json()
    for k in ("total", "done", "pending_report", "needs_attention"):
        assert k in body, f"缺 {k}"
    assert body["total"] == len(body["rows"])


def test_handled_red_lines_stop_counting(client):
    """处置过的红线要从计数里扣掉。

    > 这条是变异验证逼出来的：`open_red` 里那句 `a["id"] not in handled`
    > 改掉之后**一条用例都不红** —— 因为测试数据里没有任何患者有已处置记录，
    > 那行扣减一直在空转。**没走到的分支等于没写。**
    """
    from app.database import SessionLocal
    from app.models import Patient
    from sqlalchemy.orm.attributes import flag_modified

    before = {r["patient_id"]: r for r in client.get("/api/his/board").json()["rows"]}
    assert before["P008"]["open_red"] >= 1, "P008 得先有未处置红线"
    red_id = None

    s = SessionLocal()
    try:
        p = s.get(Patient, "P008")
        payload = p.payload or {}
        from app.agents.risk import hard_rule_alerts
        alerts = hard_rule_alerts({
            "allergies": payload.get("allergies") or [],
            "allergy_status": payload.get("allergy_status") or "",
            "orders": payload.get("orders") or [],
        })
        red_id = next(a["id"] for a in alerts if a["level"] == "高风险")
        payload["handled_alerts"] = [red_id]
        p.payload = payload
        flag_modified(p, "payload")
        s.commit()
    finally:
        s.close()

    after = {r["patient_id"]: r for r in client.get("/api/his/board").json()["rows"]}
    assert after["P008"]["open_red"] == before["P008"]["open_red"] - 1
    assert red_id not in after["P008"]["red_names"]

    # 还原，别污染别的用例 —— 共享测试库，谁改了谁负责还
    s = SessionLocal()
    try:
        p = s.get(Patient, "P008")
        payload = p.payload or {}
        payload.pop("handled_alerts", None)
        p.payload = payload
        flag_modified(p, "payload")
        s.commit()
    finally:
        s.close()
