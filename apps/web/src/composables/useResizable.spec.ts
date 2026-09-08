import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { linkResizables, useResizable } from './useResizable'

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

describe('边线拖拽 · 外部设定尺寸', () => {
  /**
   * `setSize` 是给「恢复记住的布局」用的（`useWindowMemory`）。
   * 它必须**和拖拽走同一套钳位** —— 医生在 27 寸上把抽屉拉到 1800，
   * 换台 13 寸打开时若照原样铺开，浮窗会把整个页面顶出去，
   * 而他完全不会想到是「记住的布局」干的。
   */
  it('照常钳在 min/max 之间', () => {
    const r = useResizable({ initial: 300, min: 260, max: 560 })

    r.setSize(420)
    expect(r.size.value).toBe(420)

    r.setSize(9999)
    expect(r.size.value).toBe(560)

    r.setSize(10)
    expect(r.size.value).toBe(260)
  })

  it('**还要受视口限制** —— 存的是大屏的值，小屏上要收回来', () => {
    const r = useResizable({ initial: 300, min: 260, max: 1800 })
    const original = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })

    r.setSize(1800)
    expect(r.size.value).toBe(800)

    Object.defineProperty(window, 'innerWidth', { value: original, configurable: true })
  })

  it('非数字一律不理 —— 库里那份是自由 JSON，不能当它一定干净', () => {
    const r = useResizable({ initial: 300, min: 260, max: 560 })
    r.setSize(420)
    r.setSize(Number.NaN)
    expect(r.size.value).toBe(420)
  })
})

describe('边线拖拽 · 上边线', () => {
  /**
   * 原来只有下边线能拉，理由是「两个窗都锚在顶部，上边线拖不动」。
   * 那条理由只在「顶边固定」这个前提下成立 —— 现在允许顶边跟着走，
   * 医生就能从上下两头收放，而不必每次都把窗往下拽。
   *
   * **拖上边线时底边不动**：往下拖 = 顶边下移 + 高度变矮，两者的和恒等于
   * 底边的位置。做不到这一点的话，拖上边线看起来像是整个窗在往下掉。
   */
  const drag = (r: ReturnType<typeof useResizable>, from: number, to: number) => {
    r.onPointerDownTop({ clientY: from, preventDefault() {}, currentTarget: null } as never)
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: to }) as never)
    window.dispatchEvent(new MouseEvent('pointerup') as never)
  }

  // jsdom 的视口高是 768，而 clamp 还要再受视口限制 —— 不放宽的话
  // 这几条验的就变成了「撞没撞到视口上限」，而那条另有用例守着
  let viewport = 0
  beforeEach(() => {
    viewport = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: 2000, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: viewport, configurable: true })
  })

  it('往下拖：变矮，同时顶边下移 —— 底边留在原地', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom' })

    drag(r, 100, 150)

    expect(r.size.value).toBe(750)
    expect(r.offset.value).toBe(50)
    // 顶 + 高 = 底边位置，拖前拖后一样
    expect(r.offset.value + (r.size.value as number)).toBe(800)
  })

  it('往上拖：变高，顶边上移', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom' })
    drag(r, 100, 150)   // 先下移 50
    drag(r, 150, 120)   // 再上移 30

    expect(r.offset.value).toBe(20)
    expect(r.size.value).toBe(780)
  })

  it('**顶回原位就不再长高** —— 再往上拖会顶穿屏幕上沿', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom' })

    drag(r, 100, -500)

    expect(r.offset.value).toBe(0)
    expect(r.size.value).toBe(800)
  })

  it('照常受 min 限制 —— 拖到比 min 还矮就停住，顶边也跟着停', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom' })

    drag(r, 100, 900)

    expect(r.size.value).toBe(320)
    // 高度停在 320，顶边最多下移 480，否则底边会跟着往下跑
    expect(r.offset.value).toBe(480)
  })

  it('双击恢复默认时**顶边一起归位** —— 只还高度会留下一条空隙', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom' })
    drag(r, 100, 200)
    expect(r.offset.value).toBeGreaterThan(0)

    r.reset()

    expect(r.size.value).toBeNull()
    expect(r.offset.value).toBe(0)
    expect(r.style.value).toEqual({})
  })

  it('顶边没动过时不输出 marginTop —— 免得凭空多一条外边距', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom' })
    r.setSize(700)
    expect(r.style.value).toEqual({ height: '700px' })
  })
})

describe('边线拖拽 · 顶边与高度的和不许出屏', () => {
  /**
   * 两个数各自合法，和不合法。
   *
   * 线上实测：面板 `offset_top=57` + `height=967`，视口 1000 —— 底边落在 1039，
   * 最下面 39px 医生永远看不到，而**两个数分别看都通过了钳位**。
   * 拖拽路径上有「offset + size 恒等于底边」护着，恢复路径上两个数是分别落地的，
   * 没人管它们的和。
   */
  const H = 1000

  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: H, configurable: true })
  })

  it('高度上限是「视口 − 锚点」—— 浮窗顶边停在 15px，不是贴着 0', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom', anchor: 15 })
    r.setSize(9999)
    expect(r.size.value).toBe(H - 15)
  })

  it('恢复记住的布局时，顶边偏移要为高度让路', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom', anchor: 15 })
    r.setSize(967)
    r.setOffset(57)

    expect(r.offset.value + (r.size.value as number)).toBeLessThanOrEqual(H - 15)
  })

  it('顺序反过来也一样 —— 先给顶边再给高度', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom', anchor: 15 })
    r.setOffset(57)
    r.setSize(967)

    expect(r.offset.value + (r.size.value as number)).toBeLessThanOrEqual(H - 15)
  })

  it('放得下就一个数都不动 —— 收敛只在真的出屏时发生', () => {
    const r = useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom', anchor: 15 })
    r.setSize(700)
    r.setOffset(120)

    expect(r.size.value).toBe(700)
    expect(r.offset.value).toBe(120)
  })
})

describe('两个浮窗的高度联动', () => {
  /**
   * 合并态下两个窗拼成一整块（接缝的圆角和边框都去掉了）。
   * **一块砖不该有两个高度** —— 各拖各的会在底边留一道台阶，
   * 顶边各让各的会在标题栏错开一层，那时「连接在一起」就只是句口号。
   *
   * 分离之后各归各的：分开了就是两个窗，那正是分离的意思。
   */
  const make = () => useResizable({ initial: 800, min: 320, max: 2000, edge: 'bottom', anchor: 15 })

  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: 2000, configurable: true })
  })

  it('合并态下改一个的高度，另一个跟着走', () => {
    const merged = ref(true)
    const a = make(); const b = make()
    linkResizables(a, b, () => merged.value)

    a.setSize(700)
    expect(b.size.value).toBe(700)
  })

  it('反方向同样联动 —— 抽屉那条下边线也拖得动整块', () => {
    const merged = ref(true)
    const a = make(); const b = make()
    linkResizables(a, b, () => merged.value)

    b.setSize(640)
    expect(a.size.value).toBe(640)
  })

  it('**顶边偏移一起联动** —— 只同步高度会让两块的顶边错开一层', () => {
    const merged = ref(true)
    const a = make(); const b = make()
    linkResizables(a, b, () => merged.value)

    a.setSize(700)
    a.setOffset(60)
    expect(b.offset.value).toBe(60)
  })

  it('双击恢复默认时对方一起归位', () => {
    const merged = ref(true)
    const a = make(); const b = make()
    linkResizables(a, b, () => merged.value)
    a.setSize(700)

    a.reset()
    expect(b.size.value).toBeNull()
    expect(b.offset.value).toBe(0)
  })

  it('分离之后各归各的', () => {
    const merged = ref(true)
    const a = make(); const b = make()
    linkResizables(a, b, () => merged.value)
    a.setSize(700)

    merged.value = false
    a.setSize(600)
    expect(b.size.value).toBe(700)
  })

  it('**挂上来时若已是合并态，当场对齐一次** —— 布局记忆先跑，两条高度来自库里两个数', () => {
    // 恢复是一条条落地的：`panel_height` 一个数、`drawer_height` 另一个数，
    // 谁也不保证它们相等。不当场对齐的话，进工作站看到的就是一块带台阶的砖，
    // 而要等医生拖一下才会正过来。
    const merged = ref(true)
    const a = make(); const b = make()
    a.setSize(967)
    b.setSize(961)

    linkResizables(a, b, () => merged.value)

    expect(b.size.value).toBe(967)
  })

  it('**拖回去重新合并时对齐** —— 分离期间各拖各的，合回来必须还是一块砖', () => {
    const merged = ref(true)
    const a = make(); const b = make()
    linkResizables(a, b, () => merged.value)

    merged.value = false
    a.setSize(600)
    a.setOffset(40)
    b.setSize(900)

    merged.value = true
    expect(b.size.value).toBe(600)
    expect(b.offset.value).toBe(40)
  })
})
