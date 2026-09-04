import { computed, ref } from 'vue'

/**
 * 浮窗的边线拖拽改尺寸。
 *
 * 两条边可拉，各自的方向都是「边线远离锚点 = 变大」：
 *
 * | 边 | 改什么 | 往哪拖变大 | 为什么只有这一条 |
 * | --- | --- | --- | --- |
 * | `left` | `width` | **往左** | 浮窗靠右停靠，右边贴着屏幕，拖不动 |
 * | `bottom` | `height` | **往下** | 浮窗锚在顶部（top:15px），上边线同理拖不动 |
 *
 * 方向是这里唯一容易搞反的地方，两条各有测试钉着。
 *
 * 和 `useDraggable` 分开写，不合并：那个改的是 `left/top`（元素去哪），
 * 这个改的是尺寸（元素多大），共用的只有「按住指针跟着动」这层壳。
 * 硬合成一个会得到一个带 `mode` 开关的函数，两条路径各自都更难读。
 *
 * 而 `left` / `bottom` 两条边**同属一个操作**（改尺寸），只是换了个轴 ——
 * 参数化轴是自然的，不是模式开关。
 */
export interface ResizableOptions {
  /**
   * 默认宽度，也是双击恢复的目标值。
   *
   * 给函数是为了「起始宽由 CSS 决定」的情形：AI 助手抽屉是 `flex:1`，
   * 实际宽度要到运行时量了才知道，写死一个数第一次拖就会跳一下。
   */
  initial: number | (() => number)
  /** 最窄。再窄就装不下内容 */
  min: number
  /** 最大。浮窗盖满屏幕就看不见底下的 HIS 了 */
  max: number
  /** 拉哪条边。缺省左边线（改宽度） */
  edge?: 'left' | 'bottom'
}

export function useResizable(opts: ResizableOptions) {
  const vertical = opts.edge === 'bottom'

  /** null = 没拖过，尺寸交给 CSS */
  const size = ref<number | null>(null)
  const resizing = ref(false)

  let start = 0
  let startSize = 0

  const style = computed(() =>
    size.value === null ? {} : vertical ? { height: `${size.value}px` } : { width: `${size.value}px` },
  )

  const initialSize = () => (typeof opts.initial === 'function' ? opts.initial() : opts.initial)

  function clamp(v: number) {
    // max 还要再受视口限制：屏幕比 max 小时按屏幕来，
    // 否则小屏上拉到 max 会把整个页面顶出去
    const limit = Math.min(opts.max, vertical ? window.innerHeight : window.innerWidth)
    return Math.round(Math.min(Math.max(opts.min, v), Math.max(opts.min, limit)))
  }

  function onPointerMove(e: PointerEvent) {
    resizing.value = true
    // **方向是这里唯一容易搞反的地方**：
    //   左边线：往左拖 dx 为负 → 变宽，所以是**减**
    //   下边线：往下拖 dy 为正 → 变高，所以是**加**
    size.value = vertical
      ? clamp(startSize + (e.clientY - start))
      : clamp(startSize - (e.clientX - start))
  }

  function onPointerUp() {
    resizing.value = false
    window.removeEventListener('pointermove', onPointerMove)
  }

  function onPointerDown(e: PointerEvent) {
    start = vertical ? e.clientY : e.clientX
    startSize = size.value ?? initialSize()
    ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
    // 拖边线时别顺手把页面文字选中了
    e.preventDefault()
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  /** 双击边线：恢复默认尺寸 */
  function reset() {
    // 回到 null 而不是回到某个数：让尺寸重新交给 CSS，
    // 这样样式表改了默认值，双击恢复的也是新的那个
    size.value = null
  }

  // `width` 是旧名，保留是为了不动既有调用点；新代码用 `size`
  return { size, width: size, style, resizing, onPointerDown, reset }
}
