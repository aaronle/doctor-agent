import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AgentMascot from './AgentMascot.vue'

/**
 * 医生智能体缩起来之后的桌面卡通（方案 D1「微笑」）。
 *
 * 它替掉的是原件那个 52px 的蓝色「AI」圆钮。**位置与职责一个字没变** ——
 * 都是「面板收起后，把它找回来的那个东西」，换的只是长相。
 *
 * 为什么值得换：那个圆钮上写着「AI」，是一个**标签**；
 * 而这一屏真正要传达的是「医生智能体现在待命，随时叫它」。
 * 一张脸能表达状态（在想 / 有话说 / 有几条待补问），两个字母不能。
 */

/**
 * 造一次拖拽。
 *
 * **jsdom 没有 `PointerEvent`。** 用 `MouseEvent` 顶上就行 ——
 * 监听器认的是事件名，`clientX/clientY` 一样带得过去；
 * 组件里 `setPointerCapture` 本来就写了 `?.`（jsdom 的元素上没这个方法）。
 */
function pointer(type: string, x: number, y: number) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
}

async function drag(el: Element, from: [number, number], to: [number, number]) {
  el.dispatchEvent(pointer('pointerdown', ...from))
  window.dispatchEvent(pointer('pointermove', ...to))
  window.dispatchEvent(pointer('pointerup', ...to))
  await Promise.resolve()
}

function mountMascot(props: Record<string, unknown> = {}) {
  return mount(AgentMascot, { props, attachTo: document.body })
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('卡通形象 · 基本形状', () => {
  it('是一张脸，不是一个写着「AI」的圆点', () => {
    const wrapper = mountMascot()
    expect(wrapper.find('.mascot').exists()).toBe(true)
    // 眼睛两只、嘴一张 —— 少任何一样它就不是 D1 了
    expect(wrapper.findAll('.mascot-eye')).toHaveLength(2)
    expect(wrapper.find('.mascot-mouth').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('AI')
  })

  it('无文字，所以必须有 aria-label 与 title 说明它是什么', () => {
    // 一个纯图形的入口，读屏软件读不出来就等于不存在
    const wrapper = mountMascot()
    const el = wrapper.find('.mascot')
    expect(el.attributes('aria-label')).toBeTruthy()
    expect(el.attributes('title')).toBeTruthy()
  })
})

describe('卡通形象 · 点击唤回', () => {
  it('点一下发 open —— 它唯一的正事就是把面板叫回来', async () => {
    const wrapper = mountMascot()
    await wrapper.find('.mascot').trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('**拖完那一下不算点击**，否则每拖一次面板都弹回来', async () => {
    // 拖拽最经典的坑：pointerup 之后浏览器照样派发 click。
    // 不拦的话「把它挪到别处」这个动作永远伴随一次误开面板 ——
    // 医生会认为这个卡通不能拖。
    const wrapper = mountMascot()
    const el = wrapper.find('.mascot').element
    await drag(el, [200, 200], [420, 360])
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('open')).toBeUndefined()
  })

  it('只按下没挪动，仍然算点击 —— 手抖两个像素不该把它变成拖拽', async () => {
    const wrapper = mountMascot()
    const el = wrapper.find('.mascot').element
    await drag(el, [200, 200], [202, 201])
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('open')).toHaveLength(1)
  })
})

describe('卡通形象 · 拖动', () => {
  it('拖到哪停在哪', async () => {
    const wrapper = mountMascot()
    const el = wrapper.find('.mascot')
    const before = el.attributes('style') ?? ''
    await drag(el.element, [200, 200], [500, 400])

    expect(wrapper.find('.mascot').attributes('style')).not.toBe(before)
  })

  it('**连续拖两次要累加**，不是每次都从头算', async () => {
    // 起点必须取自「上一次拖到哪」，而不是每次重新读 DOM ——
    // `left/top` 写进的是相对定位祖先的坐标系，`getBoundingClientRect()`
    // 给的是视口坐标系，两个混用会让元素当场跳走。
    // 实测追问提示浮框（position:absolute 装在面板里）从 x=1205 拖一下
    // 跳到 x=1966，跑出 1440 宽的屏幕，缩小按钮再也点不到。
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(2000)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(2000)

    const wrapper = mountMascot()
    const el = wrapper.find('.mascot').element
    const left = () =>
      Number(/left:\s*([\d.]+)px/.exec(wrapper.find('.mascot').attributes('style') ?? '')?.[1])

    // **往左拖**：卡通默认贴右下角，往右拖两次都会被钳在同一个边界上，
    // 那样测的是钳位不是累加（第一版就是这么自己撞上去的）
    await drag(el, [900, 400], [800, 400])
    const first = left()
    await drag(el, [800, 400], [700, 400])
    const second = left()

    expect(first).toBeGreaterThan(0)
    expect(second).toBeCloseTo(first - 100, 0)
  })

  it('拖出屏幕要拉回来 —— 拖丢了就只能刷新页面', async () => {
    // 这是「关掉两个 × 就回不来」那条死路的同一类问题：
    // 唤回入口本身必须永远够得着。
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)

    const wrapper = mountMascot()
    await drag(wrapper.find('.mascot').element, [200, 200], [9999, 9999])

    const style = wrapper.find('.mascot').attributes('style') ?? ''
    const left = Number(/left:\s*([\d.]+)px/.exec(style)?.[1] ?? NaN)
    const top = Number(/top:\s*([\d.]+)px/.exec(style)?.[1] ?? NaN)
    expect(left).toBeLessThan(1280)
    expect(top).toBeLessThan(800)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(top).toBeGreaterThanOrEqual(0)
  })
})

describe('卡通形象 · 三态', () => {
  it('默认在笑', () => {
    const wrapper = mountMascot()
    expect(wrapper.find('.mascot').classes()).not.toContain('thinking')
    expect(wrapper.find('.mascot-mouth').exists()).toBe(true)
  })

  it('分析中换成闭眼，**不做旋转风火轮**', async () => {
    // 它浮在医生的桌面上。一个一直转的东西会持续抢注意力，
    // 而分析要跑 20–30 秒 —— 那是半分钟的余光干扰。
    const wrapper = mountMascot({ thinking: true })
    expect(wrapper.find('.mascot').classes()).toContain('thinking')
    expect(wrapper.find('.mascot-eye-closed').exists()).toBe(true)
    expect(wrapper.find('.mascot-spinner').exists()).toBe(false)
  })

  it('有待补问才出橙色角标，数字就是条数', () => {
    const wrapper = mountMascot({ hintCount: 3 })
    expect(wrapper.find('.mascot-badge').text()).toBe('3')
  })

  it('没有待补问就不出角标 —— 一个常驻的红点等于没有红点', () => {
    const wrapper = mountMascot({ hintCount: 0 })
    expect(wrapper.find('.mascot-badge').exists()).toBe(false)
  })

  it('角标数字与问诊提示浮框同源，不自己另算一个数', () => {
    // 两处对不上时医生不知道该信哪个。这里只做透传。
    const wrapper = mountMascot({ hintCount: 9 })
    expect(wrapper.find('.mascot-badge').text()).toBe('9')
  })
})
