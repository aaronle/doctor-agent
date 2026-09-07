import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_DEFAULTS, THEME_SWATCHES, usePreferences } from './usePreferences'

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
  it('几何是逐项累积的，改宽度不该把记住的高度抹掉', async () => {
    const p = usePreferences()
    await p.load('张医生')

    vi.mocked(api.savePreferences).mockImplementation(async (_a, patch) => ({
      ok: true,
      actor: '张医生',
      prefs: {
        ...p.prefs.value,
        ...patch,
        windows: { ...p.prefs.value.windows, ...(patch.windows ?? {}) },
      },
    }))

    await p.update({ windows: { panel_width: 320 } })
    await p.update({ windows: { panel_height: 600 } })

    expect(p.prefs.value.windows).toEqual({ panel_width: 320, panel_height: 600 })
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
