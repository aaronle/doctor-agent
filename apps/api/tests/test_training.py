"""微调语料采集。**采的是「医生改了什么」，不是「AI 输出了什么」。**"""

from app.database import SessionLocal
from app.models import Patient, RecordDraft, TrainingSample
from app.training import (
    capture_diagnosis_sample, capture_record_sample, diff_fields,
    latest_ai_draft, verdict_of,
)


def _patient(session, pid="PT-1", payload=None):
    p = Patient(id=pid, name="测试", gender="女", age=60, dept="骨科",
                chief_complaint="膝痛", primary_diagnosis="骨关节炎", payload=payload or {})
    session.add(p)
    session.flush()
    return p


def test_verdict_accepted_when_nothing_changed():
    """一字未改**也是有效语料** —— 它说明模型在这类病例上是对的。"""
    ai = {"chief_complaint": "双膝疼痛 5 年"}
    assert verdict_of(ai, dict(ai), diff_fields(ai, dict(ai))) == "accepted"


def test_verdict_edited_when_doctor_tweaks():
    ai = {"present_illness": "患者 3 天前晨起发现右手无力。"}
    doc = {"present_illness": "患者 5 天前午后发现右手无力。"}
    changed = diff_fields(ai, doc)

    assert verdict_of(ai, doc, changed) == "edited"
    # 改动量如实记录成连续量，**不在采集阶段压成布尔** ——
    # 「改多少算改」是分析时的事，过早定阈值就得重新采数据
    assert 0 < changed["present_illness"]["similarity"] < 1


def test_verdict_discarded_when_doctor_rewrites_everything():
    """整段重写要单独标出来 —— 这是最值钱也最刺眼的一类。"""
    ai = {"a": "甲乙丙丁戊己庚辛", "b": "壬癸子丑寅卯辰巳"}
    doc = {"a": "ABCDEFGH", "b": "IJKLMNOP"}
    assert verdict_of(ai, doc, diff_fields(ai, doc)) == "discarded"


def test_no_ai_draft_means_no_sample(client):
    """找不到 AI 初稿就不采。

    没有对照的「医生写了什么」不是监督信号，只是一份病历副本 ——
    存进来只增加隐私面，不增加训练价值。
    """
    s = SessionLocal()
    try:
        p = _patient(s, "PT-NOAI")
        assert capture_record_sample(s, p, {"chief_complaint": "膝痛"}) is None
        assert s.query(TrainingSample).filter_by(patient_id="PT-NOAI").count() == 0
    finally:
        s.rollback(); s.close()


def test_doctor_own_stash_is_not_mistaken_for_ai_draft(client):
    """医生自己暂存的版本**不能当成 AI 初稿**。

    拿它当对照，会把医生自己的修改算成模型的产出 —— 语料直接反了。
    """
    s = SessionLocal()
    try:
        p = _patient(s, "PT-STASH")
        s.add(RecordDraft(patient_id=p.id, version=1, fields={"chief_complaint": "AI 写的"}, provider="model"))
        s.add(RecordDraft(patient_id=p.id, version=2, fields={"chief_complaint": "医生暂存的"}, provider="doctor-stash"))
        s.flush()

        draft = latest_ai_draft(s, p.id)
        assert draft is not None and draft.fields["chief_complaint"] == "AI 写的"
    finally:
        s.rollback(); s.close()


def test_capture_pairs_ai_draft_with_doctor_final(client):
    s = SessionLocal()
    try:
        p = _patient(s, "PT-PAIR")
        s.add(RecordDraft(patient_id=p.id, version=1, provider="model",
                          fields={"chief_complaint": "双膝疼痛 5 年", "present_illness": "AI 写的现病史"},
                          provenance={"present_illness": "lab_results"}))
        s.flush()

        sample = capture_record_sample(s, p, {
            "chief_complaint": "双膝疼痛 5 年",
            "present_illness": "医生改过的现病史",
        })

        assert sample is not None
        assert sample.ai_output["present_illness"] == "AI 写的现病史"
        assert sample.doctor_output["present_illness"] == "医生改过的现病史"
        assert sample.verdict == "edited"
        assert "present_illness" in sample.changed
        assert "chief_complaint" not in sample.changed      # 没改的不进 changed
        # 来源映射要带上：AI 是照着什么写的，微调时是重要输入线索
        assert sample.context["provenance"] == {"present_illness": "lab_results"}
    finally:
        s.rollback(); s.close()


def test_fixture_data_is_trainable_real_his_is_not(client):
    """**合规闸**：真实院内数据默认不可训练，要人工过完审查才翻。

    虚构演示数据怎么用都行；真实患者数据用于模型训练要过去标识化、
    伦理审批、患者知情同意 —— 那是人来判断的事，不该由一行代码默认放行。
    """
    s = SessionLocal()
    try:
        fx = _patient(s, "PT-FX")
        his = _patient(s, "PT-HIS", payload={"source": "his"})
        for p in (fx, his):
            s.add(RecordDraft(patient_id=p.id, version=1, provider="model", fields={"a": "x"}))
        s.flush()

        a = capture_record_sample(s, fx, {"a": "y"})
        b = capture_record_sample(s, his, {"a": "y"})

        assert a.trainable is True and a.source == "fixture"
        assert b.trainable is False and b.source == "his"
        # 「能用」和「已脱敏」是两件事，不能并成一个布尔
        assert b.deidentified is False
    finally:
        s.rollback(); s.close()


def test_diagnosis_sample_records_what_doctor_dropped_and_added(client):
    """诊断的监督信号是**勾选**：没被勾的是负样本，医生自己加的是模型漏掉的。"""
    s = SessionLocal()
    try:
        p = _patient(s, "PT-DX")
        sample = capture_diagnosis_sample(
            s, p,
            ai_suspected=[{"name": "膝骨关节炎"}, {"name": "痛风性关节炎"}, {"name": "类风湿关节炎"}],
            doctor_confirmed=["膝骨关节炎", "骨质疏松症"],
        )

        assert sample.changed["kept"] == ["膝骨关节炎"]
        assert sample.changed["dropped"] == ["痛风性关节炎", "类风湿关节炎"]
        assert sample.changed["added"] == ["骨质疏松症"]
        assert sample.verdict == "edited"
    finally:
        s.rollback(); s.close()


def test_diagnosis_all_dropped_is_discarded(client):
    s = SessionLocal()
    try:
        p = _patient(s, "PT-DX2")
        sample = capture_diagnosis_sample(
            s, p, ai_suspected=[{"name": "甲"}, {"name": "乙"}], doctor_confirmed=["丙"],
        )
        assert sample.verdict == "discarded"
    finally:
        s.rollback(); s.close()


def test_ai_draft_is_persisted_so_it_can_be_paired(client):
    """AI 起草**必须落库**，否则永远配不出语料。

    实测线上：起草 → 医生改一处 → 提交，`training_samples` 里一条都没有。
    根因是 `generate-record-auto` 只把结果返回给前端，从不落 `record_drafts` ——
    于是 `latest_ai_draft` 找不到对照，`capture_record_sample` 直接返回 None。

    **「没落库」不会报错**：接口 200、界面正常、病历照样能提交，
    只有语料表一直是空的。这种缺陷只有端到端跑一遍才看得见。
    """
    from app.models import RecordDraft

    r = client.post("/api/emr/generate-record-auto", json={"patient_id": "P001"})
    assert r.status_code == 200

    from app.database import SessionLocal
    inner = SessionLocal()
    try:
        drafts = inner.query(RecordDraft).filter_by(patient_id="P001").all()
        ai = [d for d in drafts if not str(d.provider or "").startswith("doctor-")]
        assert ai, f"AI 起草没落库，现有 provider：{[d.provider for d in drafts]}"
    finally:
        inner.close()


def test_generate_then_submit_produces_a_sample(client):
    """端到端：起草 → 医生改 → 提交 → 语料落库。"""
    from app.database import SessionLocal
    from app.models import TrainingSample

    # 先过问诊门禁 —— 未生成分析时提交会被拦（那条拦截本身是对的，见 test_api）
    client.post("/api/emr/analysis/unlock", json={"patient_id": "P003", "reason": "skipped"})

    gen = client.post("/api/emr/generate-record-auto", json={"patient_id": "P003"}).json()
    fields = dict(gen["fields"])
    fields["present_illness"] = (fields.get("present_illness") or "") + "（医生补充：夜间加重）"

    alerts = client.get("/api/emr/red-alerts/P003").json()
    handled = [a["id"] for a in (alerts.get("alerts") or alerts) if a.get("level") == "高风险"]
    r = client.post("/api/emr/record/submit", json={
        "patient_id": "P003", "fields": fields, "handled_alerts": handled,
    })
    assert r.status_code == 200, r.text

    inner = SessionLocal()
    try:
        rows = inner.query(TrainingSample).filter_by(patient_id="P003").all()
        assert rows, "提交了病历却没采到语料"
        assert rows[-1].verdict in {"edited", "accepted"}
        assert rows[-1].doctor_output.get("present_illness", "").endswith("夜间加重）")
    finally:
        # **把队列状态还回去。** 提交病历 = 就诊完成 = 患者出队，
        # 而候诊列表那条用例会读队列 —— 测试库是会话级共享的，
        # 谁改了共享状态谁负责还原，否则就是随机序下的幽灵失败。
        from app.models import Patient
        p003 = inner.get(Patient, "P003")
        if p003 is not None:
            p003.in_queue = True
            inner.commit()
        inner.close()
