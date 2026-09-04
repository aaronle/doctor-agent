import { afterEach, describe, expect, it, vi } from 'vitest'

import { SNAP_PX, useDockedWindows } from './useDockedWindows'

/**
 * 两个浮窗的合并 / 分离。
 *
 * 默认合并（就是现在这样）。拖标题栏拖开，拖回去靠近了自动吸附。
 */

/** 造一个有确定几何的「外层壳」元素 —— jsdom 的布局数字全是 0，得自己塞 */
function shell(rect: Partial<DOMRect>) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const full = { left: 0, top: 0, width: 300, height: 800, right: 0, bottom: 0, x: 0, y: 0, ...rect }
  el.getBoundingClientRect = () => ({ ...full, toJSON: () => full }) as DOMRect
  return el
}

function pointer(type: string, x: number, y: number) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
}

/** 拖某个窗：按下 → 移动 → 松手 */
function drag(
  d: ReturnType<typeof useDockedWindows>,
  key: 'drawer' | 'panel',
  self: HTMLElement,
  other: HTMLElement | null,
  from: [number, number],
  to: [number, number],
) {
  const e = pointer('pointerdown', ...from) as unknown as PointerEvent
  Object.defineProperty(e, 'currentTarget', { value: self })
  d.startDrag(key, e, self, other)
  window.dispatchEvent(pointer('pointermove', ...to))
  window.dispatchEvent(pointer('pointerup', ...to))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('浮窗 · 默认合并', () => {
  it('一开始是合并态，位置交给 CSS', () => {
    const d = useDockedWindows()
    expect(d.merged.value).toBe(true)
    expect(d.styleFor('panel').value).toEqual({})
    expect(d.styleFor('drawer').value).toEqual({})
  })
})

describe('浮窗 · 合并态下两个一起走', () => {
  it('拖一个，另一个跟着挪同样的距离', () => {
    // 合并的意思就是「它们现在是一个东西」——
    // 拖一个另一个不动，那叫叠在一起，不叫合并。
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900)
    const drawer = shell({ left: 300, top: 20, width: 800 })
    const panel = shell({ left: 1100, top: 20, width: 300 })
    const d = useDockedWindows()

    drag(d, 'panel', panel, drawer, [1200, 40], [1100, 140])

    expect(d.pos.value.panel).toEqual({ left: 1000, top: 120 })
    expect(d.pos.value.drawer).toEqual({ left: 200, top: 120 })
  })

  it('从合并态拖出来就是「分离」', () => {
    const drawer = shell({ left: 300, top: 20, width: 800 })
    const panel = shell({ left: 1100, top: 20, width: 300 })
    const d = useDockedWindows()

    drag(d, 'panel', panel, drawer, [1200, 40], [900, 300])

    expect(d.merged.value).toBe(false)
    expect(d.styleFor('panel').value).toMatchObject({ position: 'fixed' })
  })
})

describe('浮窗 · 分离时要冻住尺寸', () => {
  it('**分离后带上 width/height**，否则脱离 flex 会按内容炸开', () => {
    // 两个窗在合并态是 flex 子项 —— 抽屉 flex:1、高度由父容器给。
    // 一改成 position:fixed 这些约束全没了：实测抽屉从 866×985
    // 变成 1471×1703，高度直接超出屏幕。
    const drawer = shell({ left: 300, top: 20, width: 866, height: 985 })
    const panel = shell({ left: 1166, top: 20, width: 300, height: 985 })
    const d = useDockedWindows()

    drag(d, 'panel', panel, drawer, [1200, 40], [900, 300])

    expect(d.styleFor('panel').value).toMatchObject({
      width: '300px', height: '985px', flex: 'none',
    })
    expect(d.styleFor('drawer').value).toMatchObject({ width: '866px', height: '985px' })
  })

  it('吸附回去要**把冻住的尺寸放掉**，否则合并态还挂着死宽高', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900)
    const drawer = shell({ left: 100, top: 100, width: 600, height: 700 })
    const panel = shell({ left: 1000, top: 100, width: 300, height: 700 })
    const d = useDockedWindows()
    drag(d, 'panel', panel, drawer, [1100, 120], [900, 320])
    expect(d.size.value.panel).not.toBeNull()

    const dw = d.pos.value.drawer
    const cur = d.pos.value.panel
    drag(d, 'panel', panel, drawer, [0, 0],
         [dw.left + 600 + 10 - cur.left, dw.top - cur.top])

    expect(d.merged.value).toBe(true)
    expect(d.size.value.panel).toBeNull()
    expect(d.styleFor('panel').value).toEqual({})
  })

  it('一键还原也放掉尺寸', () => {
    const drawer = shell({ left: 100, top: 100, width: 600 })
    const panel = shell({ left: 900, top: 100, width: 300 })
    const d = useDockedWindows()
    drag(d, 'panel', panel, drawer, [1000, 120], [300, 500])

    d.resetLayout()

    expect(d.size.value.panel).toBeNull()
    expect(d.size.value.drawer).toBeNull()
  })
})

describe('浮窗 · 靠近吸附', () => {
  function separated() {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900)
    const drawer = shell({ left: 100, top: 100, width: 600, height: 700 })
    const panel = shell({ left: 1000, top: 100, width: 300, height: 700 })
    const d = useDockedWindows()
    drag(d, 'panel', panel, drawer, [1100, 120], [900, 320])   // 先拖开
    expect(d.merged.value).toBe(false)
    return { d, drawer, panel }
  }

  /** 把 panel 挪到指定落点（合并态下两个都会动，所以目标要按当前值算） */
  function moveTo(d: ReturnType<typeof useDockedWindows>, panel: HTMLElement, drawer: HTMLElement,
                  left: number, top: number) {
    const cur = d.pos.value.panel
    drag(d, 'panel', panel, drawer, [0, 0], [left - cur.left, top - cur.top])
  }

  it('拖到贴近对方右边线 → 吸附，回到合并态', () => {
    const { d, drawer, panel } = separated()
    // **drawer 也被第一次拖动带走了**（合并态两个一起动），
    // 所以落点要按它现在的位置算，不能按初始的
    const dw = d.pos.value.drawer
    moveTo(d, panel, drawer, dw.left + 600 + 10, dw.top)   // 缝隙 10 < 40

    expect(d.merged.value).toBe(true)
  })

  it('还差得远就不吸 —— 否则想分开时会被硬拽回去', () => {
    const { d, drawer, panel } = separated()
    const dw = d.pos.value.drawer
    moveTo(d, panel, drawer, dw.left + 600 + 200, dw.top)

    expect(d.merged.value).toBe(false)
  })

  it('横向够近但**纵向不重叠**也不吸 —— 一上一下不算贴在一起', () => {
    // 用矮窗口：视口 900、窗高 700 时，钳位（标题栏必须留在屏内）
    // 让真正的上下错开根本做不到 —— 那样测的是钳位不是重叠判定。
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900)
    const drawer = shell({ left: 100, top: 60, width: 600, height: 200 })
    const panel = shell({ left: 1000, top: 60, width: 300, height: 200 })
    const d = useDockedWindows()
    drag(d, 'panel', panel, drawer, [1100, 80], [900, 100])   // 拖开
    expect(d.merged.value).toBe(false)

    const dw = d.pos.value.drawer
    moveTo(d, panel, drawer, dw.left + 600 + 10, dw.top + 200 + 60)   // 横向贴上，纵向让开

    expect(d.merged.value).toBe(false)
  })

  it('吸附阈值是 40px', () => {
    expect(SNAP_PX).toBe(40)
  })
})

describe('浮窗 · 拖出屏幕要钳回来', () => {
  it('**标题栏**必须留在屏幕里 —— 出去就再也抓不住了', () => {
    // 钳的是标题栏不是整个窗：窗体下半部分出屏只是看不全内容，
    // 标题栏出屏这个窗口就永远回不来了。
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900)
    const drawer = shell({ left: 100, top: 100, width: 600 })
    const panel = shell({ left: 900, top: 100, width: 300 })
    const d = useDockedWindows()

    drag(d, 'panel', panel, drawer, [1000, 120], [99999, 99999])

    expect(d.pos.value.panel.left).toBeLessThan(1440)
    expect(d.pos.value.panel.top).toBeLessThanOrEqual(900 - 44)
  })

  it('往左上拖过头也钳住', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900)
    const drawer = shell({ left: 100, top: 100, width: 600 })
    const panel = shell({ left: 900, top: 100, width: 300 })
    const d = useDockedWindows()

    drag(d, 'panel', panel, drawer, [1000, 120], [-99999, -99999])

    expect(d.pos.value.panel.top).toBe(0)
    // 允许左边探出一部分（那只是内容），但至少留 160px 抓得住
    expect(d.pos.value.panel.left).toBeGreaterThanOrEqual(-(300 - 160))
  })
})

describe('浮窗 · 一键还原', () => {
  it('双击标题栏回到默认停靠 —— 拖乱了不用刷新页面', () => {
    const drawer = shell({ left: 100, top: 100, width: 600 })
    const panel = shell({ left: 900, top: 100, width: 300 })
    const d = useDockedWindows()
    drag(d, 'panel', panel, drawer, [1000, 120], [300, 500])
    expect(d.merged.value).toBe(false)

    d.resetLayout()

    expect(d.merged.value).toBe(true)
    expect(d.styleFor('panel').value).toEqual({})
  })
})
