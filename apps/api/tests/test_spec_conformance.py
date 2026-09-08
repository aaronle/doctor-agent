"""
规格符合性：把 F01–F07 里**可判定**的硬约束逐条钉住。

这些约束当前都是满足的 —— 所以这份文件是**防回退**用的，不是发现问题用的。
每条都带文档出处（`docs/product/features/F0x-*.md` 的行号），
改规格时能顺着找过来；改实现时会先在这里变红。

刻意**不**收那些一期没做的（F07 的 `control_status`、F04 的临床后果排序）——
把没做的写成失败用例，等于给自己造一片永远红的门禁，下一个人只会给它加 skip。
那些记在 `docs/product/18-规格符合性走查.md` 里。
"""

import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[3] / "references/ui-demo/extracted/fixtures"


# ------------------------------------------------------------------ F03 病历生成


def test_f03_record_sections_are_a_closed_set():
    """F03：病历六段是**闭集**。

    服务端按段切分流式下发，多一段前端无从对齐 —— 那一段会静默丢失。
    """
    from app.agents.record import SECTION_KEYS

    assert SECTION_KEYS == (
        "chief_complaint", "present_illness", "past_history", "personal_history",
        "physical_exam", "auxiliary_exam",
    )


def test_f03_record_fixtures_carry_all_seven_sections():
    """每位患者的病历种子都要七段齐全 —— 缺的那段界面上是空白，不报错。"""
    from app.agents.record import SECTION_KEYS

    data = json.loads((FIXTURES / "record-content.json").read_text(encoding="utf-8"))
    for pid, rec in data.items():
        missing = [k for k in SECTION_KEYS if not str(rec.get(k) or "").strip()]
        assert not missing, f"{pid} 缺段：{missing}"


# ------------------------------------------------------------------ F04 鉴别诊断


def test_f04_opposing_evidence_says_unavailable_not_none():
    """F04 L44：反对证据没有时写「未获得」，**不得写「无」**。

    「无」是一个临床判断（我找过了，确实没有反对证据）；
    「未获得」是一个事实陈述（这次没拿到这项信息）。模型给不出前者。
    """
    from app.agents.schemas import SuspectedDiagnosis

    desc = SuspectedDiagnosis.model_fields["opposing"].description
    assert "未获得" in desc
    assert "不能编造" in desc


def test_f04_icd_may_be_blank_but_never_guessed():
    """F04：常见诊断给 ICD，罕见/拿不准的**留空而不是猜一个近似的**。

    过度保守和编造一样，都是没把该给的信息给医生 —— 所以不是「一律留空」。
    """
    from app.agents.schemas import SuspectedDiagnosis

    desc = SuspectedDiagnosis.model_fields["icd"].description
    assert "留空" in desc and "不要猜" in desc


def test_f04_confidence_is_multiple_of_five():
    """置信度取 5 的倍数 —— 模型没有更细的精度，给了也是假的。"""
    from app.agents.diagnosis import DiagnosisAgent

    out = DiagnosisAgent().validate(
        {"suspected_diagnoses": [
            {"name": "甲", "confidence": 73, "desc": "x", "supporting": ["a"],
             "opposing": [], "missing": []},
        ]},
        {},
    )
    assert out["suspected_diagnoses"][0]["confidence"] % 5 == 0


# ------------------------------------------------------------------ F05 诊断管理


def test_f05_primary_diagnosis_is_structurally_single():
    """F05 L25：主诊断在任一有效版本中**最多一个**。

    靠类型保证，不靠校验 —— `primary: str` 单值，多一个都传不进来。
    """
    from app.routers.emr import DiagnosisWriteBackIn

    assert DiagnosisWriteBackIn.model_fields["primary"].annotation is str


def test_f05_primary_must_be_among_selected(client):
    """主诊断必须在已选诊断里 —— 否则会写回一个没人勾过的诊断。"""
    r = client.post("/api/emr/diagnosis/write-back", json={
        "patient_id": "P001", "diagnoses": ["甲"], "primary": "乙", "handled_alerts": [],
    })
    assert r.status_code == 400
    assert "主诊断" in r.json()["detail"]


def test_f05_writeback_blocked_when_red_alerts_open(client):
    """F05 SAFE-001：红色风险未处置时**禁止**写回诊断。

    服务端再校验一次 —— 前端的按钮禁用只是体验，改 DOM 或直接发请求绕不过去。

    > 这条用例自带前置。第一版直接打 P002 就断言 409，随机序下时红时绿 ——
    > 别的用例可能已经把它解锁、把红线处置掉了。**依赖别人副作用的断言
    > 等于没有断言**，这个坑本轮踩到第二次了。
    >
    > 用 **P008** 而不是 P002：P008 的高风险来自**硬规则**（头孢过敏 ×
    > 在用头孢呋辛酯片，纯代码判定），确定性的；P002 的红线来自模型，
    > 而测试模式走本地规则，未必产出高风险 —— 那样这条又会变成时红时绿。
    """
    # 先过问诊门禁，否则 409 来自门禁而不是红线，测的就不是这条规格
    client.post("/api/emr/analysis/unlock", json={"patient_id": "P008", "reason": "skipped"})

    alerts = client.get("/api/emr/red-alerts/P008").json()
    open_red = [a["id"] for a in (alerts.get("alerts") or []) if a.get("level") == "高风险"]
    assert open_red, "P008 得有未处置的高风险（过敏冲突），否则这条用例是空过的"

    blocked = client.post("/api/emr/diagnosis/write-back", json={
        "patient_id": "P008", "diagnoses": ["双膝骨关节炎"], "primary": "双膝骨关节炎",
        "handled_alerts": [],
    })
    assert blocked.status_code == 409

    # 处置之后要放行 —— 只测「拦得住」不测「拦对了」，
    # 一个永远拒绝的接口也能通过上面那一半
    passed = client.post("/api/emr/diagnosis/write-back", json={
        "patient_id": "P008", "diagnoses": ["双膝骨关节炎"], "primary": "双膝骨关节炎",
        "handled_alerts": open_red,
    })
    assert passed.status_code == 200, passed.text


# ------------------------------------------------------------------ F06 风险管理


@pytest.mark.parametrize(
    "payload,expected",
    [
        ({"allergies": [], "allergy_status": "denied"}, False),
        ({"allergies": [], "allergy_status": "unknown"}, True),
        ({"allergies": [], "allergy_status": ""}, True),      # 缺省倒推
        ({"allergies": [], "allergy_status": None}, True),
    ],
)
def test_f06_allergy_default_is_unknown_never_denied(payload, expected):
    """F06 §2.1：**缺省只能是 `unknown`，绝不能是 `denied`。**

    「没人问过」和「问过、没有」在门诊完全不同。老数据没有显式状态时
    默认成 denied，等于替医生说了一句他从没说过的话。
    """
    from app.agents.risk import hard_rule_alerts

    alerts = hard_rule_alerts(payload)
    fired = any(a["rule"] == "allergy_not_collected" for a in alerts)
    assert fired is expected


def test_f06_allergy_term_must_substring_match_real_drug_names():
    """过敏原要能子串命中真实药名。

    硬规则是 `term in drug`。写成「头孢菌素类」不是任何药名的子串 ——
    规则静默失效，而界面看起来一切正常。
    """
    from app.agents.risk import hard_rule_alerts

    hit = hard_rule_alerts({
        "allergies": ["头孢"], "allergy_status": "confirmed",
        "orders": [{"drug": "头孢呋辛酯片"}],
    })
    assert any(a["rule"] == "allergy_conflict" for a in hit)

    miss = hard_rule_alerts({
        "allergies": ["头孢菌素类"], "allergy_status": "confirmed",
        "orders": [{"drug": "头孢呋辛酯片"}],
    })
    assert not any(a["rule"] == "allergy_conflict" for a in miss), (
        "写成「头孢菌素类」时规则确实失效 —— 这条用例是把这个陷阱记下来，"
        "fixture 侧由 test_p008_allergy_conflict_fires 守着"
    )


def test_f06_only_high_risk_blocks_writeback():
    """判据是 level，不是来源。中风险的硬规则不该阻断回写。

    「硬规则出的都是红的」在只有三条硬规则时成立，那是**巧合**不是不变量。
    """
    from app.agents.risk import merge_risks

    _merged, alerts, _c = merge_risks(
        [{"id": "h1", "name": "检查异常", "level": "中风险", "color": "warning", "summary": ""}],
        [],
    )
    assert alerts == []


# ------------------------------------------------------------------ F02 病情概况


def test_f02_summary_risk_level_is_closed_set():
    """风险分级闭集。多一个值界面就没有对应样式，那一条会渲染成裸文字。"""
    from app.agents.schemas import RISK_LEVEL_ORDER

    assert RISK_LEVEL_ORDER == ("高风险", "中风险", "低风险")


def test_f02_departments_closed_set_has_no_phantom_clinic():
    """会诊科室闭集里不得有本院没有的科室 —— 患者会照着去挂号。"""
    from app.agents.schemas import DEPARTMENTS

    assert "骨科" in DEPARTMENTS
    assert len(set(DEPARTMENTS)) == len(DEPARTMENTS), "闭集里有重复项"


# ------------------------------------------------------------------ F04 排序口径


def _dx(name, conf, sev):
    return {"name": name, "confidence": conf, "severity": sev, "desc": "x",
            "supporting": ["a"], "opposing": [], "missing": []}


def test_f04_orders_by_confidence_desc():
    """**置信度降序，唯一关键字**（2026-09-08 由用户拍板改）。

    此前是「先漏诊后果、再可能性」（原 F04 L51）。改回纯置信度是**用户在
    知晓冲突后的明确决定** —— 两轮里各说了一次，第二轮是在我把冲突摆出来
    之后。规格 L51 已同步改写，这条用例是它的钉子。

    代价写在这里，不藏着：10% 的主动脉夹层会排到 60% 的肋间神经痛下面。
    承接这个代价的是**卡片上的「不能漏」红标**（`severity == "critical"`），
    它照常出，只是不再影响顺序 —— 信号从「位置」换成了「标记」。
    """
    from app.agents.diagnosis import DiagnosisAgent

    out = DiagnosisAgent().validate({"suspected_diagnoses": [
        _dx("肋间神经痛", 60, "routine"),
        _dx("主动脉夹层", 10, "critical"),
        _dx("心绞痛", 40, "serious"),
    ]}, {})
    assert [d["name"] for d in out["suspected_diagnoses"]] == ["肋间神经痛", "心绞痛", "主动脉夹层"]


def test_f04_critical_tag_survives_the_reordering():
    """排序不看后果了，**标记还得在** —— 否则那条信息就整个没了。

    这条和上面那条是一对：上面钉顺序，这条钉「顺序变了但标记没丢」。
    只写上面那条的话，把 `severity` 整个删掉也能全绿。
    """
    from app.agents.diagnosis import DiagnosisAgent

    out = DiagnosisAgent().validate({"suspected_diagnoses": [
        _dx("肋间神经痛", 60, "routine"),
        _dx("主动脉夹层", 10, "critical"),
    ]}, {})
    by = {d["name"]: d["severity"] for d in out["suspected_diagnoses"]}
    assert by["主动脉夹层"] == "critical"
    assert by["肋间神经痛"] == "routine"


def test_f04_equal_confidence_keeps_input_order():
    """置信度打平时按原样保留 —— `sort` 稳定，不要在这里引入第二关键字。

    引入了就等于偷偷把「后果优先」放回来一半，而那正是这次改掉的东西。
    """
    from app.agents.diagnosis import DiagnosisAgent

    out = DiagnosisAgent().validate({"suspected_diagnoses": [
        _dx("先来的", 50, "routine"), _dx("后到的", 50, "critical"),
    ]}, {})
    assert [d["name"] for d in out["suspected_diagnoses"]] == ["先来的", "后到的"]


def test_f04_too_many_criticals_get_demoted_not_rejected():
    """**全标成 critical 等于没排序。**

    超出上限的降一档，而不是拒绝整份输出 —— 拒绝会让岗位降级，
    代价远大于把多出来的那几条降一级。
    """
    from app.agents.diagnosis import DiagnosisAgent, MAX_CRITICAL

    out = DiagnosisAgent().validate({"suspected_diagnoses": [
        _dx(f"诊断{i}", 90 - i * 5, "critical") for i in range(5)
    ]}, {})
    crit = [d for d in out["suspected_diagnoses"] if d["severity"] == "critical"]
    assert len(crit) == MAX_CRITICAL
    assert len(out["suspected_diagnoses"]) == 5, "多的是降档，不是丢弃"


def test_f04_unknown_severity_falls_to_routine_not_critical():
    """取值超出闭集时落到**最轻**的一档。

    拿不准就往上标，会让「不能漏」这个标记迅速贬值成噪声。
    """
    from app.agents.diagnosis import DiagnosisAgent

    out = DiagnosisAgent().validate({"suspected_diagnoses": [
        _dx("怪东西", 50, "very-urgent"), _dx("正常项", 40, "serious"),
    ]}, {})
    by = {d["name"]: d["severity"] for d in out["suspected_diagnoses"]}
    assert by["怪东西"] == "routine"
    assert by["正常项"] == "serious"


# ------------------------------------------------------------------ P009 妇科


def test_p009_two_hard_red_lines(client):
    """
    妇科病例必须同时触发两条**独立来源**的红线：过敏冲突与危急值。

    它们分别走硬规则的第 1 条和第 2 条 —— 一条来自「过敏史 × 在用医嘱」比对，
    一条来自检验阈值。同时在场才能证明红线不是靠某一条规则撑着的。
    """
    body = client.get("/api/emr/red-alerts/P009").json()
    reds = [a for a in body["alerts"] if a["level"] == "高风险"]
    rules = {a.get("rule") for a in reds}

    assert "allergy_conflict" in rules, "青霉素过敏 × 在用阿莫西林克拉维酸钾，必须拦"
    assert "critical_lab" in rules, "血红蛋白 58 g/L 低于危急值下限 60"

    allergy = next(a for a in reds if a.get("rule") == "allergy_conflict")
    assert "青霉素" in allergy["evidence"] and "阿莫西林" in allergy["evidence"]


def test_p009_writeback_blocked_until_red_lines_handled(client):
    """
    红线未处置时禁止回写诊断，处置后放行 —— 妇科这条线上同样成立（F05 SAFE-001）。

    两半都要测：只测「拦得住」的话，一个永远拒绝的接口也能通过。
    """
    # 先过问诊门禁，否则 409 来自门禁而不是红线，测的就不是这条规格
    client.post("/api/emr/analysis/unlock", json={"patient_id": "P009", "reason": "skipped"})

    alerts = client.get("/api/emr/red-alerts/P009").json()
    open_red = [a["id"] for a in (alerts.get("alerts") or []) if a.get("level") == "高风险"]
    assert open_red, "P009 得有未处置的高风险，否则这条用例是空过的"

    payload = {"patient_id": "P009", "diagnoses": ["异常子宫出血"], "primary": "异常子宫出血"}
    blocked = client.post("/api/emr/diagnosis/write-back", json={**payload, "handled_alerts": []})
    assert blocked.status_code == 409

    passed = client.post(
        "/api/emr/diagnosis/write-back", json={**payload, "handled_alerts": open_red}
    )
    assert passed.status_code == 200, passed.text


def test_p009_seed_diagnoses_are_ordered_by_consequence(client):
    """
    种子里的鉴别诊断按「先后果、再可能性」排 —— 与 F04 L51 的实现口径一致。

    这条盯的是**种子数据本身**：60% 的无排卵性出血排在 25% 的内膜癌之后。
    种子若按置信度排，演示时第一屏就与规格自相矛盾，而模型的输出反倒是对的。
    """
    body = client.get("/api/his/patient/P009").json()
    names = [d["name"] for d in body["suspected_diagnoses"]]
    conf = {d["name"]: d["confidence"] for d in body["suspected_diagnoses"]}

    cancer = names.index("子宫内膜癌")
    functional = names.index("围绝经期无排卵性异常子宫出血（AUB-O）")
    assert cancer < functional, "内膜癌必须排在无排卵性出血之前"
    assert conf["子宫内膜癌"] < conf["围绝经期无排卵性异常子宫出血（AUB-O）"], (
        "这条用例的前提就是「可能性更低」—— 若两者置信度反了，它就测不出排序原则"
    )


def test_p009_negative_findings_are_kept_not_dropped(client):
    """
    阴性结果要留在档案里。β-hCG、TSH、凝血四项都是**用来排除**的，
    删掉它们病历就只剩支持证据 —— F04 L44「反对证据没有时写未获得，不得写无」
    守的是同一件事，这里守的是数据源头。
    """
    body = client.get("/api/his/patient/P009").json()
    names = {lab["name"] for lab in body["lab_results"]}
    for must in ("人绒毛膜促性腺激素(β-hCG)", "促甲状腺激素(TSH)", "凝血酶原时间(PT)"):
        assert must in names, f"缺少排除性检验：{must}"
        lab = next(x for x in body["lab_results"] if x["name"] == must)
        assert lab["abnormal"] is False and lab["diff_note"], "阴性项必须带上它排除了什么"


def test_p009_has_pending_reports_for_the_board(client):
    """
    科室看板的「待报告」一档要有真实数据。做这个功能时发现库里 21 项检查
    全是「已完成」，那一档一条数据都没有 —— 新病例不该再把它做空。
    """
    exams = client.get("/api/emr/objective/P009").json()["examinations"]
    pending = [e for e in exams if e["status"] in ("已开单", "检查中")]
    assert len(pending) >= 2, "宫腔镜活检与阴道镜都还没出结果"


# -------------------------------------------------------------- 同类药交叉过敏


def test_allergy_matches_same_class_drugs():
    """
    过敏拦截必须认**同类药**，不能只做子串。

    「青霉素」与「阿莫西林」毫无字面交集，而阿莫西林就是青霉素类 ——
    这正是临床上最常见的一种过敏事故，只做子串会整条漏掉。
    P008 的「头孢 × 头孢呋辛酯片」能拦住，只是因为字面凑巧重合。
    """
    from app.agents.risk import hard_rule_alerts

    alerts = hard_rule_alerts({
        "allergy_status": "confirmed",
        "allergies": ["青霉素"],
        "orders": [{"drug": "阿莫西林克拉维酸钾片"}],
    })
    conflicts = [a for a in alerts if a.get("rule") == "allergy_conflict"]
    assert conflicts, "青霉素过敏 × 阿莫西林必须拦"
    assert "同属" in conflicts[0]["summary"], "要说清为什么拦 —— 医生看不出关联就会以为是误报"


def test_allergy_class_matching_is_bidirectional():
    """过敏史记成类名（青霉素）或具体药名（阿莫西林）都要拦得住 —— 两种写法都真实存在。"""
    from app.agents.risk import hard_rule_alerts

    alerts = hard_rule_alerts({
        "allergy_status": "confirmed",
        "allergies": ["阿莫西林"],
        "orders": [{"drug": "注射用哌拉西林钠"}],
    })
    assert [a for a in alerts if a.get("rule") == "allergy_conflict"]


def test_allergy_does_not_cross_between_classes():
    """
    **不做类间联想。** 青霉素与头孢确有 1–2% 交叉反应，但把所有头孢
    对青霉素过敏者标红会让红线迅速贬值成噪声 —— 与鉴别诊断限 2 条 critical
    是同一个道理：过度告警等于没有告警。需要权衡的那一档交给模型。
    """
    from app.agents.risk import hard_rule_alerts

    alerts = hard_rule_alerts({
        "allergy_status": "confirmed",
        "allergies": ["青霉素"],
        "orders": [{"drug": "头孢呋辛酯片"}],
    })
    assert not [a for a in alerts if a.get("rule") == "allergy_conflict"]


def test_allergy_class_table_uses_generic_names_only():
    """
    类表按通用名写，不收商品名。商品名成千上万且各院不同，
    一份追不全的清单会让人误以为「没告警就是安全」。
    """
    from app.agents.risk import DRUG_CLASSES

    flat = [m for members in DRUG_CLASSES.values() for m in members]
    assert flat, "类表不能是空的"
    for name in flat:
        assert not any(ch in name for ch in "®™()（）"), f"{name} 看起来像商品名"


# ------------------------------------------------------ 置信度的单位与降级排序


def test_seed_confidence_uses_the_same_unit_as_the_contract(client):
    """
    种子里的 `confidence` 必须和输出契约同一个单位：**0–100 整数**。

    契约写在 `schemas.py`（`ge=0, le=100`），界面直接渲染 `{{ confidence }}%`
    和 `width: ${confidence}%`。种子却一直用 0–1 小数 —— 两个单位并存，
    而降级路径 `int(0.94)` 会算出 **0**：所有鉴别诊断显示 0%，
    看起来像模型对每一条都毫无把握。

    模型在场时它的输出会盖掉种子，所以这个洞在正常路径上看不见 ——
    只在网关抖动降级时才露出来，而那正是演示最怕的时刻。
    """
    import json
    from pathlib import Path

    rows = json.loads(
        (Path(__file__).resolve().parents[3] / "references/ui-demo/extracted/fixtures/patients.json")
        .read_text(encoding="utf-8")
    )
    for patient in rows:
        for d in patient.get("suspected_diagnoses") or []:
            c = d["confidence"]
            assert isinstance(c, int), f"{patient['id']} {d['name']} 的 confidence 是 {c!r}，应为整数"
            assert 0 <= c <= 100, f"{patient['id']} {d['name']} 的 confidence 越界：{c}"
            assert c % 5 == 0, f"{patient['id']} {d['name']} 的 confidence 应取 5 的倍数：{c}"


def test_degraded_diagnosis_orders_the_same_way_as_the_model_path():
    """
    降级与模型路径**同一个口径**：置信度降序（2026-09-08 起）。

    两条路径的排序必须一起改。它们曾经反过一次 —— 模型路径按后果、降级按
    置信度，于是网关一抖，同一位患者的诊断列表顺序就变了，而界面上看不出
    发生过降级。这次改回纯置信度，两边仍然要一起改，理由没变。
    """
    from app.agents.diagnosis import DiagnosisAgent

    out = DiagnosisAgent().fallback({
        "suspected_diagnoses": [
            {"name": "功能性出血", "confidence": 60, "icd": "N93.8", "severity": "routine"},
            {"name": "子宫内膜癌", "confidence": 25, "icd": "C54.1", "severity": "critical"},
        ]
    })
    names = [d["name"] for d in out["suspected_diagnoses"]]
    assert names == ["功能性出血", "子宫内膜癌"], f"降级排序应为置信度降序：{names}"
    # 标记照常留着 —— 顺序不再承载后果，那它就全压在这个标记上了
    by = {d["name"]: d["severity"] for d in out["suspected_diagnoses"]}
    assert by["子宫内膜癌"] == "critical"


def test_degraded_unknown_severity_falls_to_the_lightest_tier():
    """
    没标 severity 的落到**最轻**档，不是最重。

    与模型路径同一条理由：拿不准就往上标，「不能漏」这个标记会迅速贬值成噪声。
    P001–P008 的种子都没有 severity，若默认成 critical，它们会集体挂上红标。

    **这条用例第一版是空过的** —— 那时它靠「相对顺序」来反推默认档位，而两条
    用例都不带 severity，默认值改成什么顺序都不变。排序改成纯置信度之后
    （2026-09-08），档位与顺序**彻底脱钩**，那种反推法再也不成立了：
    只能直接断言档位本身。
    """
    from app.agents.diagnosis import DiagnosisAgent

    out = DiagnosisAgent().fallback({
        "suspected_diagnoses": [
            {"name": "已标routine", "confidence": 90, "icd": "X", "severity": "routine"},
            # 没标。默认值一旦调重，这一条的 severity 就不是 routine 了
            {"name": "未标severity", "confidence": 40, "icd": "Y"},
        ]
    })
    by = {d["name"]: d["severity"] for d in out["suspected_diagnoses"]}
    assert by["未标severity"] == "routine"
    assert by["已标routine"] == "routine"


def test_degraded_invalid_severity_falls_to_the_lightest_tier():
    """
    档位是**闭集**。模型或手工数据写了个不在集合里的词（"严重"、"high"…），
    要落到最轻档，不是让它靠 `SEVERITY_ORDER.index` 抛异常，
    也不是当成最重 —— 后者等于给任何一个拼写错误发一张插队证。
    """
    from app.agents.diagnosis import DiagnosisAgent

    out = DiagnosisAgent().fallback({
        "suspected_diagnoses": [
            {"name": "正常项", "confidence": 90, "icd": "X", "severity": "routine"},
            {"name": "档位写错", "confidence": 40, "icd": "Y", "severity": "非常严重"},
        ]
    })
    by = {d["name"]: d["severity"] for d in out["suspected_diagnoses"]}
    assert by["档位写错"] == "routine"


# ─────────────────────────────────────────── 多重过敏（2026-09-08）


def test_allergy_view_carries_reactions_when_known():
    """
    过敏原要能带上**反应类型**。

    「青霉素过敏」和「青霉素 → 喉头水肿」是两件事：后者意味着连同类都不能试。
    只给药名，医生无从判断严重程度 —— 而严重程度决定了替代方案能选到哪一档。

    `items` 保持字符串数组不动（候诊列表、看板、移动端都在读它），
    反应放在并行的 `details` 里 —— 改形状会一次波及五处调用点。
    """
    from app.routers.his import allergy_view

    view = allergy_view({
        "allergy_status": "confirmed",
        "allergies": ["青霉素", "头孢菌素类"],
        "allergy_reactions": {"青霉素": "皮疹 · 喉头水肿（曾急诊）"},
    })
    assert view["items"] == ["青霉素", "头孢菌素类"], "items 必须还是纯药名，供老调用点使用"
    assert view["details"][0] == {"name": "青霉素", "reaction": "皮疹 · 喉头水肿（曾急诊）"}
    assert view["details"][1] == {"name": "头孢菌素类", "reaction": ""}, "没记反应的给空串，不要丢掉这一条"


def test_allergy_view_still_works_for_plain_strings():
    """老数据全是字符串数组，不能因为加了 details 就读不出来。"""
    from app.routers.his import allergy_view

    view = allergy_view({"allergy_status": "confirmed", "allergies": ["青霉素"]})
    assert view["items"] == ["青霉素"]
    assert view["details"] == [{"name": "青霉素", "reaction": ""}]


def test_a_patient_with_many_allergies_exists_in_the_seed():
    """
    种子里要有一位**多重过敏**的患者。

    三档规则里「≥3 种只报数」那一档，没有数据就永远走不到 ——
    做出来的分支等于没做。与科室看板的「待报告」是同一个道理：
    库里 21 项检查全是「已完成」时，那一档一条数据都没有。
    """
    import json
    from pathlib import Path

    rows = json.loads(
        (Path(__file__).resolve().parents[3] / "references/ui-demo/extracted/fixtures/patients.json")
        .read_text(encoding="utf-8")
    )
    many = [r for r in rows if len(r.get("allergies") or []) >= 3]
    assert many, "没有任何一位患者有 3 种以上过敏，那一档分支无法演示也无法验证"
    for r in many:
        # 反应类型放在并行映射里，`allergies` 本身仍是纯字符串数组
        # （改它的形状会一次波及硬规则、上下文、全量视图、看板、移动端五处）
        reactions = r.get("allergy_reactions") or {}
        for name in r["allergies"]:
            assert isinstance(name, str) and name, "过敏原仍应是字符串"
            assert reactions.get(name), f"{r['id']} 的「{name}」没有记反应类型"


# ──────────────────────── 病历去掉「初步诊断」（2026-09-08）


def test_record_has_six_sections_not_seven():
    """
    病历段落从七段变**六段**：去掉「初步诊断」。

    诊断的唯一入口是「诊断管理」—— 在那里勾选、标主诊断、回写，
    并受红线门禁约束。病历里再放一段自由文本的「初步诊断」，
    等于给同一件事开了第二个出口，而那个出口**不受任何门禁**。

    两处并存的代价很具体：模型在病历里写的诊断，与医生在诊断管理里
    勾选的那几条，谁也不保证一致；打印出来的病历以哪一份为准，没人说得清。
    """
    from app.agents.record import RECORD_SECTIONS, SECTION_KEYS

    assert len(RECORD_SECTIONS) == 6
    assert "preliminary_diagnosis" not in SECTION_KEYS
    assert SECTION_KEYS == (
        "chief_complaint", "present_illness", "past_history",
        "personal_history", "physical_exam", "auxiliary_exam",
    )


def test_seed_records_do_not_carry_a_preliminary_diagnosis():
    """种子里也要清掉 —— 留着它，接口照样会把它下发，界面照样有人渲染。"""
    import json
    from pathlib import Path

    data = json.loads(
        (Path(__file__).resolve().parents[3] / "references/ui-demo/extracted/fixtures/record-content.json")
        .read_text(encoding="utf-8")
    )
    for pid, rec in data.items():
        assert "preliminary_diagnosis" not in rec, f"{pid} 的病历里还留着初步诊断"


def test_generated_record_has_no_diagnosis_section(client):
    """生成出来的草稿也不该有这一段。"""
    client.post("/api/emr/analysis/unlock", json={"patient_id": "P001", "reason": "skipped"})
    body = client.post("/api/emr/generate-record-auto", json={"patient_id": "P001"}).json()
    fields = body.get("fields") or body.get("record") or {}
    assert "preliminary_diagnosis" not in fields
