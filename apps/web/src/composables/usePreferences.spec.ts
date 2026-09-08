import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useFontScale } from './useFontScale'
import {
  bootstrapPreferences,
  FALLBACK_DEFAULTS,
  THEME_SWATCHES,
  usePreferences,
} from './usePreferences'

/**
 * 个人配置的双写。
 *
 * 盯的是**这个组合式存在的理由**能不能兑现：
 *   - 本地先上屏，不闪屏；
 *   - 后端不可达不影响本机使用；
 *   - 取值非法要回滚，而不是把错值留在界面上；
 *   - 主题写到根元素，且**默认主题不打标记**。
 */

vi.mock('../api', () => ({
  fetchPreferenceOptions: vi.fn(),
  fetchPreferences: vi.fn(),
  savePreferences: vi.fn(),
  resetPreferences: vi.fn(),
}))

const api = await import('../api')

const OPTIONS = {
  version: 1,
  themes: ['default', 'eyecare', 'contrast'],
  font_levels: ['small', 'normal', 'large', 'xlarge'],
  follow_up_modes: ['auto', 'always', 'manual', 'off'],
  window_bounds: { panel_width: [260, 560] as [number, number] },
  defaults: FALLBACK_DEFAULTS,
}

const remote = (over: Record<string, unknown> = {}) => ({
  actor: '张医生',
  prefs: { ...FALLBACK_DEFAULTS, ...over },
})

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  vi.mocked(api.fetchPreferenceOptions).mockResolvedValue(OPTIONS)
  vi.mocked(api.fetchPreferences).mockResolvedValue(remote())
  vi.mocked(api.savePreferences).mockImplementation(async (_a, patch) => ({
    ok: true,
    actor: '张医生',
    prefs: { ...FALLBACK_DEFAULTS, ...patch, windows: { ...(patch.windows ?? {}) } },
  }))
  vi.mocked(api.resetPreferences).mockResolvedValue({ ok: true, actor: '张医生', prefs: { ...FALLBACK_DEFAULTS } })
})

describe('个人配置 · 上屏顺序', () => {
  it('先用本地值上屏，不必等后端 —— 否则会先渲染一遍默认样式再跳', async () => {
    window.localStorage.setItem(
      'doctor-agent:preferences',
      JSON.stringify({ theme: 'contrast', font_level: 'large' }),
    )
    // 让后端一直不返回，验证本地那步是同步生效的
    vi.mocked(api.fetchPreferences).mockReturnValue(new Promise(() => {}))

    const p = usePreferences()
    p.load('张医生')

    expect(p.prefs.value.theme).toBe('contrast')
    expect(p.prefs.value.font_level).toBe('large')
  })

  it('后端为准：本地与后端不一致时按后端改写', async () => {
    window.localStorage.setItem('doctor-agent:preferences', JSON.stringify({ theme: 'contrast' }))
    vi.mocked(api.fetchPreferences).mockResolvedValue(remote({ theme: 'eyecare' }))

    const p = usePreferences()
    await p.load('张医生')

    expect(p.prefs.value.theme).toBe('eyecare')
  })
})

describe('个人配置 · 主题写到根元素', () => {
  it('**默认主题不打 data-theme**', async () => {
    // build-themes 生成的 CSS 里默认态是靠 var(--t-xxx, #原值) 的回退值生效的，
    // 根本没有对应的变量定义。打上 data-theme="default" 不会有任何作用，
    // 反而会让人以为存在一套默认主题变量。
    const p = usePreferences()
    await p.load('张医生')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('非默认主题打标记，切回默认时移除', async () => {
    const p = usePreferences()
    await p.load('张医生')

    await p.update({ theme: 'eyecare' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('eyecare')

    await p.update({ theme: 'default' })
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

describe('个人配置 · 后端不可达不算失败', () => {
  it('拉取失败时本地值照常生效，只挂一条提示', async () => {
    window.localStorage.setItem('doctor-agent:preferences', JSON.stringify({ font_level: 'xlarge' }))
    vi.mocked(api.fetchPreferences).mockRejectedValue(new Error('Failed to fetch'))

    const p = usePreferences()
    await p.load('张医生')

    expect(p.prefs.value.font_level).toBe('xlarge')
    expect(p.syncError.value).toBeTruthy()
  })

  it('保存失败（网络类）**不回滚本地值** —— 刚调大的字号被弹回去比不同步更糟', async () => {
    const p = usePreferences()
    await p.load('张医生')
    vi.mocked(api.savePreferences).mockRejectedValue(new Error('Failed to fetch'))

    await p.update({ font_level: 'large' })

    expect(p.prefs.value.font_level).toBe('large')
    expect(p.syncError.value).toContain('本机设置仍有效')
  })

  it('保存被拒（400 取值非法）要回滚 —— 这时本地那份也是错的', async () => {
    const p = usePreferences()
    await p.load('张医生')
    const before = p.prefs.value.theme

    const err = Object.assign(new Error('theme 只能是 default / eyecare / contrast'), { status: 400 })
    vi.mocked(api.savePreferences).mockRejectedValue(err)

    const ok = await p.update({ theme: '赛博朋克' })

    expect(ok).toBe(false)
    expect(p.prefs.value.theme).toBe(before)
  })
})

describe('个人配置 · 枚举来自后端', () => {
  it('拉到 options 后用后端下发的取值，不用前端硬编码那份', async () => {
    vi.mocked(api.fetchPreferenceOptions).mockResolvedValue({
      ...OPTIONS,
      themes: ['default', 'eyecare', 'contrast', 'dark'],
    })

    const p = usePreferences()
    await p.load('张医生')

    // 后端加了一档，界面必须跟着多一个选项 —— 前端硬编码的话这里永远是 3
    expect(p.themes.value).toContain('dark')
  })
})

describe('个人配置 · 浮窗几何', () => {
  /**
   * 这一组验的是 `update()` 在本机**当场合出来的那份**，所以要让同步失败。
   *
   * 让 `savePreferences` 正常返回的话，`apply(saved.prefs)` 会拿响应体盖掉
   * 本机那份 —— 于是测的其实是 mock 的合并方式，不是 `update()` 的。
   * 这种「测桩不测码」的绿最难看出来。
   */
  function offline() {
    vi.mocked(api.savePreferences).mockRejectedValue(new Error('网络不可达'))
  }

  it('**几何是整份快照，不是逐项累积** —— 上一份里的旧键不许复活', async () => {
    // `useWindowMemory.snapshot()` 每次都整份写下当前布局，并且刻意不写某些键
    // （没拖过的边、没摆过的窗）。逐项合并会把它们一次次复活：线上那份就同时
    // 挂着 `merged:false` 与 `panel_offset_top:57`，两个不同时刻的布局凑一起。
    const p = usePreferences()
    await p.load('张医生')
    offline()

    await p.update({ windows: { panel_width: 320, panel_offset_top: 57 } })
    await p.update({ windows: { panel_width: 320 } })

    expect(p.prefs.value.windows).toEqual({ panel_width: 320 })
  })

  it('「清除布局记忆」要真的清掉 —— 合并语义下它是空转的', async () => {
    const p = usePreferences()
    await p.load('张医生')
    offline()
    await p.update({ windows: { panel_width: 320, panel_height: 600 } })

    await p.resetWindows()

    expect(p.prefs.value.windows).toEqual({})
  })

  it('补丁里没有 windows 就不动布局 —— 只改主题不该顺手把它抹了', async () => {
    const p = usePreferences()
    await p.load('张医生')
    offline()
    await p.update({ windows: { panel_width: 320 } })

    await p.update({ theme: 'eyecare' })

    expect(p.prefs.value.windows).toEqual({ panel_width: 320 })
  })

  it('没记住任何布局时摘要是空的 —— 界面据此禁用「恢复默认布局」', async () => {
    const p = usePreferences()
    await p.load('张医生')
    expect(p.windowSummary.value).toBe('')
  })
})

describe('个人配置 · 旧字号 key 的迁移', () => {
  it('新模型没设过字号时采纳旧值', async () => {
    window.localStorage.setItem('doctor-agent:font-level', 'large')
    vi.mocked(api.fetchPreferences).mockReturnValue(new Promise(() => {}))

    const p = usePreferences()
    p.load('张医生')

    expect(p.prefs.value.font_level).toBe('large')
  })

  it('新模型已设过就不被旧值覆盖', async () => {
    window.localStorage.setItem('doctor-agent:font-level', 'small')
    window.localStorage.setItem('doctor-agent:preferences', JSON.stringify({ font_level: 'xlarge' }))
    vi.mocked(api.fetchPreferences).mockReturnValue(new Promise(() => {}))

    const p = usePreferences()
    p.load('张医生')

    expect(p.prefs.value.font_level).toBe('xlarge')
  })

  it('**不删旧 key** —— 回滚到旧版本时它还得读', async () => {
    window.localStorage.setItem('doctor-agent:font-level', 'large')
    const p = usePreferences()
    await p.load('张医生')
    expect(window.localStorage.getItem('doctor-agent:font-level')).toBe('large')
  })
})

describe('个人配置 · 色板不进 CSS', () => {
  it('三个主题的色板色值定义在 JS 里', () => {
    // 放 CSS 里会被 build-themes 一起换掉：换成护眼之后三个色板全变成护眼色，
    // 就没法选了。放 JS 里脚本扫不到，天然免疫。
    expect(Object.keys(THEME_SWATCHES)).toEqual(['default', 'eyecare', 'contrast'])
    expect(THEME_SWATCHES.default[0]).toBe('#1677ff')
    expect(THEME_SWATCHES.eyecare[0]).toBe('#30a6e5')
    expect(THEME_SWATCHES.contrast[0]).toBe('#056dff')
  })
})

describe('个人配置 · 启动即生效', () => {
  /**
   * 这一组盯的是**「读」的那一半**。
   *
   * 第一版只有配置页调 `load()`，于是主题只在配置页那一刻生效，刷新即丢：
   * 医生把主题调成护眼，回工作站一刷新又变回蓝的，而配置页上还写着「护眼」。
   * 设置存住了、界面没跟上，比设置根本没存住更难查。
   */
  it('**不经过配置页也要生效** —— 启动时读本地值直接上屏', () => {
    window.localStorage.setItem(
      'doctor-agent:preferences',
      JSON.stringify({ theme: 'eyecare', font_level: 'large' }),
    )

    bootstrapPreferences()

    expect(document.documentElement.getAttribute('data-theme')).toBe('eyecare')
    expect(useFontScale().level.value.key).toBe('large')
  })

  it('是同步的，不发请求 —— 等一轮网络回来再上屏就是闪屏', () => {
    window.localStorage.setItem('doctor-agent:preferences', JSON.stringify({ theme: 'contrast' }))
    // 比增量而不是比「有没有被调过」：这些 mock 是文件级的，
    // 前面的用例已经调过它们，`not.toHaveBeenCalled()` 会因为别人的调用而红
    const before = vi.mocked(api.fetchPreferences).mock.calls.length

    bootstrapPreferences()

    // 断言不带 await：这一步必须在同一个 tick 内已经完成
    expect(document.documentElement.getAttribute('data-theme')).toBe('contrast')
    expect(vi.mocked(api.fetchPreferences).mock.calls.length).toBe(before)
  })

  it('本地没存过就是默认态，不打标记', () => {
    bootstrapPreferences()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

describe('个人配置 · 隐私模式', () => {
  /**
   * 这条不变量原本钉在 `useFontScale.spec.ts`。字号的持久化收归这里之后，
   * 它也要跟过来 —— 否则「谁写盘谁负责不崩」这件事就没人守了。
   */
  it('localStorage 写不进去也不能崩，本次会话内照常生效', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })

    const p = usePreferences()
    await expect(p.load('张医生')).resolves.not.toThrow()
    expect(p.prefs.value.theme).toBe('default')

    spy.mockRestore()
  })
})

describe('个人配置 · 字号是同一份取值', () => {
  /**
   * 曾经是两套：配置页写 `doctor-agent:preferences`，浮窗读
   * `doctor-agent:font-level`。两边都「生效」，只是各管各的 ——
   * 在配置页把字号调到特大，回工作站一点没变。
   */
  it('改偏好里的字号，浮窗的 zoom 跟着变', async () => {
    const p = usePreferences()
    await p.load('张医生')

    await p.update({ font_level: 'xlarge' })

    expect(useFontScale().level.value.scale).toBe(1.3)
  })

  it('后端下发的字号也要接管本地 —— 换台电脑登录同一医生名要跟过来', async () => {
    vi.mocked(api.fetchPreferences).mockResolvedValue(remote({ font_level: 'small' }))

    await usePreferences().load('张医生')

    expect(useFontScale().level.value.scale).toBe(0.9)
  })
})

describe('个人配置 · 移动端字号（AC-PREF-011）', () => {
  /**
   * 移动端**不能**用桌面那套内联 `zoom`：`.m-page` 自己是 `position:fixed`，
   * 在它上面加 `zoom` 会给 `.m-scrim` / `.m-sheet` 造出一个新的包含块，
   * 那两个「铺满屏幕」的浮层会当场算错大小。
   *
   * 所以走根元素属性 + 一条 CSS 规则：`zoom` 只挂在滚动内容区上，
   * 与桌面「挂内容区不挂外壳」是同一条道理，只是换了个落点。
   */
  it('字号写到根元素上，移动端 CSS 据此挂 zoom', async () => {
    const p = usePreferences()
    await p.load('张医生')

    await p.update({ font_level: 'large' })
    expect(document.documentElement.getAttribute('data-font')).toBe('large')
  })

  it('标准档**不打标记** —— 和默认主题同一条道理，写了不起作用只会误导', async () => {
    const p = usePreferences()
    await p.load('张医生')

    await p.update({ font_level: 'large' })
    await p.update({ font_level: 'normal' })

    expect(document.documentElement.hasAttribute('data-font')).toBe(false)
  })
})

describe('个人配置 · 服务端回了个怪东西', () => {
  /**
   * 这条是被浮窗布局的自动写回逼出来的。
   *
   * `update()` 原来无条件 `apply(saved.prefs)`。响应体一旦不是预期形状
   * （网关返回空体、代理插了一页 HTML、接口改了字段名），`prefs.value`
   * 会被置成 `undefined` —— 然后**所有读偏好的地方一起炸**：
   * 追问模式、字号、布局记忆，连带整个浮窗白屏。
   *
   * 一次同步失败的合理后果是「这次没同步上」，不是「界面塌了」。
   */
  it('保存返回的不是一份偏好时，保留本地值而不是把它冲成 undefined', async () => {
    const p = usePreferences()
    await p.load('张医生')
    await p.update({ theme: 'eyecare' })

    // 网关返回 200 但空体 —— 测试桩里最常见的形状，线上也真的会遇到
    vi.mocked(api.savePreferences).mockResolvedValue({} as never)
    await p.update({ windows: { panel_width: 320 } })

    expect(p.prefs.value).toBeTruthy()
    expect(p.prefs.value.theme).toBe('eyecare')
    // 本地那份仍然带上了刚提交的改动
    expect(p.prefs.value.windows.panel_width).toBe(320)
  })

  it('拉取返回怪东西时同理 —— 回落到本地值，不是 undefined', async () => {
    window.localStorage.setItem('doctor-agent:preferences', JSON.stringify({ theme: 'contrast' }))
    vi.mocked(api.fetchPreferences).mockResolvedValue({ actor: '张医生' } as never)

    const p = usePreferences()
    await p.load('张医生')

    expect(p.prefs.value).toBeTruthy()
    expect(p.prefs.value.theme).toBe('contrast')
  })
})

describe('个人配置 · 医生名是全局的', () => {
  /**
   * 这条是在**真浏览器里**发现的，单测全绿时它已经坏了 ——
   * 因为每条用例都在同一个实例上先 `load` 再 `update`，永远碰不到。
   *
   * `actorRef` 原来建在 `usePreferences()` 内部，于是每个调用点各拿一份：
   * App.vue 那份 `load('张医生')` 之后知道医生是谁，浮窗组件那份是空串。
   * 浮窗自动写回的布局因此落到了服务端的 `demo-doctor` 名下 ——
   * **换台电脑登录同一个医生名，布局读不回来**（AC-PREF-005）。
   *
   * 本地 localStorage 仍然生效，所以表面上「看起来是好的」。
   * 这类 bug 只有跨实例才暴露得出来。
   */
  it('一处 load，别处 update 也带同一个医生名', async () => {
    await usePreferences().load('王医生')

    // 另一个调用点 —— 组件里就是这么拿的，它自己不会去 load
    await usePreferences().update({ windows: { panel_width: 320 } })

    expect(vi.mocked(api.savePreferences).mock.lastCall?.[0]).toBe('王医生')
  })

  it('恢复默认同理 —— 别把别人的那一行删了', async () => {
    await usePreferences().load('王医生')
    await usePreferences().resetAll()

    expect(vi.mocked(api.resetPreferences).mock.lastCall?.[0]).toBe('王医生')
  })
})

describe('个人配置 · 后端还没有这一行', () => {
  /**
   * 「后端为准」这条规则在**后端从没写过**时会反过来伤人：服务端对没有记录的
   * 医生也返回一份完整默认值，客户端照单全收，本地设置当场清零。
   *
   * 每个老用户都会撞上：旧字号 key 的迁移把值读进本地，紧接着 `load()`
   * 就把它抹了 —— 规格 §4.1 承诺的迁移等于没做。
   *
   * 判据是服务端下发的 `stored`，不是「远端等于默认值」—— 后者分不清
   * 「医生显式选了默认」和「这行不存在」，而这两件事的正确处理相反。
   */
  it('本地那份保住，不被后端的默认值冲掉', async () => {
    window.localStorage.setItem(
      'doctor-agent:preferences',
      JSON.stringify({ theme: 'eyecare', font_level: 'large' }),
    )
    vi.mocked(api.fetchPreferences).mockResolvedValue({
      actor: '张医生', prefs: { ...FALLBACK_DEFAULTS }, stored: false,
    } as never)

    const p = usePreferences()
    await p.load('张医生')

    expect(p.prefs.value.theme).toBe('eyecare')
    expect(document.documentElement.getAttribute('data-theme')).toBe('eyecare')
  })

  it('并且**推上去** —— 否则换台电脑还是拿不到', async () => {
    window.localStorage.setItem(
      'doctor-agent:preferences',
      JSON.stringify({ theme: 'eyecare' }),
    )
    vi.mocked(api.fetchPreferences).mockResolvedValue({
      actor: '张医生', prefs: { ...FALLBACK_DEFAULTS }, stored: false,
    } as never)

    await usePreferences().load('张医生')

    expect(vi.mocked(api.savePreferences).mock.lastCall?.[1]).toMatchObject({ theme: 'eyecare' })
  })

  it('本地也是干净的就什么都不做 —— 别为「两边都是默认」凭空建一行', async () => {
    vi.mocked(api.fetchPreferences).mockResolvedValue({
      actor: '张医生', prefs: { ...FALLBACK_DEFAULTS }, stored: false,
    } as never)
    const before = vi.mocked(api.savePreferences).mock.calls.length

    await usePreferences().load('张医生')

    expect(vi.mocked(api.savePreferences).mock.calls.length).toBe(before)
  })

  it('后端有这一行时照旧以它为准', async () => {
    window.localStorage.setItem('doctor-agent:preferences', JSON.stringify({ theme: 'eyecare' }))
    vi.mocked(api.fetchPreferences).mockResolvedValue({
      actor: '张医生', prefs: { ...FALLBACK_DEFAULTS, theme: 'contrast' }, stored: true,
    } as never)

    const p = usePreferences()
    await p.load('张医生')

    expect(p.prefs.value.theme).toBe('contrast')
  })
})
