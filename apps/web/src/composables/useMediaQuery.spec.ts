import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import { MOBILE_QUERY, useIsMobile, useMediaQuery } from './useMediaQuery'

/** 在组件里跑 composable —— onBeforeUnmount 需要组件实例 */
function host(query: string) {
  const seen: { value: boolean }[] = []
  const Comp = defineComponent({
    setup() {
      const matches = useMediaQuery(query)
      seen.push(matches as unknown as { value: boolean })
      return () => h('i', String(matches.value))
    },
  })
  const wrapper = mount(Comp)
  return { wrapper, matches: seen[0] }
}

afterEach(() => vi.unstubAllGlobals())

describe('useMediaQuery', () => {
  it('matchMedia 缺失时按桌面处理，而不是抛错', () => {
    // jsdom 和部分测试环境没有 matchMedia。无条件调用会让整个组件挂载失败 ——
    // 那不是「退化成桌面」，那是整页白屏。
    vi.stubGlobal('matchMedia', undefined)
    const { matches } = host(MOBILE_QUERY)
    expect(matches.value).toBe(false)
  })

  it('读取初始匹配结果', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true, media: MOBILE_QUERY,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })))
    expect(host(MOBILE_QUERY).matches.value).toBe(true)
  })

  it('视口变化时跟着变 —— 转屏不该让界面停在旧布局', () => {
    let handler: ((e: { matches: boolean }) => void) | null = null
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: MOBILE_QUERY,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { handler = fn },
      removeEventListener: vi.fn(),
    })))

    const { matches } = host(MOBILE_QUERY)
    expect(matches.value).toBe(false)

    handler!({ matches: true })
    expect(matches.value).toBe(true)
  })

  it('只有 addListener 的旧 Safari 也要能订阅', () => {
    let handler: ((e: { matches: boolean }) => void) | null = null
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: MOBILE_QUERY,
      addListener: (fn: (e: { matches: boolean }) => void) => { handler = fn },
      removeListener: vi.fn(),
    })))

    const { matches } = host(MOBILE_QUERY)
    handler!({ matches: true })
    expect(matches.value).toBe(true)
  })

  it('卸载时退订，不给已销毁的组件留回调', () => {
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: MOBILE_QUERY,
      addEventListener: vi.fn(), removeEventListener,
    })))

    host(MOBILE_QUERY).wrapper.unmount()
    expect(removeEventListener).toHaveBeenCalled()
  })

  it('useIsMobile 用的是 768px 断点', () => {
    const matchMedia = vi.fn(() => ({
      matches: false, media: '', addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }))
    vi.stubGlobal('matchMedia', matchMedia)

    const Comp = defineComponent({ setup: () => { useIsMobile(); return () => h('i') } })
    mount(Comp)

    expect(matchMedia).toHaveBeenCalledWith('(max-width: 768px)')
  })
})
