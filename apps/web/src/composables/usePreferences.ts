import { computed, ref } from 'vue'

import { setFontLevel } from './useFontScale'
import {
  fetchPreferenceOptions,
  fetchPreferences,
  resetPreferences,
  savePreferences,
  type PreferenceOptions,
  type Preferences,
} from '../api'

/**
 * 医生个人配置。
 *
 * ## 为什么双写
 *
 * localStorage 管**瞬时生效**：只读后端的话，每次开页要等一轮请求才能应用偏好，
 * 医生会看到默认样式闪一下。后端管**跨设备同步**：只存 localStorage 的话，
 * 换浏览器换电脑就没了。
 *
 * 顺序是：先读 localStorage 上屏 → 再拉后端 → 不一致以后端为准并回写 localStorage。
 *
 * ## 后端不可达时不算失败
 *
 * 配置页在任何情况下都要能打开、能改、本机生效。同步失败只提示一句，
 * 不回滚本地值 —— 医生刚把字号调大就被弹回去，比不同步糟糕得多。
 *
 * ## 枚举不在这里硬编码
 *
 * `options` 从 `/api/preferences/options` 拉。后端加了一档主题、前端没跟着改，
 * 界面上就永远少一个选项，且没有任何测试会失败。
 *
 * 规格见 docs/product/20-个人配置需求规格说明书.md。
 */

const STORAGE_KEY = 'doctor-agent:preferences'

/** 旧的字号 key。迁移后不再写入，但**不要删** —— 回滚到旧版本时它还得读。 */
const LEGACY_FONT_KEY = 'doctor-agent:font-level'

/**
 * 前端兜底默认值。
 *
 * 与 `apps/api/app/preferences.py` 的 `DEFAULTS` 保持一致，但**那边才是事实源** ——
 * 这份只在后端拉不到时用，拉到之后一律以 `options.defaults` 为准。
 */
export const FALLBACK_DEFAULTS: Preferences = {
  version: 1,
  theme: 'default',
  font_level: 'normal',
  follow_up: 'auto',
  remember_windows: true,
  assistant_autostart: false,
  windows: {},
}

/** 主题在界面上的中文名与用途。取值集合仍以后端下发的 `themes` 为准。 */
export const THEME_LABELS: Record<string, { name: string; desc: string }> = {
  default: { name: '默认蓝', desc: '与 V4.3 一致' },
  eyecare: { name: '护眼', desc: '长时间门诊' },
  contrast: { name: '高对比', desc: '强光诊室' },
}

/**
 * 配置页上三个色板要显示的实际颜色。
 *
 * **刻意放在 JS 里而不是 CSS 里。** `build-themes.mjs` 会扫描 CSS 把品牌色替换成
 * `var(--t-xxx, #原值)`，而色板要展示的是**各主题各自的颜色**，不能跟着当前主题变 ——
 * 换成护眼之后三个色板全变成护眼色，就没法选了。放 JS 里脚本扫不到，天然免疫。
 *
 * 取值来自 `scripts/build-themes.mjs` 的变换函数，改那边要同步改这里。
 */
export const THEME_SWATCHES: Record<string, [string, string, string]> = {
  default: ['#1677ff', '#3b6ef5', '#eaf1ff'],
  eyecare: ['#30a6e5', '#4f99e1', '#e7f3fc'],
  contrast: ['#056dff', '#1f5cff', '#e3ecff'],
}

export const FONT_LABELS: Record<string, string> = {
  small: '小',
  normal: '标准',
  large: '大',
  xlarge: '特大',
}

export const FOLLOW_UP_LABELS: Record<string, { name: string; desc: string }> = {
  auto: { name: '自动', desc: '满 3 条消息后自动浮出' },
  always: { name: '始终显示', desc: '进入工作站即显示' },
  manual: { name: '手动唤出', desc: '默认关闭，点按钮才出；照常计算' },
  // manual 与 off 的区别在最后半句：off 是真的省一次调用，不是只把结果藏起来
  off: { name: '完全关闭', desc: '不出现，且不发起模型调用' },
}

/** 模块级单例：整个应用共用同一份偏好，各存一份必然会漂 */
const prefs = ref<Preferences>({ ...FALLBACK_DEFAULTS })
/**
 * 当前医生名。**必须是模块级的，和 `prefs` 一样。**
 *
 * 曾经建在 `usePreferences()` 里面，于是每个调用点各拿一份：`App.vue` 那份
 * `load('张医生')` 之后知道医生是谁，浮窗组件那份是空串 —— 浮窗自动写回的
 * 布局因此落到服务端的 `demo-doctor` 名下，换台电脑登录同一个医生名读不回来。
 *
 * 本地 localStorage 照常生效，所以表面上完全看不出问题。
 * 是在真浏览器里查「后端为什么没记住」时才发现的，单测全绿。
 */
const actorRef = ref('')
const options = ref<PreferenceOptions | null>(null)
const syncError = ref('')
const loaded = ref(false)

function readLocal(): Partial<Preferences> | null {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Preferences>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    // 隐私模式会抛；存的内容也可能被人手改坏。偏好不是关键功能，回落默认即可
    return null
  }
}

function writeLocal(value: Preferences) {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // 存不了就算了，本次会话内仍然生效
  }
}

/**
 * 迁移旧的字号 key。
 *
 * 只在**新模型里没有显式设过字号**时才采纳旧值 —— 否则会把医生在新配置页
 * 刚改的字号覆盖回去。
 */
function migrateLegacyFont(current: Partial<Preferences>): Partial<Preferences> {
  if (current.font_level) return current
  try {
    const legacy = window.localStorage?.getItem(LEGACY_FONT_KEY)
    if (legacy && legacy in FONT_LABELS) return { ...current, font_level: legacy }
  } catch {
    // 同上
  }
  return current
}

/**
 * 把主题写到根元素上。
 *
 * 默认主题**不打标记**：`build-themes.mjs` 生成的 CSS 里，默认态是靠
 * `var(--t-xxx, #原值)` 的回退值生效的，根本没有对应的变量定义。
 * 打上 `data-theme="default"` 不会有任何作用，反而会让人以为存在一套默认主题变量。
 */
function applyTheme(theme: string) {
  const root = document.documentElement
  if (theme && theme !== 'default') root.setAttribute('data-theme', theme)
  else root.removeAttribute('data-theme')
}

/**
 * 把字号档位写到根元素上，**给移动端用**。
 *
 * 桌面把 `zoom` 内联挂在面板的内容区上（见 `useFontScale` 文件头：外壳要
 * 承载拖拽坐标，不能缩放）。移动端没有那些组件，靠 `mobile.css` 里
 * `html[data-font='x'] .m-body { zoom: … }` 这条规则。
 *
 * **不能图省事挂到 `.m-page` 上**：它是 `position:fixed; inset:0`，
 * 加了 `zoom` 会给 `.m-scrim` / `.m-sheet` 造出新的包含块，
 * 那两个「铺满屏幕」的浮层当场算错大小。
 *
 * 标准档不打标记 —— 和默认主题同一条道理：`zoom:1` 也会凭空造一个包含块。
 */
function applyFontAttr(level: string) {
  const root = document.documentElement
  if (level && level !== 'normal') root.setAttribute('data-font', level)
  else root.removeAttribute('data-font')
}

/**
 * 服务端回来的那份到底是不是一份偏好。
 *
 * **不能无条件 `apply(res.prefs)`。** 响应体一旦不是预期形状（网关返回空体、
 * 代理插了一页 HTML、接口改了字段名），`prefs.value` 会被置成 `undefined` ——
 * 然后所有读偏好的地方一起炸：追问模式、字号、布局记忆，整个浮窗白屏。
 *
 * 一次同步失败的合理后果是「这次没同步上」，不是「界面塌了」。
 * 判据取 `theme` 这一项：它是必有字段，比逐项校验省事，也比 `typeof === object`
 * 严 —— 后者连 `{}` 和数组都会放过去。
 */
function isPreferences(value: unknown): value is Preferences {
  return !!value && typeof value === 'object' && typeof (value as Preferences).theme === 'string'
}

function apply(value: Preferences) {
  prefs.value = value
  writeLocal(value)
  applyTheme(value.theme)
  applyFontAttr(value.font_level)
  // 字号也在这里落地。**它没有第二个事实源** —— 曾经有过：配置页写这份偏好、
  // 浮窗读 `useFontScale` 自己的旧 key，两边各管各的，于是在配置页把字号
  // 调到特大、回工作站一点没变。
  setFontLevel(value.font_level)
}

/**
 * 启动时上屏。**在 `mount()` 之前调**，只读 localStorage，不发任何请求。
 *
 * 少了这一步，偏好就只在配置页那一刻生效：医生调成护眼，回工作站一刷新
 * 又是蓝的，而配置页上还写着「护眼」。**设置存住了但界面没跟上，
 * 比设置根本没存住更难查** —— 前者会让人以为是主题功能坏了。
 *
 * 与 `load()` 的分工：这里管「早一帧生效」，`load()` 管「跨设备同步」。
 * `load()` 第一件事也是读本地，两者重叠且幂等。
 */
export function bootstrapPreferences() {
  const local = migrateLegacyFont(readLocal() ?? {})
  apply({ ...FALLBACK_DEFAULTS, ...local, windows: { ...(local.windows ?? {}) } })
}

export function usePreferences() {
  /**
   * 后端还没有这一行，而本地有设置：把本地那份推上去。
   *
   * 不推的话，这台机器上的设置永远只是本地的 —— 换台电脑登录同一个医生名
   * 依然是默认值，而 AC-PREF-005 承诺的是「换浏览器登录同一医生名，设置仍在」。
   *
   * 两边都是干净的就什么都不做：不为「都是默认」凭空建一行，
   * 那与「恢复默认是删行」是同一条口径。
   */
  async function pushLocalUp(local: Partial<Preferences>) {
    const patch: Partial<Preferences> = {}
    for (const key of ['theme', 'font_level', 'follow_up', 'remember_windows', 'assistant_autostart'] as const) {
      const v = local[key]
      if (v !== undefined && v !== FALLBACK_DEFAULTS[key]) (patch as Record<string, unknown>)[key] = v
    }
    if (local.windows && Object.keys(local.windows).length) patch.windows = local.windows
    if (!Object.keys(patch).length) return
    try {
      await savePreferences(actorRef.value, patch)
    } catch {
      // 推不上去不算失败：本地照常生效，下次进来还会再试一遍
    }
  }

  /**
   * 进入页面时调用。
   *
   * 先用本地值上屏（同步、无网络），再去拉后端。**本地那步不能省** ——
   * 省了就会先渲染一遍默认样式再跳成医生的偏好，也就是闪屏。
   */
  async function load(actor: string) {
    actorRef.value = actor
    const local = migrateLegacyFont(readLocal() ?? {})
    apply({ ...FALLBACK_DEFAULTS, ...local, windows: { ...(local.windows ?? {}) } })

    try {
      const [opt, remote] = await Promise.all([
        fetchPreferenceOptions(),
        fetchPreferences(actor),
      ])
      options.value = opt
      // 后端为准 —— 两个前提：它确实回了一份偏好（见 `isPreferences`），
      // 且**库里真有这一行**（`stored`）。
      //
      // 少了后一个判断，「后端为准」在后端从没写过时会反过来伤人：服务端对
      // 没有记录的医生也返回一份完整默认值，照单全收就是把本地设置清零。
      // 每个老用户都会撞上 —— 旧字号 key 的迁移刚把值读进本地，
      // 这一步就把它抹了，规格 §4.1 承诺的迁移等于没做。
      if (isPreferences(remote?.prefs)) {
        if (remote.stored === false) await pushLocalUp(local)
        else apply(remote.prefs)
      }
      syncError.value = ''
    } catch (error) {
      syncError.value = error instanceof Error ? error.message : String(error)
    } finally {
      loaded.value = true
    }
  }

  /**
   * 改一项。
   *
   * 本地立即生效，再异步同步。失败**不回滚本地值**，只挂一条提示 ——
   * 见文件头「后端不可达时不算失败」。
   */
  async function update(patch: Partial<Preferences>) {
    const before = prefs.value
    const merged: Preferences = {
      ...before,
      ...patch,
      // `windows` **整份替换**，与后端同一口径（见 routers/preferences.py 的注释）：
      // 它是一份快照而不是补丁，逐项合并会让「刻意不写」的旧键一次次复活，
      // 也会让配置页那颗「清除布局记忆」变成空转。
      windows: patch.windows ?? before.windows,
    }
    apply(merged)

    try {
      const saved = await savePreferences(actorRef.value, patch)
      // 同上：回来的不是一份偏好就保留刚才那份合并结果 ——
      // 改动已经在本机生效了，没同步上不该反过来把界面拆了
      if (isPreferences(saved?.prefs)) apply(saved.prefs)
      syncError.value = ''
      return true
    } catch (error) {
      // 400 是取值非法，这时本地那份也是错的，回滚回改前
      const status = (error as { status?: number }).status
      if (status === 400) {
        apply(before)
        syncError.value = error instanceof Error ? error.message : String(error)
        return false
      }
      syncError.value = '未能同步到服务器，本机设置仍有效'
      return true
    }
  }

  /** 恢复全部默认。后端删行，本地也清掉。 */
  async function resetAll() {
    try {
      const result = await resetPreferences(actorRef.value)
      apply(result.prefs)
      syncError.value = ''
    } catch {
      apply({ ...FALLBACK_DEFAULTS, windows: {} })
      syncError.value = '未能同步到服务器，本机已恢复默认'
    }
  }

  /** 只清浮窗布局记忆，不动其他偏好。 */
  const resetWindows = () => update({ windows: {} })

  const themes = computed(() => options.value?.themes ?? Object.keys(THEME_LABELS))
  const fontLevels = computed(() => options.value?.font_levels ?? Object.keys(FONT_LABELS))
  const followUpModes = computed(
    () => options.value?.follow_up_modes ?? Object.keys(FOLLOW_UP_LABELS),
  )

  /** 已记住的浮窗几何，给配置页显示成一行人话。没记住时返回空串。 */
  const windowSummary = computed(() => {
    const w = prefs.value.windows ?? {}
    const parts: string[] = []
    if (w.panel_width || w.panel_height) parts.push(`面板 ${w.panel_width ?? '—'}×${w.panel_height ?? '—'}`)
    if (w.drawer_width || w.drawer_height) parts.push(`抽屉 ${w.drawer_width ?? '—'}×${w.drawer_height ?? '—'}`)
    if (typeof w.merged === 'boolean') parts.push(w.merged ? '合并停靠' : '分离')
    if (w.split_ratio) parts.push(`分栏 ${w.split_ratio}%`)
    return parts.join(' · ')
  })

  return {
    prefs,
    options,
    loaded,
    syncError,
    themes,
    fontLevels,
    followUpModes,
    windowSummary,
    load,
    update,
    resetAll,
    resetWindows,
  }
}

/** 供非组件代码读取当前偏好（例如浮窗组件决定要不要恢复几何）。 */
export function currentPreferences(): Preferences {
  return prefs.value
}
