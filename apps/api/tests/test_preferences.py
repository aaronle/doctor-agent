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


# ---------------------------------------------------------------- 分离态的位置


def test_separated_positions_are_storable(client):
    """
    分离态必须连**位置**一起记，不能只记尺寸。

    `useDockedWindows` 在 `merged=false` 时用 `pos` 定位；只恢复 `merged` 而不
    恢复位置，两个窗会一起被拍到 (0,0) 的左上角 —— 那比不恢复更糟。
    规格 §4.2 也把「位置」列进了要记住的东西。
    """
    actor = "位医生"
    r = client.put(
        "/api/preferences",
        json={
            "actor": actor,
            "prefs": {
                "windows": {
                    "merged": False,
                    "panel_left": 900, "panel_top": 60,
                    "drawer_left": 200, "drawer_top": 60,
                }
            },
        },
    )
    assert r.status_code == 200, r.json()

    windows = client.get("/api/preferences", params={"actor": actor}).json()["prefs"]["windows"]
    assert windows["merged"] is False
    assert windows["panel_left"] == 900
    assert windows["drawer_top"] == 60


def test_position_may_be_negative_but_not_off_into_the_void(client):
    """
    `left` 允许为负 —— `clampTitleBar` 本来就允许窗体左半部分出屏，
    只要标题栏还抓得住。但也不能是任意数：存进去的值下次会被当成初始位置。
    """
    ok = client.put(
        "/api/preferences", json={"actor": "负医生", "prefs": {"windows": {"panel_left": -400}}}
    )
    assert ok.status_code == 200

    absurd = client.put(
        "/api/preferences", json={"actor": "负医生", "prefs": {"windows": {"panel_left": -99999}}}
    )
    assert absurd.status_code == 400


def test_top_is_never_negative(client):
    """
    `top` 为负意味着标题栏在屏幕上方 —— 那个窗再也抓不回来了。
    `clampTitleBar` 前端钳的就是这一条，后端要一致。
    """
    r = client.put(
        "/api/preferences", json={"actor": "顶医生", "prefs": {"windows": {"panel_top": -1}}}
    )
    assert r.status_code == 400


def test_all_window_keys_fit_under_the_cap(client):
    """
    加了四个位置键之后，**一份完整的浮窗布局仍要能一次写进去**。
    上限是防滥用的，不该把正常用法卡住 —— 这条测试就是那个对账。
    """
    from app.preferences import MAX_WINDOW_KEYS

    full = {
        "merged": False,
        "panel_width": 320, "panel_height": 700,
        "drawer_width": 900, "drawer_height": 700,
        "panel_left": 1000, "panel_top": 50,
        "drawer_left": 100, "drawer_top": 50,
    }
    assert len(full) <= MAX_WINDOW_KEYS
    r = client.put("/api/preferences", json={"actor": "全医生", "prefs": {"windows": full}})
    assert r.status_code == 200, r.json()


def test_top_edge_offset_is_storable(client):
    """
    上边线拖出来的那段外边距也要能存。

    不存的话医生把窗从上方收短、刷新一下又顶回去 —— 而另外三条边都记住了，
    **只有一条边不记比全都不记更像坏了**。
    """
    actor = "顶边医生"
    r = client.put(
        "/api/preferences",
        json={"actor": actor, "prefs": {"windows": {"panel_offset_top": 120, "drawer_offset_top": 80}}},
    )
    assert r.status_code == 200, r.json()

    windows = client.get("/api/preferences", params={"actor": actor}).json()["prefs"]["windows"]
    assert windows["panel_offset_top"] == 120


def test_offset_cannot_be_negative(client):
    """负的外边距等于把窗顶到默认位置上方 —— 前端 onTopMove 钳的就是这一条。"""
    r = client.put(
        "/api/preferences", json={"actor": "顶边医生", "prefs": {"windows": {"panel_offset_top": -1}}}
    )
    assert r.status_code == 400


def test_a_full_layout_still_fits_under_the_cap(client):
    """
    加了位置与顶边偏移之后，**一份完整的浮窗布局仍要能一次写进去**。

    键数上限是防滥用的（docs/19 P0-4），不该把正常用法卡住 ——
    这条测试就是那个对账。它红了说明该抬上限，而不是该删字段。
    """
    from app.preferences import MAX_WINDOW_KEYS

    full = {
        "merged": False,
        "panel_width": 320, "panel_height": 700,
        "drawer_width": 900, "drawer_height": 700,
        "panel_left": 1000, "panel_top": 50,
        "drawer_left": 100, "drawer_top": 50,
        "panel_offset_top": 40, "drawer_offset_top": 40,
    }
    assert len(full) <= MAX_WINDOW_KEYS, f"完整布局 {len(full)} 项，上限只有 {MAX_WINDOW_KEYS}"
    r = client.put("/api/preferences", json={"actor": "整套医生", "prefs": {"windows": full}})
    assert r.status_code == 200, r.json()


# -------------------------------------------------------------- 有没有这一行


def test_get_says_whether_a_row_exists(client):
    """
    GET 仍然返回一份**完整**偏好（合并过默认值），但要额外说清
    **库里到底有没有这一行**。

    少了这个标志，前端分不清「医生就是要默认」和「这行根本没写过」——
    而它必须分清：本地有设置、后端没有记录时，正确做法是把本地那份推上去，
    而不是拿后端的默认值把本地冲掉。

    这不是假想。旧字号 key 的迁移（规格 §4.1）**每个老用户都会撞上**：
    迁移把旧值读进本地，紧接着 load() 就用后端的默认值把它抹了。
    """
    fresh = client.get("/api/preferences", params={"actor": "新医生"}).json()
    assert fresh["stored"] is False
    # 完整性这条契约不变
    assert fresh["prefs"]["theme"] == "default"
    assert set(fresh["prefs"]) >= {"theme", "font_level", "follow_up", "remember_windows", "windows"}

    client.put("/api/preferences", json={"actor": "新医生", "prefs": {"theme": "eyecare"}})
    after = client.get("/api/preferences", params={"actor": "新医生"}).json()
    assert after["stored"] is True


def test_reset_makes_the_row_absent_again(client):
    """恢复默认是删行，所以 `stored` 要跟着回到 False —— 否则下次登录别的设备，
    前端会以为「这个医生显式选择了全部默认」，从而不再把本地那份推上去。"""
    client.put("/api/preferences", json={"actor": "复位医生", "prefs": {"theme": "contrast"}})
    assert client.get("/api/preferences", params={"actor": "复位医生"}).json()["stored"] is True

    client.delete("/api/preferences", params={"actor": "复位医生"})
    assert client.get("/api/preferences", params={"actor": "复位医生"}).json()["stored"] is False


# ────────────────────────── AI 助手开机自动显示（2026-09-08）


def test_assistant_autostart_defaults_to_off(client):
    """
    **默认不自动展开。**

    这与 2026-09-02 定的「一进来只有医生智能体」是同一条：
    病历、鉴别诊断、风险、共病都由这一场问诊推导，问诊前先把结论摆出来，
    会让医生把「模型基于旧资料的猜测」当成本次判断。

    但那是**默认**，不该是强制 —— 复诊、跟台、只想快速扫一眼的场景确实存在，
    所以给一个开关，而不是把行为写死。
    """
    body = client.get("/api/preferences/options").json()
    assert body["defaults"]["assistant_autostart"] is False
    assert "assistant_autostart" in body["defaults"]


def test_assistant_autostart_round_trips(client):
    """开了要存得住，读回来还是开着。"""
    client.put("/api/preferences", json={"actor": "张医生", "prefs": {"assistant_autostart": True}})
    got = client.get("/api/preferences?actor=张医生").json()
    assert got["prefs"]["assistant_autostart"] is True
    assert got["stored"] is True


def test_assistant_autostart_rejects_non_boolean(client):
    """
    服务端自己校验。界面上是个开关，但接口能被绕过 ——
    存进一个字符串 'true'，前端 `v-if` 会当成真，而「关掉」就再也关不掉了。
    """
    bad = client.put("/api/preferences", json={"actor": "张医生", "prefs": {"assistant_autostart": "true"}})
    assert bad.status_code == 400


def test_follow_up_off_is_the_only_way_to_kill_the_hint_float(client):
    """
    追问提示的「彻底关闭」只有配置这一条路。

    浮框上的 ✕ 2026-09-08 撤掉了 —— 关掉之后没有任何地方能把它叫回来
    （它不像 AI 助手有个把手），医生随手一点就再也看不到追问建议，
    而他多半以为只是「收起来了」。

    所以 `follow_up: 'off'` 必须仍然是合法取值，且**改回 auto 时能恢复**。
    """
    options = client.get("/api/preferences/options").json()
    assert "off" in options["follow_up_modes"], "关掉的入口没了，配置里这一档就不能再少"

    client.put("/api/preferences", json={"actor": "张医生", "prefs": {"follow_up": "off"}})
    assert client.get("/api/preferences?actor=张医生").json()["prefs"]["follow_up"] == "off"

    client.put("/api/preferences", json={"actor": "张医生", "prefs": {"follow_up": "auto"}})
    assert client.get("/api/preferences?actor=张医生").json()["prefs"]["follow_up"] == "auto"
