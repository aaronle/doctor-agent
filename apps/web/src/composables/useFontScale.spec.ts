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

describe('字号 · 存本地', () => {
  it('设过就写进 localStorage —— 刷新、换病人都不该丢', () => {
    // 字号是「设一次就不想再设」的偏好。
    useFontScale().setLevel('large')
    expect(window.localStorage.getItem('doctor-agent:font-level')).toBe('large')
  })

  it('localStorage 抛异常时回落默认，不让字号把页面拖垮', () => {
    // 隐私模式下 setItem 会抛。字号不是关键功能。
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })
    const f = useFontScale()
    expect(() => f.setLevel('small')).not.toThrow()
    // 存不下，但本次会话内仍然生效
    expect(f.level.value.key).toBe('small')
    spy.mockRestore()
  })
})
