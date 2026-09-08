"""
个人配置的取值定义、默认值与校验。

**这个文件是偏好模型的唯一事实源。** 前端的 `usePreferences`、配置页的控件、
规格文档 `docs/product/20-个人配置需求规格说明书.md` 的取值表，都以这里为准。
新增一项偏好必须先改这里，否则 `validate_prefs` 会把它当未知项拒掉。

**只存差异，不存全量。** 库里保存的是「与默认值不同的项」，读取时才与 `DEFAULTS`
合并。这样以后调整默认值（比如把 `follow_up` 从 auto 改成 manual），所有没有
显式设过该项的医生会跟着变，而显式设过的人不受影响 —— 存全量做不到这件事。
"""

from __future__ import annotations

from copy import deepcopy

#: 偏好模型版本。破坏性改动（删项、改语义、改取值集合）时 +1，
#: 读取端按版本决定要不要丢弃旧值。加项不需要动它 —— 合并默认值即可。
PREFERENCE_VERSION = 1

#: 主题预设。**`default` 的每一个色值都严格等于 V4.3 原件**，
#: 这样还原度门禁（`npm run fidelity` 逐元素比对计算样式）只跑默认主题
#: 仍然零差异，不必为主题功能给门禁加一个维度。
#: 深色主题不在一期：它要额外处理阴影、边框、状态色与图片底色，
#: 且必须等 scoped CSS 里的硬编码十六进制全部收敛完才可能做对。
THEMES = ("default", "eyecare", "contrast")

#: 字号档位。与前端 `useFontScale.ts` 的 zoom 0.9/1/1.15/1.3 一一对应，改这里必须同步改那边。
#: `useFontScale` 现在**只应用不写盘**，持久化归这套偏好一家管 —— 曾经两边各写各的 key，
#: 结果是在配置页把字号调到特大、回工作站一点没变。
FONT_LEVELS = ("small", "normal", "large", "xlarge")

#: AI 智能追问的初始状态。
#:   auto   —— 现状：满 AUTO_OPEN_AFTER_MESSAGES 条后自动浮出
#:   always —— 进入工作站即显示
#:   manual —— 默认关闭，医生点按钮才唤出（照常计算）
#:   off    —— 完全不出，且**不发起模型调用**（manual 与 off 的区别就在这里，
#:             off 是真的省一次调用，不是只藏起来）
FOLLOW_UP_MODES = ("auto", "always", "manual", "off")

#: 浮窗几何的取值范围。上下界抄自前端 useResizable 的实例化参数
#: （AiEmrFloat.vue:195-227），两边必须一致 —— 后端放行了前端也会钳回去，
#: 反而让医生以为设置没生效。
WINDOW_BOUNDS = {
    "panel_width": (260, 560),
    "drawer_width": (640, 1800),
    "panel_height": (320, 2000),
    "drawer_height": (320, 2000),
    "split_ratio": (25, 75),
    #: 分离态下两个窗各自的位置。**只记尺寸不记位置是不行的** ——
    #: `useDockedWindows` 在 merged=false 时完全按 pos 定位，恢复了分离态却
    #: 没有位置，两个窗会一起被拍到屏幕左上角。
    #:
    #: `left` 允许为负：前端 `clampTitleBar` 本来就允许窗体左半部分出屏，
    #: 只要标题栏还抓得住。`top` **不允许为负** —— 标题栏跑到屏幕上方之后
    #: 那个窗再也抓不回来了，这正是 clampTitleBar 钳的那一条。
    #: 上界给得比常见分辨率宽松（超宽屏、多显示器），但不是任意值：
    #: 存进去的数下次会被当成初始位置用。
    "panel_left": (-2000, 8000),
    "drawer_left": (-2000, 8000),
    "panel_top": (0, 4000),
    "drawer_top": (0, 4000),
    #: 拖**上边线**让出的那段外边距（前端 useResizable 的 `offset`）。
    #: 上边线拖动时顶边下移、高度变矮，底边留在原地 —— 这个数就是顶边下移了多少。
    #: 不能为负：负的等于把窗顶到默认位置上方，前端 `onTopMove` 钳的就是这一条。
    "panel_offset_top": (0, 2000),
    "drawer_offset_top": (0, 2000),
}

DEFAULTS: dict = {
    "version": PREFERENCE_VERSION,
    "theme": "default",
    "font_level": "normal",
    "follow_up": "auto",
    #: 关掉时每次进工作站都回到默认布局。默认开 —— 医生每天重复调一遍窗口
    #: 是现在最磨人的一项（拖完刷新即丢，见 useDockedWindows 的纯内存实现）
    "remember_windows": True,
    #: AI 助手（那八个标签页）一进工作站要不要自动展开。
    #:
    #: **默认关**，与 2026-09-02 定的「一进来只有医生智能体」一致：
    #: 病历、鉴别诊断、风险、共病都由这一场问诊推导，问诊前先把结论摆出来，
    #: 会让医生把「模型基于旧资料的猜测」当成本次判断。
    #:
    #: 但那是默认不是强制 —— 复诊、跟台、只想快速扫一眼的场景确实存在，
    #: 所以给一个开关，而不是把行为写死。
    "assistant_autostart": False,
    #: 记忆下来的几何值。**由前端在医生拖拽后自动写入，不是配置页上手填的**；
    #: 配置页只提供「恢复默认布局」把它清空。`merged` 是合并/分离态。
    "windows": {},
}

#: 枚举型偏好项的允许取值。校验风格对齐 admin.py 的 PARAM_BOUNDS：
#: 白名单 + 中文报错，且**服务端必须自己校验** —— 界面上也会限，但界面能绕过
_ENUMS = {
    "theme": THEMES,
    "font_level": FONT_LEVELS,
    "follow_up": FOLLOW_UP_MODES,
}

_BOOLS = ("remember_windows", "assistant_autostart")


class PreferenceError(ValueError):
    """校验失败。路由层转成 HTTPException(400)，消息直接给医生看。"""


#: 单次请求允许的键数上限。
#:
#: 白名单本身已经挡住了未知键，这层是**防滥用**：这条路径在公网上无鉴权，
#: 而 `prefs` 是自由 dict，Nginx 的 client_max_body_size 1MB 是唯一上限 ——
#: 不设上限的话，一个 curl 就能把 1MB 垃圾塞进库里，且每个伪造的 actor 一行。
#: 见 docs/19-系统审计报告.md 的 P0-4。
MAX_PREF_KEYS = 16
#: 上限是**防滥用**，不是「布局最多这么复杂」。一份完整布局现在要 11 项
#: （4 尺寸 + 4 位置 + 2 顶边偏移 + merged），12 只剩一格富余 ——
#: 下次加一个字段就会把正常用法卡住，而报出来的错是「windows 最多 12 项」，
#: 看起来像医生做错了什么。`test_a_full_layout_still_fits_under_the_cap` 守着这个对账。
MAX_WINDOW_KEYS = 16


def _validate_windows(windows: dict) -> None:
    if not isinstance(windows, dict):
        raise PreferenceError("windows 必须是对象")
    if len(windows) > MAX_WINDOW_KEYS:
        raise PreferenceError(f"windows 最多 {MAX_WINDOW_KEYS} 项")
    for key, value in windows.items():
        if key == "merged":
            if not isinstance(value, bool):
                raise PreferenceError("windows.merged 必须是布尔值")
            continue
        if key not in WINDOW_BOUNDS:
            raise PreferenceError(f"不支持的窗口参数：{key}")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise PreferenceError(f"windows.{key} 必须是数字")
        low, high = WINDOW_BOUNDS[key]
        if not low <= value <= high:
            raise PreferenceError(f"windows.{key} 超出允许范围 {low}–{high}")


def validate_prefs(prefs: dict) -> None:
    """
    校验一份**部分**偏好（PATCH 语义，缺的项表示不改）。

    未知项一律拒绝而不是静默丢弃：`fontLevel` 这种拼写错误必须 422 报出来，
    否则医生改了没生效还找不到原因 —— 与 schemas.StrictIn 的 extra=forbid 同一个理由。
    """
    if not isinstance(prefs, dict):
        raise PreferenceError("偏好必须是对象")
    if len(prefs) > MAX_PREF_KEYS:
        raise PreferenceError(f"偏好项最多 {MAX_PREF_KEYS} 个")
    for key, value in prefs.items():
        if key == "version":
            continue  # 由服务端写，前端传了也忽略
        if key in _ENUMS:
            if value not in _ENUMS[key]:
                allowed = " / ".join(_ENUMS[key])
                raise PreferenceError(f"{key} 只能是 {allowed}")
        elif key in _BOOLS:
            if not isinstance(value, bool):
                raise PreferenceError(f"{key} 必须是布尔值")
        elif key == "windows":
            _validate_windows(value)
        else:
            raise PreferenceError(f"不支持的偏好项：{key}")


def merge(stored: dict | None) -> dict:
    """把库里存的差异合并到默认值上，得到一份完整偏好。"""
    result = deepcopy(DEFAULTS)
    if not stored:
        return result
    # 版本不认识就整份丢弃回默认，不去猜旧结构该怎么映射
    if stored.get("version") not in (None, PREFERENCE_VERSION):
        return result
    for key, value in stored.items():
        if key == "windows" and isinstance(value, dict):
            result["windows"] = {**result["windows"], **value}
        elif key in result and key != "version":
            result[key] = value
    return result


def strip_defaults(prefs: dict) -> dict:
    """反过来：只留与默认值不同的项，用于落库。"""
    diff: dict = {}
    for key, value in prefs.items():
        if key == "version":
            continue
        if key == "windows":
            if value:
                diff["windows"] = value
        elif DEFAULTS.get(key) != value:
            diff[key] = value
    if diff:
        diff["version"] = PREFERENCE_VERSION
    return diff
