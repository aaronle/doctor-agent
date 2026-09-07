"""
个人配置：主题、字号、AI 追问初始状态、浮窗布局记忆。

这里守三件事：**取值白名单挡得住 curl**（界面能绕过）、**只存差异**
（这样改默认值能惠及没显式设过的人）、**默认主题不动 V4.3 的色值**
（还原度门禁只跑默认主题，动了它门禁会全红而且是对的）。
"""

from app.preferences import DEFAULTS, PREFERENCE_VERSION, merge, strip_defaults


# ------------------------------------------------------------------ 取值与默认


def test_options_are_served_not_hardcoded_in_frontend(client):
    """
    枚举由后端下发。

    前端自己硬编码这几档的话，后端加一档主题、前端没跟着改，
    界面上就永远少一个选项，**且没有任何测试会失败** —— 那种缺陷只能靠人眼发现。
    """
    body = client.get("/api/preferences/options").json()
    assert body["themes"] == ["default", "eyecare", "contrast"]
    assert body["font_levels"] == ["small", "normal", "large", "xlarge"]
    assert body["follow_up_modes"] == ["auto", "always", "manual", "off"]
    assert body["defaults"]["theme"] == "default"


def test_default_theme_is_the_v43_baseline():
    """
    默认主题必须叫 `default` 且是 DEFAULTS 里的值。

    还原度门禁逐元素比对 V4.3 的计算样式，它跑的是默认主题。
    哪天有人把默认改成护眼绿，门禁会全红 —— 这条测试先一步告诉他为什么。
    """
    assert DEFAULTS["theme"] == "default"


def test_never_set_reads_back_full_defaults(client):
    """没设过也要拿到一份**完整**偏好，前端不必区分「没设过」和「设成了默认值」。"""
    body = client.get("/api/preferences", params={"actor": "从未设置过的医生"}).json()
    assert body["prefs"] == DEFAULTS
    assert body["prefs"]["version"] == PREFERENCE_VERSION


# ------------------------------------------------------------------ 写入与合并


def test_partial_update_leaves_other_items_alone(client):
    """PATCH 语义：只传要改的项，没传的不许被默认值冲掉。"""
    actor = "李医生"
    client.put("/api/preferences", json={"actor": actor, "prefs": {"theme": "eyecare"}})
    client.put("/api/preferences", json={"actor": actor, "prefs": {"font_level": "large"}})

    prefs = client.get("/api/preferences", params={"actor": actor}).json()["prefs"]
    assert prefs["theme"] == "eyecare"
    assert prefs["font_level"] == "large"


def test_only_the_diff_is_stored(client):
    """
    设成默认值等于没设。

    存全量的话，以后把 follow_up 的默认从 auto 改成 manual，
    所有存过全量的医生都会被钉死在 auto —— 而他们从没表达过这个偏好。
    """
    assert strip_defaults({**DEFAULTS, "theme": "contrast"}) == {
        "theme": "contrast",
        "version": PREFERENCE_VERSION,
    }
    assert strip_defaults(dict(DEFAULTS)) == {}


def test_windows_merge_instead_of_replace(client):
    """浮窗几何是逐项累积的，改宽度不该把记住的高度抹掉。"""
    actor = "王医生"
    client.put("/api/preferences", json={"actor": actor, "prefs": {"windows": {"panel_width": 320}}})
    client.put("/api/preferences", json={"actor": actor, "prefs": {"windows": {"panel_height": 600}}})

    windows = client.get("/api/preferences", params={"actor": actor}).json()["prefs"]["windows"]
    assert windows == {"panel_width": 320, "panel_height": 600}


def test_reset_deletes_the_row_rather_than_writing_defaults(client):
    """
    恢复默认要删行。

    写一份「等于当前默认值」的记录，会让这个人以后不再跟随默认值变化 ——
    和 test_only_the_diff_is_stored 是同一个道理。
    """
    actor = "赵医生"
    client.put("/api/preferences", json={"actor": actor, "prefs": {"theme": "contrast"}})
    assert client.delete("/api/preferences", params={"actor": actor}).json()["prefs"] == DEFAULTS
    assert client.get("/api/preferences", params={"actor": actor}).json()["prefs"] == DEFAULTS


# ------------------------------------------------------------------ 服务端校验


def test_unknown_preference_key_is_rejected_not_dropped(client):
    """
    拼错的项必须报错。

    静默丢弃的话，医生改了没生效、界面也不报错，只能怀疑是自己记错了。
    """
    r = client.put("/api/preferences", json={"actor": "钱医生", "prefs": {"fontLevel": "large"}})
    assert r.status_code == 400
    assert "fontLevel" in r.json()["detail"]


def test_enum_values_are_checked_server_side(client):
    """界面上也会限，但**界面能绕过** —— 一个 curl 就能把主题设成任意字符串。"""
    r = client.put("/api/preferences", json={"actor": "孙医生", "prefs": {"theme": "赛博朋克"}})
    assert r.status_code == 400
    r = client.put("/api/preferences", json={"actor": "孙医生", "prefs": {"follow_up": "sometimes"}})
    assert r.status_code == 400


def test_window_bounds_match_the_frontend_clamps(client):
    """
    上下界要和前端 useResizable 的钳位一致。

    后端放行了前端也会钳回去，医生会以为设置没生效 —— 比直接报错更难查。
    """
    ok = client.put("/api/preferences", json={"actor": "周医生", "prefs": {"windows": {"panel_width": 560}}})
    assert ok.status_code == 200
    too_wide = client.put(
        "/api/preferences", json={"actor": "周医生", "prefs": {"windows": {"panel_width": 561}}}
    )
    assert too_wide.status_code == 400
    assert "260" in too_wide.json()["detail"]


def test_unknown_window_param_is_rejected(client):
    r = client.put("/api/preferences", json={"actor": "吴医生", "prefs": {"windows": {"opacity": 0.5}}})
    assert r.status_code == 400


def test_extra_top_level_fields_are_forbidden(client):
    """StrictIn 的 extra=forbid 在这条路径上也生效。"""
    r = client.put("/api/preferences", json={"actor": "郑医生", "prefs": {}, "role": "admin"})
    assert r.status_code == 422


# ------------------------------------------------------------------ 身份与审计


def test_blank_actor_falls_back_to_demo_identity_not_an_error(client):
    """配置页在任何情况下都要能打开，拿不到医生名时读写演示身份那一行。"""
    r = client.get("/api/preferences", params={"actor": "  "})
    assert r.status_code == 200
    assert r.json()["actor"] == "demo-doctor"


def test_preferences_are_isolated_between_actors(client):
    """一行一人。注意这**不是访问控制** —— actor 可伪造，见模型 docstring。"""
    client.put("/api/preferences", json={"actor": "甲医生", "prefs": {"theme": "eyecare"}})
    client.put("/api/preferences", json={"actor": "乙医生", "prefs": {"theme": "contrast"}})
    assert client.get("/api/preferences", params={"actor": "甲医生"}).json()["prefs"]["theme"] == "eyecare"
    assert client.get("/api/preferences", params={"actor": "乙医生"}).json()["prefs"]["theme"] == "contrast"


def test_audit_records_which_keys_changed_but_not_their_values(client):
    """审计只记改了哪些项，不记取值全文 —— 对齐审计表「不存正文」的口径。"""
    from app.database import SessionLocal
    from app.models import AuditLog

    client.put("/api/preferences", json={"actor": "丙医生", "prefs": {"theme": "contrast"}})

    session = SessionLocal()
    try:
        row = (
            session.query(AuditLog)
            .filter(AuditLog.action == "update_preferences", AuditLog.entity_id == "丙医生")
            .order_by(AuditLog.id.desc())
            .first()
        )
    finally:
        session.close()

    assert row is not None, "改偏好必须留审计"
    assert row.detail == {"keys": ["theme"]}
    assert "contrast" not in str(row.detail), "审计不该记偏好取值"


# ------------------------------------------------------------------ 版本


def test_unknown_version_falls_back_to_defaults_instead_of_guessing(client):
    """旧结构不去猜怎么映射，整份丢回默认 —— 猜错比重置更难被发现。"""
    assert merge({"version": 999, "theme": "eyecare"}) == DEFAULTS


# ------------------------------------------------------------------ 防滥用


def test_key_count_is_capped(client):
    """
    键数有上限。

    白名单已经挡住了未知键，这层是**防滥用**：这条路径在公网上无鉴权、
    `prefs` 是自由 dict，Nginx 的 1MB 是唯一上限。不设上限的话一个 curl
    就能往库里塞垃圾，且每个伪造的 actor 一行。见 docs/19 的 P0-4。
    """
    from app.preferences import MAX_PREF_KEYS

    fat = {f"k{i}": 1 for i in range(MAX_PREF_KEYS + 1)}
    r = client.put("/api/preferences", json={"actor": "胖医生", "prefs": fat})
    assert r.status_code == 400
    assert str(MAX_PREF_KEYS) in r.json()["detail"]


def test_window_key_count_is_capped(client):
    from app.preferences import MAX_WINDOW_KEYS

    fat = {f"w{i}": 1 for i in range(MAX_WINDOW_KEYS + 1)}
    r = client.put("/api/preferences", json={"actor": "胖医生", "prefs": {"windows": fat}})
    assert r.status_code == 400
