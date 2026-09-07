import { watch, type Ref } from 'vue'

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
    const hasPos = Object.values(pos).every((p) => p.left !== null && p.top !== null)

    if (w.merged === false && hasPos) {
      parts.dock.restore({
        merged: false,
        pos: {
          panel: { left: pos.panel.left as number, top: pos.panel.top as number },
          drawer: { left: pos.drawer.left as number, top: pos.drawer.top as number },
        },
        // 规则 ②
        size: {
          panel: sizeOf(w, 'panel'),
          drawer: sizeOf(w, 'drawer'),
        },
      })
    }

    // 让恢复引发的那一轮 watch 先跑完再放开
    queueMicrotask(() => {
      restoring = false
    })
  }

  function sizeOf(w: Record<string, unknown>, key: 'panel' | 'drawer') {
    const width = num(w[`${key}_width`])
    const height = num(w[`${key}_height`])
    return width !== null && height !== null ? { width, height } : null
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
        if (!p) continue
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
