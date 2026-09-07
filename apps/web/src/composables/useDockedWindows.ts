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

  /**
   * 这个窗的几何有没有真正量过。
   *
   * 桌面端一进来**只有医生智能体**，AI 助手是收起的 —— 这时拖走面板，
   * `startDrag` 拿不到抽屉的元素。原来的写法把自己的几何抄给了它，
   * 于是医生再点开 AI 助手时，抽屉是 300px 宽、还和面板叠在一起。
   *
   * **没渲染 ≠ 和我一样。** 没量过就标成未摆放，等它真开了再摆（`placeBeside`）。
   */
  const placed = ref<Record<WindowKey, boolean>>({ drawer: true, panel: true })

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
        // **另一个窗没渲染时它的尺寸是「未知」**，不是「和我一样」——
        // 抄过去的话，它一打开就是 300px 宽并且和我叠在一起
        [other]: otherEl ? { width: otherRect.width, height: otherRect.height } : null,
      } as Record<WindowKey, { width: number; height: number } | null>
      placed.value = { ...placed.value, [key]: true, [other]: !!otherEl }
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
      placed.value = { drawer: true, panel: true }
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

  /**
   * 把一个**还没摆过**的窗贴到另一个窗旁边。
   *
   * 用在「面板已经拖走、医生这才点开 AI 助手」这条路径上：抽屉这时没有
   * 自己的几何，不摆的话它会落在 (0,0) 或者顶着面板的旧尺寸。
   * 它们本来就是拼在一起的一对，所以贴边是最不意外的落点 ——
   * 抽屉在左、面板在右，与合并态的排布一致。
   *
   * **已经摆过的不动。** 医生自己拖过的位置不能被一次「打开」覆盖掉。
   */
  function placeBeside(
    key: WindowKey,
    anchorKey: WindowKey,
    natural: { width: number; height: number },
  ) {
    if (merged.value || placed.value[key]) return
    const anchor = pos.value[anchorKey]
    const left = key === 'drawer'
      ? anchor.left - natural.width          // 抽屉在面板左边
      : anchor.left + (size.value[anchorKey]?.width ?? natural.width)
    size.value = { ...size.value, [key]: { ...natural } }
    // 摆的时候照样钳位：面板贴着屏幕左边时，抽屉不能整个甩到屏幕外
    pos.value = { ...pos.value, [key]: clampTitleBar({ left, top: anchor.top }, natural.width) }
    placed.value = { ...placed.value, [key]: true }
  }

  /**
   * 铺回上次记住的布局（`useWindowMemory` 在进工作站时调）。
   *
   * **位置照样要钳。** 存下来的是上次那块屏幕上的坐标；换台小屏打开，
   * 标题栏可能整个在屏幕外 —— 那个窗就再也抓不回来了。
   * 和拖拽走同一个 `clampTitleBar`，不另写一套。
   *
   * 恢复成合并态时把冻住的尺寸一并释放：合并态的尺寸由 CSS 停靠决定，
   * 留着 `size` 会让 `styleFor` 继续输出 `width/flex:none`，把停靠撑歪。
   */
  function restore(state: {
    merged: boolean
    pos: Record<WindowKey, WindowPos>
    size: Record<WindowKey, { width: number; height: number } | null>
  }) {
    merged.value = state.merged
    if (state.merged) {
      size.value = { drawer: null, panel: null }
      placed.value = { drawer: true, panel: true }
      return
    }
    // **按实际有没有尺寸来定，不能一律 true。** 存下来的分离态可能缺一个窗的
    // 宽高（面板拖走时抽屉是关着的），一律标成「摆过了」会让 `placeBeside`
    // 不再管它 —— 两个窗双双失去冻结尺寸，按内容炸开
    // （实测抽屉 900×1803、面板缩到 368）。
    placed.value = { drawer: !!state.size.drawer, panel: !!state.size.panel }
    size.value = { ...state.size }
    pos.value = {
      drawer: clampTitleBar(state.pos.drawer, state.size.drawer?.width ?? 900),
      panel: clampTitleBar(state.pos.panel, state.size.panel?.width ?? 300),
    }
  }

  /** 双击标题栏：回到默认停靠位置。拖乱了有一键还原，不用刷新页面 */
  function resetLayout() {
    merged.value = true
    size.value = { drawer: null, panel: null }
    placed.value = { drawer: true, panel: true }
    dragging.value = null
    willSnap.value = false
  }

  return { merged, pos, size, placed, dragging, willSnap, styleFor, startDrag, resetLayout, restore, placeBeside }
}
