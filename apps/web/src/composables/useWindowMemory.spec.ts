import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PERSIST_DEBOUNCE_MS, useWindowMemory } from './useWindowMemory'

/**
 * 浮窗布局记忆。
 *
 * 在此之前，「记住浮窗布局」这个开关是**空转**的：后端能存能读、配置页
 * 能显示能清空，但没有任何人在拖拽结束后写入。开关拨了没反应，
 * 比没有这个开关更糟 —— 医生会以为是自己没拨对。
 *
 * 这一组盯四件事：
 *   ① 关掉时既不恢复也不写；
 *   ② 恢复分离态**必须连位置一起**，否则两个窗会被拍到左上角；
 *   ③ 写入防抖，一次拖动只落一条；
 *   ④ 恢复本身不触发写回。
 */

/** 参数类型要写全：`vi.fn(async () => true)` 会把 `mock.calls[0][0]` 推成空元组 */
const update = vi.fn(async (_patch: { windows: Record<string, number | boolean> }) => true)
const prefs = ref({ remember_windows: true, windows: {} as Record<string, unknown> })

vi.mock('./usePreferences', () => ({
  usePreferences: () => ({ prefs, update }),
  currentPreferences: () => prefs.value,
}))

/** 一个够用的 useResizable 替身：只要 size 与 setSize */
function fakeResizable(initial: number | null = null) {
  const size = ref<number | null>(initial)
  const offset = ref(0)
  return {
    size,
    offset,
    setSize: (v: number) => (size.value = v),
    setOffset: (v: number) => (offset.value = v),
  }
}

function fakeDock() {
  return {
    merged: ref(true),
    placed: ref({ drawer: true, panel: true } as Record<string, boolean>),
    pos: ref({ drawer: { left: 0, top: 0 }, panel: { left: 0, top: 0 } }),
    size: ref<Record<string, { width: number; height: number } | null>>({ drawer: null, panel: null }),
    restore: vi.fn(),
  }
}

function harness() {
  const parts = {
    panelWidth: fakeResizable(),
    drawerWidth: fakeResizable(),
    panelHeight: fakeResizable(),
    drawerHeight: fakeResizable(),
    dock: fakeDock(),
  }
  return { parts, memory: useWindowMemory(parts) }
}

/**
 * 恢复分离态现在要校验「整块在不在视口里」，所以每条用例都得有个视口。
 * jsdom 缺省 1024×768 装不下这些用例里的坐标 —— 不给个大屏的话，
 * 验的就全变成「出屏被拒」了。
 */
function viewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

beforeEach(() => {
  update.mockClear()
  prefs.value = { remember_windows: true, windows: {} }
  viewport(1920, 1080)
  vi.useFakeTimers()
})

describe('浮窗记忆 · 恢复', () => {
  it('把记住的尺寸铺回四条边', () => {
    prefs.value.windows = {
      panel_width: 420, drawer_width: 1100,
      panel_height: 700, drawer_height: 680,
    }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.panelWidth.size.value).toBe(420)
    expect(parts.drawerWidth.size.value).toBe(1100)
    expect(parts.panelHeight.size.value).toBe(700)
    expect(parts.drawerHeight.size.value).toBe(680)
  })

  it('**恢复分离态时连位置一起给** —— 只给 merged 会把两个窗拍到 (0,0)', () => {
    prefs.value.windows = {
      merged: false,
      panel_left: 980, panel_top: 60,
      drawer_left: 300, drawer_top: 60,
      panel_width: 420, panel_height: 700,
      drawer_width: 1100, drawer_height: 680,
    }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.dock.restore).toHaveBeenCalledTimes(1)
    const arg = parts.dock.restore.mock.calls[0][0]
    expect(arg.merged).toBe(false)
    expect(arg.pos.panel).toEqual({ left: 980, top: 60 })
    expect(arg.pos.drawer).toEqual({ left: 300, top: 60 })
    // 脱离 flex 之后尺寸不冻就会按内容撑开，见 useDockedWindows 的 size 注释
    expect(arg.size.panel).toEqual({ width: 420, height: 700 })
  })

  it('存了 merged=false 却没存位置时**不恢复分离态** —— 宁可回默认停靠', () => {
    // 只可能出现在手工 PUT 或旧数据上。分离而没有位置 = 左上角叠成一坨，
    // 那比「没记住」更让人以为是坏了。
    prefs.value.windows = { merged: false, panel_width: 420 }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.dock.restore).not.toHaveBeenCalled()
    // 尺寸照常恢复 —— 那一半是好的，不因为另一半缺失就一起丢掉
    expect(parts.panelWidth.size.value).toBe(420)
  })

  it('开关关掉时什么都不恢复 —— 每次进来都回默认布局（AC-PREF-006）', () => {
    prefs.value = {
      remember_windows: false,
      windows: { panel_width: 420, merged: false, panel_left: 980, panel_top: 60 },
    }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.panelWidth.size.value).toBeNull()
    expect(parts.dock.restore).not.toHaveBeenCalled()
  })
})

describe('浮窗记忆 · 写入', () => {
  it('拖完才落一条 —— 拖动过程中尺寸每帧都在变', async () => {
    const { parts, memory } = harness()
    memory.watchAndPersist()

    // 模拟一次拖拽：连续改十几次
    for (let w = 300; w <= 420; w += 10) {
      parts.panelWidth.size.value = w
      await nextTick()
    }
    expect(update).not.toHaveBeenCalled()

    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    await nextTick()

    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0].windows.panel_width).toBe(420)
  })

  it('合并/分离切换也要落 —— 它和尺寸一样是布局的一部分', async () => {
    const { parts, memory } = harness()
    memory.watchAndPersist()

    parts.dock.merged.value = false
    parts.dock.pos.value = { drawer: { left: 300, top: 60 }, panel: { left: 980, top: 60 } }
    await nextTick()
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    await nextTick()

    const sent = update.mock.calls[0]![0].windows
    expect(sent.merged).toBe(false)
    expect(sent.panel_left).toBe(980)
    expect(sent.drawer_top).toBe(60)
  })

  it('**恢复不算改动** —— 否则每次进工作站都白写一次库', async () => {
    prefs.value.windows = { panel_width: 420, drawer_width: 1100 }

    const { memory } = harness()
    // **故意先挂 watcher 再恢复。** 第一版写成「先恢复再挂」，那样 watcher
    // 根本没机会看见恢复引发的变化 —— 拆掉 `restoring` 守卫这条用例照样绿，
    // 变异验证当场把它抓出来了。真正要守的是「无论 watcher 挂没挂上，
    // 恢复都不产生写入」，因为这两句的先后顺序只是调用点的约定。
    memory.watchAndPersist()
    memory.restore()

    await nextTick()
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS * 2)
    await nextTick()

    expect(update).not.toHaveBeenCalled()
  })

  it('开关关掉时不写 —— 拖了也不该留下痕迹（AC-PREF-006）', async () => {
    prefs.value = { remember_windows: false, windows: {} }

    const { parts, memory } = harness()
    memory.watchAndPersist()

    parts.panelWidth.size.value = 420
    await nextTick()
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    await nextTick()

    expect(update).not.toHaveBeenCalled()
  })

  it('没拖过的边不写进去 —— null 是「交给 CSS」，不是一个尺寸', async () => {
    const { parts, memory } = harness()
    memory.watchAndPersist()

    parts.panelWidth.size.value = 420
    await nextTick()
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    await nextTick()

    const sent = update.mock.calls[0]![0].windows
    expect(sent).toHaveProperty('panel_width')
    expect(sent).not.toHaveProperty('drawer_width')
  })
})

describe('浮窗记忆 · 上边线的位置', () => {
  /**
   * 上边线拖出来的那段外边距也是布局的一部分。不记的话，医生把窗从上方
   * 收短，刷新一下又顶回去了 —— 而其他三条边都记住了，
   * **只有一条边不记比全都不记更像坏了**。
   */
  it('顶边让出的距离要存', async () => {
    const { parts, memory } = harness()
    memory.watchAndPersist()

    parts.panelHeight.offset.value = 120
    await nextTick()
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    await nextTick()

    expect(update.mock.calls[0]![0].windows.panel_offset_top).toBe(120)
  })

  it('恢复时铺回去', () => {
    prefs.value.windows = { panel_offset_top: 120, drawer_offset_top: 80 }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.panelHeight.offset.value).toBe(120)
    expect(parts.drawerHeight.offset.value).toBe(80)
  })

  it('顶边没动过时不写 0 进去 —— 那是默认值，存了只占键位', async () => {
    const { parts, memory } = harness()
    memory.watchAndPersist()

    parts.panelWidth.size.value = 420
    await nextTick()
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    await nextTick()

    expect(update.mock.calls[0]![0].windows).not.toHaveProperty('panel_offset_top')
  })
})

describe('浮窗记忆 · 只存真摆过的窗', () => {
  /**
   * 面板拖走时抽屉是关着的 —— 它没有位置也没有尺寸。原来的 `snapshot`
   * 照样给它写了一对坐标，那是个**假坐标**：下次恢复会被当真，
   * 于是恢复出一个「有位置、没尺寸」的分离态，两个窗按内容炸开。
   *
   * 存的东西必须是量出来的，不能是顺手填的。
   */
  it('没摆过的窗不写位置', async () => {
    const { parts, memory } = harness()
    // 先挂 watcher 再改状态 —— 反过来的话 watcher 看不见这些变化，
    // 这条用例会因为「压根没触发写入」而红，测的就不是它要测的东西了
    memory.watchAndPersist()
    parts.dock.merged.value = false
    parts.dock.placed.value = { panel: true, drawer: false }
    parts.dock.pos.value = { panel: { left: 800, top: 100 }, drawer: { left: 0, top: 0 } }

    await nextTick()
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    await nextTick()

    const sent = update.mock.calls[0]![0].windows
    expect(sent.panel_left).toBe(800)
    expect(sent).not.toHaveProperty('drawer_left')
    expect(sent).not.toHaveProperty('drawer_top')
  })

  it('**只有位置没有尺寸时不恢复分离态** —— 那会让两个窗按内容炸开', () => {
    prefs.value.windows = {
      merged: false,
      panel_left: 240, panel_top: 556,
      drawer_left: 700, drawer_top: 375,
      // 宽高一个都没有 —— 正是「面板拖走时抽屉没开着」留下的那份
    }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.dock.restore).not.toHaveBeenCalled()
  })

  it('缺尺寸的那个不参与「装不装得下」的判断 —— 它压根还没摆', () => {
    // 只有面板是完整的，抽屉等 placeBeside。拿一个不存在的矩形去判出屏，
    // 会把一份好数据当成坏的丢掉。
    viewport(1280, 800)
    prefs.value.windows = {
      merged: false,
      panel_left: 900, panel_top: 20, panel_width: 300, panel_height: 700,
      drawer_left: 0, drawer_top: 20,
    }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.dock.restore).toHaveBeenCalledTimes(1)
  })

  it('锚点那个窗齐全就照常恢复，缺的那个留给 placeBeside', () => {
    prefs.value.windows = {
      merged: false,
      panel_left: 800, panel_top: 100, panel_width: 300, panel_height: 900,
      drawer_left: 0, drawer_top: 100,
    }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.dock.restore).toHaveBeenCalledTimes(1)
    const arg = parts.dock.restore.mock.calls[0]![0]
    expect(arg.size.panel).toEqual({ width: 300, height: 900 })
    expect(arg.size.drawer).toBeNull()
  })
})

describe('浮窗记忆 · 铺回来的必须是完整能看见的一块', () => {
  /**
   * 线上实测（视口 1600×1000，`da.aaronhealth.cn` 一进来就是这样）：
   *
   * | | left | top | 宽 | 高 | 右边 | 底边 |
   * | --- | --- | --- | --- | --- | --- | --- |
   * | 抽屉 | 399 | 303 | 1406 | 961 | **1805** | **1264** |
   * | 面板 | 1440 | 72 | 319 | 967 | 1759 | 1039 |
   *
   * 两个窗互相压着，右边和底边都甩出屏幕。演示一打开就是这个样子。
   * 三条独立的错凑出来的，各修各的。
   */

  it('**抽屉的自有宽 = 组合总宽 − 面板宽** —— drawer_width 存的是整块的宽', () => {
    // 抽屉是 flex:1，它的左边线就是整块的左边线，所以那条边拖的是**组合总宽**。
    // 原样当成抽屉自己的宽度铺回去，抽屉就正好宽出一个面板，
    // 整个压在面板身上、右边线甩出屏幕（上表 1805）。
    prefs.value.windows = {
      merged: false,
      panel_left: 1200, panel_top: 20, panel_width: 320, panel_height: 900,
      drawer_left: 100, drawer_top: 20, drawer_width: 1420, drawer_height: 900,
    }

    const { parts, memory } = harness()
    memory.restore()

    const arg = parts.dock.restore.mock.calls[0]![0]
    expect(arg.size.drawer).toEqual({ width: 1100, height: 900 })
  })

  it('分离态铺回来时顶边偏移清零 —— 位置是绝对的，margin 是多余的一层', () => {
    // 实时拖拽路径上 `watch(dock.merged)` 就是这么做的（分离那一刻把 offset 折进位置）。
    // 恢复路径漏了这一条，于是 `top:15` 的窗渲染在 72，两个窗错开 57px。
    prefs.value.windows = {
      merged: false,
      panel_left: 1200, panel_top: 20, panel_width: 320, panel_height: 900,
      drawer_left: 100, drawer_top: 20, drawer_width: 1420, drawer_height: 900,
      panel_offset_top: 57, drawer_offset_top: 288,
    }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.panelHeight.offset.value).toBe(0)
    expect(parts.drawerHeight.offset.value).toBe(0)
  })

  it('合并态照常保留顶边偏移 —— 那是医生从上方收短的，不是分离的残留', () => {
    prefs.value.windows = { panel_height: 700, panel_offset_top: 60 }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.panelHeight.offset.value).toBe(60)
  })

  it('**有一条边出屏就整份作废，回默认合并** —— 默认必须是完整看得见的一块', () => {
    viewport(1600, 1000)
    prefs.value.windows = {
      merged: false,
      panel_left: 1440, panel_top: 72, panel_width: 319, panel_height: 967,
      drawer_left: 399, drawer_top: 303, drawer_width: 1406, drawer_height: 961,
    }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.dock.restore).not.toHaveBeenCalled()
  })

  it('作废的是这一次的铺放，**不擦掉库里那份** —— 换回大屏还得用它', () => {
    // 医生在 27 寸上摆好，回家开笔记本装不下 —— 这次回默认，
    // 但不能顺手把 27 寸上那份删了。
    viewport(1280, 800)
    prefs.value.windows = {
      merged: false,
      panel_left: 2000, panel_top: 40, panel_width: 320, panel_height: 900,
      drawer_left: 400, drawer_top: 40, drawer_width: 1920, drawer_height: 900,
    }

    const { memory } = harness()
    memory.restore()

    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS * 2)
    expect(update).not.toHaveBeenCalled()
  })

  it('整块都在视口里就照常铺', () => {
    viewport(1600, 1000)
    prefs.value.windows = {
      merged: false,
      panel_left: 1200, panel_top: 15, panel_width: 320, panel_height: 900,
      drawer_left: 120, drawer_top: 15, drawer_width: 1400, drawer_height: 900,
    }

    const { parts, memory } = harness()
    memory.restore()

    expect(parts.dock.restore).toHaveBeenCalledTimes(1)
  })
})
