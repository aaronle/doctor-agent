import { computed, ref } from 'vue'

/**
 * 浮窗左边线拖拽调宽。
 *
 * 两个浮窗（AI 助手抽屉、医生智能体面板）都**靠右停靠**，右边贴着屏幕 ——
 * 只有左边线能拉。**往左拖 = 变宽**（边线远离右侧锚点），这是唯一容易搞反的地方。
 *
 * 和 `useDraggable` 分开写，不合并：那个改的是 `left/top`（元素去哪），
 * 这个改的是 `width`（元素多大），共用的只有「按住指针跟着动」这层壳。
 * 硬合成一个会得到一个带 `mode` 开关的函数，两条路径各自都更难读。
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
  /** 最宽。浮窗盖满屏幕就看不见底下的 HIS 了 */
  max: number
}

export function useResizable(opts: ResizableOptions) {
  /** null = 没拖过，宽度交给 CSS */
  const width = ref<number | null>(null)
  const resizing = ref(false)

  let startX = 0
  let startWidth = 0

  const style = computed(() => (width.value === null ? {} : { width: `${width.value}px` }))

  const initialWidth = () => (typeof opts.initial === 'function' ? opts.initial() : opts.initial)

  function clamp(w: number) {
    // max 还要再受视口限制：屏幕比 max 窄时按屏幕来，
    // 否则小屏上拉到 max 会把整个页面顶出去
    const max = Math.min(opts.max, window.innerWidth)
    return Math.round(Math.min(Math.max(opts.min, w), Math.max(opts.min, max)))
  }

  function onPointerMove(e: PointerEvent) {
    resizing.value = true
    // 往左拖 dx 为负 → 宽度增加。**减号不能写成加号**
    width.value = clamp(startWidth - (e.clientX - startX))
  }

  function onPointerUp() {
    resizing.value = false
    window.removeEventListener('pointermove', onPointerMove)
  }

  function onPointerDown(e: PointerEvent) {
    startX = e.clientX
    startWidth = width.value ?? initialWidth()
    ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
    // 拖边线时别顺手把页面文字选中了
    e.preventDefault()
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  /** 双击边线：恢复默认宽度 */
  function reset() {
    // 回到 null 而不是回到某个数：让宽度重新交给 CSS，
    // 这样样式表改了默认宽，双击恢复的也是新的那个值
    width.value = null
  }

  return { width, style, resizing, onPointerDown, reset }
}
