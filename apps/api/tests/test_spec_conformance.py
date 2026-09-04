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
    """F03：病历七段是**闭集**。

    服务端按段切分流式下发，多一段前端无从对齐 —— 那一段会静默丢失。
    """
    from app.agents.record import SECTION_KEYS

    assert SECTION_KEYS == (
        "chief_complaint", "present_illness", "past_history", "personal_history",
        "physical_exam", "auxiliary_exam", "preliminary_diagnosis",
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
