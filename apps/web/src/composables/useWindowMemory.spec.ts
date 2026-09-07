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

beforeEach(() => {
  update.mockClear()
  prefs.value = { remember_windows: true, windows: {} }
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
