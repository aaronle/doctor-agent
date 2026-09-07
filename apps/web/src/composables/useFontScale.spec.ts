import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FONT_LEVELS, useFontScale } from './useFontScale'

/** 浮窗字号。四档，存本地，两个浮窗共用一个值。 */

beforeEach(() => {
  window.localStorage.clear()
  useFontScale().setLevel('normal')
})

describe('字号 · 四档', () => {
  it('默认是标准档，且**不输出 zoom**', () => {
    // `zoom:1` 会凭空造出一个新的包含块，让里面 position:fixed 的东西
    // 改以面板为参照。默认档本来一切正常，不该为了统一写法去动它。
    const f = useFontScale()
    expect(f.level.value.key).toBe('normal')
    expect(f.style.value).toEqual({})
  })

  it('四档分别是 小 / 标准 / 大 / 特大', () => {
    expect(FONT_LEVELS.map((l) => l.label)).toEqual(['小', '标准', '大', '特大'])
    expect(FONT_LEVELS.map((l) => l.scale)).toEqual([0.9, 1, 1.15, 1.3])
  })

  it('非标准档输出 zoom', () => {
    const f = useFontScale()
    f.setLevel('large')
    expect(f.style.value).toEqual({ zoom: 1.15 })
  })

  it('给个不认识的档位就不动 —— 别把界面缩成 undefined', () => {
    const f = useFontScale()
    f.setLevel('large')
    f.setLevel('巨无霸')
    expect(f.level.value.key).toBe('large')
  })
})

describe('字号 · 两个浮窗共用一个值', () => {
  it('一处改，另一处跟着变', () => {
    // 各存一份必然会漂：医生在 AI 助手里调大，医生智能体还是小的。
    const a = useFontScale()
    const b = useFontScale()
    a.setLevel('xlarge')
    expect(b.level.value.key).toBe('xlarge')
    expect(b.style.value).toEqual({ zoom: 1.3 })
  })
})

describe('字号 · 谁负责存', () => {
  /**
   * 这一组原来断言的是「setLevel 自己写 localStorage」。
   *
   * 那正是要修的东西：配置页写 `doctor-agent:preferences`、这里写
   * `doctor-agent:font-level`，**两个写入方各管各的** —— 在配置页把字号
   * 调到特大，回工作站一点没变。持久化已收归 `usePreferences`
   * （见 `usePreferences.spec.ts` 的「字号是同一份取值」），
   * 这里只剩「应用」这一件事。
   */
  it('**不再自己写盘** —— 旧 key 只读不写，规格 §4.1', () => {
    window.localStorage.removeItem('doctor-agent:font-level')

    useFontScale().setLevel('large')

    expect(useFontScale().level.value.key).toBe('large')
    // 写了才是 bug：那就又有两个写入方了
    expect(window.localStorage.getItem('doctor-agent:font-level')).toBeNull()
  })

  it('旧 key 仍然认 —— 老用户的字号要能迁过来', async () => {
    // 迁移逻辑在 usePreferences.migrateLegacyFont；这里钉住「读」这一侧还在
    window.localStorage.setItem('doctor-agent:font-level', 'xlarge')
    vi.resetModules()
    const fresh = await import('./useFontScale')
    expect(fresh.useFontScale().level.value.key).toBe('xlarge')
  })
})
