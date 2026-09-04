import { afterEach, describe, expect, it, vi } from 'vitest'

import { useResizable } from './useResizable'

/**
 * 浮窗左边线拖拽调宽。
 *
 * 两个浮窗都**靠右停靠**，右边贴着屏幕 —— 只有左边线能拉。
 * 往左拖 = 变宽（边线远离右侧锚点），这是唯一容易搞反的地方。
 */

function pointer(type: string, x: number) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 300 })
}

function dragEdge(el: Element, from: number, to: number) {
  el.dispatchEvent(pointer('pointerdown', from))
  window.dispatchEvent(pointer('pointermove', to))
  window.dispatchEvent(pointer('pointerup', to))
}

/** 竖向拖：下边线，往下 = 变高 */
function pointerY(type: string, y: number) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 500, clientY: y })
}

function dragEdgeY(el: Element, from: number, to: number) {
  el.dispatchEvent(pointerY('pointerdown', from))
  window.dispatchEvent(pointerY('pointermove', to))
  window.dispatchEvent(pointerY('pointerup', to))
}

/** 造一个挂了 onPointerDown 的边线元素 —— 组件里那个 5px 竖条 */
function handle(r: { onPointerDown: (e: PointerEvent) => void }) {
  const el = document.createElement('div')
  el.addEventListener('pointerdown', r.onPointerDown as EventListener)
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('调宽 · 方向', () => {
  it('**往左拖是变宽** —— 浮窗靠右停靠，左边线远离锚点就是变宽', () => {
    const r = useResizable({ initial: 300, min: 260, max: 560 })
    const el = handle(r)
    dragEdge(el, 900, 800)

    expect(r.width.value).toBe(400)
  })

  it('往右拖是变窄', () => {
    const r = useResizable({ initial: 400, min: 260, max: 560 })
    const el = handle(r)
    dragEdge(el, 900, 960)

    expect(r.width.value).toBe(340)
  })

  it('连续两次拖动累加，不是每次从初始宽重算', () => {
    const r = useResizable({ initial: 300, min: 260, max: 560 })
    const el = handle(r)
    dragEdge(el, 900, 850)
    dragEdge(el, 850, 800)

    expect(r.width.value).toBe(400)
  })
})

describe('调宽 · 边界', () => {
  it('不许拉到比 min 还窄 —— 再窄就装不下患者信息行了', () => {
    const r = useResizable({ initial: 300, min: 260, max: 560 })
    dragEdge(handle(r), 900, 9999)

    expect(r.width.value).toBe(260)
  })

  it('不许拉到比 max 还宽 —— 浮窗盖满屏幕就看不见底下的 HIS 了', () => {
    const r = useResizable({ initial: 300, min: 260, max: 560 })
    dragEdge(handle(r), 900, -9999)

    expect(r.width.value).toBe(560)
  })

  it('max 还受视口限制：屏幕比 max 窄时按屏幕来', () => {
    // 否则在小屏上拉到 max 会把整个页面顶出去
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(420)
    const r = useResizable({ initial: 300, min: 260, max: 1100 })
    dragEdge(handle(r), 400, -9999)

    expect(r.width.value).toBeLessThanOrEqual(420)
    expect(r.width.value).toBeGreaterThanOrEqual(260)
  })
})

describe('调宽 · 恢复默认', () => {
  it('双击边线恢复默认宽度', () => {
    const r = useResizable({ initial: 300, min: 260, max: 560 })
    dragEdge(handle(r), 900, 700)
    expect(r.width.value).toBe(500)

    r.reset()
    // **回到「交给 CSS」而不是回到某个数** —— 样式表改了默认宽，
    // 双击恢复的也该是新的那个值，不是这里写死的旧值
    expect(r.width.value).toBeNull()
    expect(r.style.value).toEqual({})
  })

  it('起始宽可以由运行时决定 —— flex 布局的元素要量了才知道多宽', () => {
    let measured = 800
    const r = useResizable({ initial: () => measured, min: 420, max: 1400 })
    dragEdge(handle(r), 900, 800)
    expect(r.width.value).toBe(900)

    r.reset()
    measured = 640
    dragEdge(handle(r), 900, 850)
    expect(r.width.value).toBe(690)
  })
})

describe('调宽 · 样式与状态', () => {
  it('没拖过时不输出内联宽度 —— 交给 CSS，免得写死一个和样式表打架的数', () => {
    const r = useResizable({ initial: 300, min: 260, max: 560 })
    expect(r.style.value).toEqual({})
  })

  it('拖过之后输出 width', () => {
    const r = useResizable({ initial: 300, min: 260, max: 560 })
    dragEdge(handle(r), 900, 800)
    expect(r.style.value).toEqual({ width: '400px' })
  })

  it('拖动中有标记，供界面禁掉过渡动画', () => {
    // 边线跟手是这个交互的全部体感。留着 width 的 transition，
    // 边线会慢半拍跟在指针后面，手感立刻变糊。
    const r = useResizable({ initial: 300, min: 260, max: 560 })
    const el = handle(r)
    expect(r.resizing.value).toBe(false)

    el.dispatchEvent(pointer('pointerdown', 900))
    window.dispatchEvent(pointer('pointermove', 800))
    expect(r.resizing.value).toBe(true)

    window.dispatchEvent(pointer('pointerup', 800))
    expect(r.resizing.value).toBe(false)
  })
})

describe('拉高 · 下边线', () => {
  it('**往下拖是变高** —— 浮窗锚在顶部，下边线远离锚点就是变高', () => {
    // 和左边线正好相反：那条是「往左（dx 为负）变宽」用减号，
    // 这条是「往下（dy 为正）变高」用加号。搞反了会变成越拖越小。
    const r = useResizable({ initial: 600, min: 320, max: 1200, edge: 'bottom' })
    dragEdgeY(handle(r), 700, 860)

    expect(r.size.value).toBe(760)
  })

  it('往上拖是变矮', () => {
    const r = useResizable({ initial: 600, min: 320, max: 1200, edge: 'bottom' })
    dragEdgeY(handle(r), 700, 580)

    expect(r.size.value).toBe(480)
  })

  it('输出的是 height 不是 width', () => {
    const r = useResizable({ initial: 600, min: 320, max: 1200, edge: 'bottom' })
    dragEdgeY(handle(r), 700, 800)

    expect(r.style.value).toEqual({ height: '700px' })
  })

  it('下限：再矮就只剩标题栏了', () => {
    const r = useResizable({ initial: 600, min: 320, max: 1200, edge: 'bottom' })
    dragEdgeY(handle(r), 700, -9999)

    expect(r.size.value).toBe(320)
  })

  it('上限按**视口高**收，不是视口宽 —— 竖轴要看对边', () => {
    // 第一版 clamp 里两条轴都拿 innerWidth 比，横屏上高度会被放到 1400。
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    const r = useResizable({ initial: 600, min: 320, max: 1400, edge: 'bottom' })
    dragEdgeY(handle(r), 700, 9999)

    expect(r.size.value).toBe(800)
  })

  it('双击恢复默认', () => {
    // jsdom 视口高缺省 768，不 mock 的话 800 会被钳到 768 —— 那是对的行为，
    // 是期望值写错了。这类「实现没问题、测试算错」的失败最容易被顺手改成
    // 迁就实现，所以把原因写在这儿。
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000)
    const r = useResizable({ initial: 600, min: 320, max: 1200, edge: 'bottom' })
    dragEdgeY(handle(r), 700, 900)
    expect(r.size.value).toBe(800)

    r.reset()
    expect(r.style.value).toEqual({})
  })
})
