import { watch, type Ref } from 'vue'

import { DRAWER_MIN_WIDTH } from './useDockedWindows'
import { usePreferences } from './usePreferences'

/**
 * 浮窗布局的记忆：拖完自动存，下次进工作站恢复。
 *
 * ## 为什么单独一个文件
 *
 * 它要同时碰四个 `useResizable` 和一个 `useDockedWindows`，还要和偏好双向来往。
 * 塞进 `AiEmrFloat.vue` 会再加八十行，而那个文件已经两千七百行；更要紧的是
 * 这里有**四条容易写错的规则**，单独放才测得住（见 `useWindowMemory.spec.ts`）。
 *
 * ## 四条规则
 *
 * **① 恢复分离态必须连位置一起。** `useDockedWindows` 在 `merged=false` 时
 * 完全按 `pos` 定位，而 `pos` 的初值是 `{left:0, top:0}` —— 只恢复 `merged`
 * 不恢复位置，两个窗会一起被拍到屏幕左上角叠成一坨。缺位置时**宁可回默认停靠**。
 *
 * **② 尺寸要同时给 `dock.size`。** 分离态下两个窗脱离 flex，尺寸不冻就按内容
 * 撑开（实测抽屉 866×985 → 1471×1703）。合并态用 `useResizable`，分离态用
 * `dock.size`，两者是同一组数字的两种用法。
 *
 * **③ 写入防抖。** 拖动过程中尺寸每帧都在变，不防抖就是一次拖拽几十个 PUT。
 *
 * **④ 恢复不算改动。** 恢复本身会改 ref，watch 会跟着触发 —— 不挡住的话
 * 每次进工作站都白写一次库，而写进去的和读出来的是同一份东西。
 *
 * ## 铺回来的必须是「完整看得见的一块」
 *
 * 上面四条都成立，铺出来的东西仍然可以是残的。线上实测（视口 1600×1000）：
 *
 * | | left | top | 宽 | 高 | 右边 | 底边 |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | 抽屉 | 399 | 303 | 1406 | 961 | **1805** | **1264** |
 * | 面板 | 1440 | 72 | 319 | 967 | 1759 | 1039 |
 *
 * 两个窗互相压着，右边和底边一起甩出屏幕 —— 演示一打开就是这个样子。
 * 三条独立的错凑出来的，见 `sizeOf`（抽屉宽用错了数）、`restore` 里的
 * 清零（顶边偏移在分离态是多余的一层）与 `fitsOnScreen`（兜底）。
 */

/** 攒这么久没有新变化才写一次。一次拖拽的抬手间隔远小于它 */
export const PERSIST_DEBOUNCE_MS = 600

export interface SizeSlot {
  size: Ref<number | null>
  setSize: (v: number) => void
  /** 顶边让出的距离。只有两条高度边有（拖上边线改的就是它） */
  offset?: Ref<number>
  setOffset?: (v: number) => void
}

export interface WindowPos {
  left: number
  top: number
}

export interface DockSlot {
  merged: Ref<boolean>
  /** 每个窗的几何是不是真量过。没量过的不存 —— 存了下次会被当真 */
  placed: Ref<Record<string, boolean>>
  pos: Ref<Record<string, WindowPos>>
  size: Ref<Record<string, { width: number; height: number } | null>>
  restore: (state: {
    merged: boolean
    pos: Record<string, WindowPos>
    size: Record<string, { width: number; height: number } | null>
  }) => void
}

export interface WindowParts {
  panelWidth: SizeSlot
  drawerWidth: SizeSlot
  panelHeight: SizeSlot
  drawerHeight: SizeSlot
  dock: DockSlot
}

/** 几何值里成对的四条边，`偏好键 → 哪个 slot` */
const EDGES = [
  ['panel_width', 'panelWidth'],
  ['drawer_width', 'drawerWidth'],
  ['panel_height', 'panelHeight'],
  ['drawer_height', 'drawerHeight'],
] as const

/**
 * 上边线让出的距离。只有两条高度边有。
 *
 * 它也是布局的一部分：不记的话医生把窗从上方收短、刷新一下又顶回去了，
 * 而另外三条边都记住了 —— **只有一条边不记比全都不记更像坏了**。
 */
const OFFSETS = [
  ['panel_offset_top', 'panelHeight'],
  ['drawer_offset_top', 'drawerHeight'],
] as const

export function useWindowMemory(parts: WindowParts) {
  const prefsApi = usePreferences()
  /** 规则 ④：恢复期间挡住写回 */
  let restoring = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const enabled = () => prefsApi.prefs.value.remember_windows !== false
  const stored = () => (prefsApi.prefs.value.windows ?? {}) as Record<string, unknown>

  const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null)

  /** 进工作站时铺一次。开关关掉时**什么都不做**，回默认布局（AC-PREF-006） */
  function restore() {
    if (!enabled()) return
    const w = stored()
    restoring = true

    for (const [key, slot] of EDGES) {
      const v = num(w[key])
      // `setSize` 自己会钳 —— 存的是大屏上的值，换台小屏打开必须收回来，
      // 否则浮窗把整个页面顶出去，而医生根本不知道是「记住的布局」干的
      if (v !== null) parts[slot].setSize(v)
    }
    for (const [key, slot] of OFFSETS) {
      const v = num(w[key])
      if (v !== null) parts[slot].setOffset?.(v)
    }

    // 规则 ①：位置齐了才恢复分离态
    const pos = {
      panel: { left: num(w.panel_left), top: num(w.panel_top) },
      drawer: { left: num(w.drawer_left), top: num(w.drawer_top) },
    }
    const at = (k: 'panel' | 'drawer') =>
      pos[k].left !== null && pos[k].top !== null
        ? { left: pos[k].left as number, top: pos[k].top as number }
        : null
    const dim = { panel: sizeOf(w, 'panel'), drawer: sizeOf(w, 'drawer') }

    // 规则 ②的另一半：**至少要有一个窗是完整的**（位置 + 尺寸齐全）。
    // 只有位置没有尺寸的分离态一恢复就是两个窗按内容炸开 ——
    // 那份数据来自「面板拖走时抽屉还关着」，不是医生真摆成那样。
    const anchor = (['panel', 'drawer'] as const).find((k) => at(k) && dim[k])

    if (w.merged === false && anchor && fitsOnScreen(at, dim)) {
      const fallback = at(anchor) as { left: number; top: number }
      parts.dock.restore({
        merged: false,
        // 缺位置的那个先借锚点的坐标占位 —— 它的 size 是 null，
        // 会被标成「没摆过」，等它真打开时由 `placeBeside` 摆到正确的地方
        pos: { panel: at('panel') ?? fallback, drawer: at('drawer') ?? fallback },
        size: dim,
      })
      // **分离态里顶边偏移是多余的一层。** `pos.top` 是绝对坐标，再叠一段
      // `margin-top` 就是两头都算：存的 `top:15` 会渲染在 72，两个窗错开 57px。
      // 实时拖拽路径上 `watch(dock.merged)` 就是这么清的，恢复路径漏了这一条。
      parts.panelHeight.setOffset?.(0)
      parts.drawerHeight.setOffset?.(0)
    }

    // 让恢复引发的那一轮 watch 先跑完再放开
    queueMicrotask(() => {
      restoring = false
    })
  }

  function sizeOf(w: Record<string, unknown>, key: 'panel' | 'drawer') {
    const width = num(w[`${key}_width`])
    const height = num(w[`${key}_height`])
    if (width === null || height === null) return null
    if (key === 'panel') return { width, height }
    // **`drawer_width` 存的是「组合总宽」，不是抽屉自己的宽。**
    //
    // 抽屉是 `flex:1`，它没有自己的宽度 —— 那条左边线就是整块的左边线，
    // 拖它调的是**面板 + 抽屉**的总宽（见 AiEmrFloat 里 `drawerSize` 的注释）。
    // 而 `dock.size.drawer` 要的是抽屉自己那一块。
    //
    // 原样铺回去，抽屉就正好宽出一个面板：整个压在面板身上，右边线甩出屏幕。
    // 线上那份 1406 = 1087（抽屉）+ 319（面板），右边线因此落在 1805，
    // 而视口只有 1600。`placeIfUndocked` 走的是同一个算式，两处必须一致。
    const panel = num(w.panel_width) ?? 0
    return { width: Math.max(DRAWER_MIN_WIDTH, width - panel), height }
  }

  /**
   * 这份记忆铺出来还看得全吗。
   *
   * **默认必须是完整看得见的一块** —— 一条边出屏，那就不再是「记住的布局」，
   * 而是一个医生够不着也修不好的残局（浮窗没有「窗口 → 整理」菜单）。
   * 有一条边出屏就整份作废，回默认合并停靠。
   *
   * **作废的只是这一次的铺放，不擦库里那份。** 医生在 27 寸上摆好、回家开
   * 笔记本装不下，这次回默认是对的；顺手把 27 寸上那份删掉就不对了。
   *
   * 缺尺寸的那个不参与判断：它压根还没摆（`placeBeside` 稍后才给它位置），
   * 拿一个不存在的矩形去判出屏，会把一份好数据当成坏的丢掉。
   */
  function fitsOnScreen(
    at: (k: 'panel' | 'drawer') => WindowPos | null,
    dim: Record<'panel' | 'drawer', { width: number; height: number } | null>,
  ) {
    for (const key of ['panel', 'drawer'] as const) {
      const p = at(key)
      const s = dim[key]
      if (!p || !s) continue
      if (p.left < 0 || p.top < 0) return false
      if (p.left + s.width > window.innerWidth) return false
      if (p.top + s.height > window.innerHeight) return false
    }
    return true
  }

  /** 当前布局的快照。**没拖过的边不写** —— `null` 是「交给 CSS」，不是一个尺寸 */
  function snapshot(): Record<string, number | boolean> {
    const out: Record<string, number | boolean> = {}
    for (const [key, slot] of EDGES) {
      const v = parts[slot].size.value
      if (v !== null) out[key] = Math.round(v)
    }
    for (const [key, slot] of OFFSETS) {
      const v = parts[slot].offset?.value ?? 0
      // 0 是默认值，写进去只占键位（`windows` 有键数上限）
      if (v > 0) out[key] = Math.round(v)
    }
    out.merged = parts.dock.merged.value
    if (!parts.dock.merged.value) {
      for (const key of ['panel', 'drawer'] as const) {
        const p = parts.dock.pos.value[key]
        // **没摆过的窗不写位置。** 它那对坐标是顺手填的，不是量出来的；
        // 写进去下次恢复会被当真，于是恢复出一个「有位置、没尺寸」的分离态，
        // 两个窗按内容炸开。存的东西必须是量出来的。
        if (!p || parts.dock.placed.value[key] === false) continue
        out[`${key}_left`] = Math.round(p.left)
        // top 不允许为负 —— 标题栏跑到屏幕上方就再也抓不回来了。
        // 前端 clampTitleBar 已经钳过，这里兜一道，免得把 400 打到医生脸上
        out[`${key}_top`] = Math.max(0, Math.round(p.top))
      }
    }
    return out
  }

  function schedulePersist() {
    if (!enabled() || restoring) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      // 失败不管：`update` 内部已经保证本机值不回滚、只挂一条提示。
      // 布局没同步上去的后果仅仅是换台电脑要重摆一次
      void prefsApi.update({ windows: snapshot() })
    }, PERSIST_DEBOUNCE_MS)
  }

  /** 挂 watch。与 `restore()` 分开调，是为了让「先恢复再开始监听」这个顺序显式可见 */
  function watchAndPersist() {
    watch(
      () => [
        parts.panelWidth.size.value,
        parts.drawerWidth.size.value,
        parts.panelHeight.size.value,
        parts.drawerHeight.size.value,
        parts.panelHeight.offset?.value,
        parts.drawerHeight.offset?.value,
        parts.dock.merged.value,
        parts.dock.pos.value,
      ],
      schedulePersist,
      { deep: true },
    )
  }

  return { restore, watchAndPersist, snapshot }
}
