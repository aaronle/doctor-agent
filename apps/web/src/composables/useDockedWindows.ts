import { computed, ref } from 'vue'

/**
 * 两个浮窗的「合并 / 分离」与拖动。
 *
 * 默认**合并**（就是现在这样：AI 助手 + 医生智能体拼成一整块，靠右停靠）。
 * 拖标题栏可以把它们拖开；拖回去靠近了自动吸附，重新合成一块。
 *
 * ## 三条规则
 *
 * **① 合并态下拖任一标题栏，两个一起走。** 合并的意思就是「它们现在是一个
 * 东西」—— 拖一个另一个不动，那叫叠在一起，不叫合并。
 *
 * **② 吸附判据是「拖动中的窗边线离对方边线 < 40px」**，松手前给虚线预告。
 * 没有预告的吸附会让人觉得窗口自己乱跑。
 *
 * **③ 拖出屏幕要钳回来。** 和桌面卡通同一条规矩：浮动的东西必须永远够得着。
 * 钳的是**标题栏**而不是整个窗口 —— 允许窗体下半部分出屏（那只是内容），
 * 但标题栏一旦出去就再也抓不住了。
 *
 * ## 坐标系
 *
 * 位置写在**外层壳**上，而壳**不参与字号缩放**（见 `useFontScale` 文件头）。
 * 指针坐标与壳的坐标因此始终是同一套，拖拽算式里不需要任何缩放系数。
 */

export type WindowKey = 'drawer' | 'panel'

export interface WindowPos {
  left: number
  top: number
}

/** 吸附距离。太小吸不上，太大会在还想分开的时候硬把它拽回去 */
export const SNAP_PX = 40

/** 标题栏高度。钳位时至少要留这么多在屏幕里 */
const HEADER_H = 44

export function useDockedWindows() {
  /** 合并态：两个窗拼在一起，位置由 CSS 决定（靠右停靠） */
  const merged = ref(true)

  /** 分离后各自的位置。合并态下不用 */
  const pos = ref<Record<WindowKey, WindowPos>>({
    drawer: { left: 0, top: 0 },
    panel: { left: 0, top: 0 },
  })

  /**
   * 分离那一刻冻住的尺寸。
   *
   * **不冻会当场炸开。** 两个窗在合并态是 flex 子项 —— 抽屉 `flex:1`、
   * 高度由父容器给。一改成 `position:fixed`，这些约束全没了，
   * 它们改按内容撑开：实测抽屉从 866×985 变成 1471×1703，高度直接超出屏幕。
   */
  const size = ref<Record<WindowKey, { width: number; height: number } | null>>({
    drawer: null,
    panel: null,
  })

  /** 正在拖谁 */
  const dragging = ref<WindowKey | null>(null)
  /** 松手就会吸附 —— 用来画那条虚线预告 */
  const willSnap = ref(false)

  let origin: { x: number; y: number; self: WindowPos; other: WindowPos } | null = null
  let box: { self: DOMRect; other: DOMRect } | null = null

  const styleFor = (key: WindowKey) =>
    computed(() => {
      if (merged.value) return {}
      const s = size.value[key]
      return {
        position: 'fixed' as const,
        left: `${pos.value[key].left}px`,
        top: `${pos.value[key].top}px`,
        right: 'auto' as const,
        ...(s ? { width: `${s.width}px`, height: `${s.height}px`, flex: 'none' } : {}),
      }
    })

  function clampTitleBar(p: WindowPos, width: number): WindowPos {
    // 只保证**标题栏**留在屏幕里：窗体下半部分出屏只是看不全内容，
    // 标题栏出屏就再也抓不住这个窗口了。
    const maxLeft = Math.max(0, window.innerWidth - Math.min(width, 160))
    const maxTop = Math.max(0, window.innerHeight - HEADER_H)
    return {
      left: Math.min(Math.max(-Math.max(0, width - 160), p.left), maxLeft),
      top: Math.min(Math.max(0, p.top), maxTop),
    }
  }

  /**
   * 开始拖某个窗的标题栏。
   *
   * `selfEl` / `otherEl` 是两个**外层壳**的元素，用来读当前位置与判断吸附。
   */
  function startDrag(key: WindowKey, e: PointerEvent, selfEl: HTMLElement, otherEl: HTMLElement | null) {
    const selfRect = selfEl.getBoundingClientRect()
    const otherRect = otherEl?.getBoundingClientRect() ?? selfRect
    box = { self: selfRect, other: otherRect }

    // 从合并态起拖：先把两个窗**当前的实际位置与尺寸**记下来。
    // 位置不记，一松开 CSS 停靠它们会瞬移到 (0,0)；
    // 尺寸不记，脱离 flex 之后会按内容撑开（见 `size` 的注释）。
    if (merged.value) {
      const other: WindowKey = key === 'drawer' ? 'panel' : 'drawer'
      pos.value = {
        [key]: { left: selfRect.left, top: selfRect.top },
        [other]: { left: otherRect.left, top: otherRect.top },
      } as Record<WindowKey, WindowPos>
      size.value = {
        [key]: { width: selfRect.width, height: selfRect.height },
        [other]: { width: otherRect.width, height: otherRect.height },
      } as Record<WindowKey, { width: number; height: number }>
    }

    origin = {
      x: e.clientX,
      y: e.clientY,
      self: { ...pos.value[key] },
      other: { ...pos.value[key === 'drawer' ? 'panel' : 'drawer'] },
    }
    dragging.value = key
    ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
    e.preventDefault()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  function onMove(e: PointerEvent) {
    if (!origin || !dragging.value || !box) return
    const key = dragging.value
    const other: WindowKey = key === 'drawer' ? 'panel' : 'drawer'
    const dx = e.clientX - origin.x
    const dy = e.clientY - origin.y

    const next = { ...pos.value }
    next[key] = clampTitleBar({ left: origin.self.left + dx, top: origin.self.top + dy }, box.self.width)

    if (merged.value) {
      // 规则 ①：合并态下两个一起走
      next[other] = clampTitleBar(
        { left: origin.other.left + dx, top: origin.other.top + dy },
        box.other.width,
      )
      willSnap.value = false
    } else {
      // 规则 ②：拖动中的窗离对方够近就预告吸附
      willSnap.value = nearEnough(next[key], box.self, pos.value[other], box.other)
    }
    pos.value = next
  }

  function onUp() {
    if (dragging.value && !merged.value && willSnap.value) {
      merged.value = true       // 吸附：回到 CSS 停靠，两窗重新拼成一块
      size.value = { drawer: null, panel: null }   // 冻住的尺寸一并释放
    } else if (dragging.value && merged.value) {
      // 从合并态拖出来 —— 拖动本身就是「分离」这个动作
      merged.value = false
    }
    dragging.value = null
    willSnap.value = false
    origin = null
    box = null
    window.removeEventListener('pointermove', onMove)
  }

  /** 两个窗是不是贴到一起了：横向缝隙够小，且纵向有重叠 */
  function nearEnough(a: WindowPos, aBox: DOMRect, b: WindowPos, bBox: DOMRect) {
    const gapRight = Math.abs(a.left + aBox.width - b.left)   // a 在 b 左边
    const gapLeft = Math.abs(b.left + bBox.width - a.left)    // a 在 b 右边
    const overlapV = a.top < b.top + bBox.height && b.top < a.top + aBox.height
    return overlapV && Math.min(gapRight, gapLeft) < SNAP_PX
  }

  /** 双击标题栏：回到默认停靠位置。拖乱了有一键还原，不用刷新页面 */
  function resetLayout() {
    merged.value = true
    size.value = { drawer: null, panel: null }
    dragging.value = null
    willSnap.value = false
  }

  return { merged, pos, size, dragging, willSnap, styleFor, startDrag, resetLayout }
}
