import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'

import { useMaximize } from './useMaximize'

/** 浮窗全屏（铺满视口）。一次只能一个，ESC 退出。 */

/** ESC 监听挂在 onMounted 上，所以要在组件里用 */
function mounted() {
  let api!: ReturnType<typeof useMaximize>
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useMaximize()
        return () => h('div')
      },
    }),
  )
  return { api, wrapper }
}

describe('全屏 · 开关', () => {
  it('默认没有窗全屏', () => {
    const { api } = mounted()
    expect(api.maximized.value).toBeNull()
    expect(api.styleFor('panel').value).toEqual({})
  })

  it('点一下铺满视口', () => {
    const { api } = mounted()
    api.toggle('panel')

    expect(api.isMax('panel')).toBe(true)
    expect(api.styleFor('panel').value).toMatchObject({
      position: 'fixed', left: '0px', top: '0px', right: '0px', bottom: '0px',
    })
  })

  it('再点一下退出', () => {
    const { api } = mounted()
    api.toggle('panel')
    api.toggle('panel')

    expect(api.maximized.value).toBeNull()
    expect(api.styleFor('panel').value).toEqual({})
  })
})

describe('全屏 · 一次只能一个', () => {
  it('另一个窗要藏起来 —— 两个都铺满会互相盖住', () => {
    const { api } = mounted()
    api.toggle('panel')

    expect(api.isHidden('drawer')).toBe(true)
    expect(api.isHidden('panel')).toBe(false)
  })

  it('都没全屏时谁也不藏', () => {
    const { api } = mounted()
    expect(api.isHidden('drawer')).toBe(false)
    expect(api.isHidden('panel')).toBe(false)
  })

  it('换另一个全屏，前一个自动让位', () => {
    const { api } = mounted()
    api.toggle('panel')
    api.toggle('drawer')

    expect(api.isMax('drawer')).toBe(true)
    expect(api.isMax('panel')).toBe(false)
    expect(api.isHidden('panel')).toBe(true)
  })
})

describe('全屏 · 覆盖层级与形状', () => {
  it('要盖住底下的 HIS 门面和另一个窗', () => {
    // .ai-float-wrapper 是 z-index:2000；低于它就会被另一个窗压住
    const { api } = mounted()
    api.toggle('drawer')
    expect(Number(api.styleFor('drawer').value.zIndex)).toBeGreaterThan(2000)
  })

  it('铺满时去掉圆角 —— 贴着屏幕四边的圆角看起来像没铺满', () => {
    const { api } = mounted()
    api.toggle('drawer')
    expect(api.styleFor('drawer').value.borderRadius).toBe('0')
  })

  it('**清掉写死的宽高**，否则拖过尺寸的窗铺不满', () => {
    // 拖过边线的窗身上挂着 width/height 内联样式，
    // 只给 left/top/right/bottom 的话它还是老尺寸。
    const { api } = mounted()
    api.toggle('panel')
    expect(api.styleFor('panel').value).toMatchObject({
      width: 'auto', height: 'auto', flex: 'none',
    })
  })
})

describe('全屏 · ESC 退出', () => {
  it('按 ESC 退出 —— 这是所有人都会先按的那个键', () => {
    const { api } = mounted()
    api.toggle('panel')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(api.maximized.value).toBeNull()
  })

  it('没全屏时按 ESC 不吞事件 —— 别把别处的关闭快捷键抢了', () => {
    const { api } = mounted()
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    let stopped = false
    const orig = e.stopPropagation.bind(e)
    e.stopPropagation = () => { stopped = true; orig() }

    document.dispatchEvent(e)

    expect(stopped).toBe(false)
    expect(api.maximized.value).toBeNull()
  })

  it('别的键不管', () => {
    const { api } = mounted()
    api.toggle('panel')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(api.isMax('panel')).toBe(true)
  })

  it('组件卸载后不再监听 —— 否则换页面按 ESC 会去动一个不存在的窗', () => {
    const { api, wrapper } = mounted()
    api.toggle('panel')
    wrapper.unmount()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    // 监听已摘掉，状态不再变化
    expect(api.maximized.value).toBe('panel')
  })
})
