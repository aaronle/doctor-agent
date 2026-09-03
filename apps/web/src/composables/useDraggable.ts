import { computed, ref } from 'vue'

/**
 * 让一个浮动元素能拖，并且**拖完那一下不算点击**。
 *
 * 从 `AgentMascot.vue` 抽出来的 —— 追问提示浮框要的是同一套行为，
 * 而这套行为里有两个坑，抄第二遍必然漏掉其中一个：
 *
 * **① 拖完浏览器照样派发 click。** 不拦的话「把它挪开」永远伴随一次误触发，
 * 用户会得出「这东西不能拖」的结论。阈值不能是 0：手抖两个像素
 * 不该把点击变成拖拽。
 *
 * **② 拖出屏幕就再也点不着了。** 浮动入口必须永远够得着，所以钳在可视区内。
 *
 * **③ `left`/`top` 写进的是「相对定位祖先」的坐标系，而
 * `getBoundingClientRect()` 给的是视口坐标系。** 两个坐标系混用，元素会
 * 当场跳到别处 —— 实测追问提示浮框（`position:absolute`，装在面板里）
 * 从 x=1205 拖一下直接跳到 x=1966，跑出 1440 宽的屏幕外面，
 * 缩小按钮再也点不到。
 *
 * 桌面卡通没暴露这个问题，因为它是 `position:fixed`，两个坐标系恰好重合。
 * 所以这里一律用 `offsetLeft/offsetTop`（就是 `left/top` 所在的那个坐标系），
 * 并按 `offsetParent` 的尺寸来钳 —— fixed 元素没有 offsetParent，
 * 自动落回视口，两种情况同一段代码。
 */

export interface DraggableOptions {
  /** 元素尺寸，用于把它钳在可视区内 */
  width: number
  height: number
  /** 超过这个位移才算拖拽（px）。低于它是手抖 */
  threshold?: number
  /** 没拖过时的默认落点。返回 null 表示交给 CSS（如 right/bottom 定位） */
  initial?: () => { left: number; top: number } | null
}

export function useDraggable(opts: DraggableOptions) {
  const { width, height, threshold = 4 } = opts

  const pos = ref<{ left: number; top: number } | null>(null)
  const dragging = ref(false)

  /** 刚刚发生过拖拽 —— 用来吞掉紧跟其后的那次 click */
  const dragged = ref(false)

  let origin: { x: number; y: number; left: number; top: number } | null = null

  const style = computed(() =>
    pos.value
      ? { left: `${pos.value.left}px`, top: `${pos.value.top}px`, right: 'auto', bottom: 'auto' }
      : {},
  )

  /** 钳位的边界：优先用 offsetParent 的尺寸，没有（fixed）就用视口 */
  let bounds = { w: 0, h: 0 }

  function clamp(left: number, top: number) {
    const maxLeft = Math.max(0, bounds.w - width)
    const maxTop = Math.max(0, bounds.h - height)
    return { left: Math.min(Math.max(0, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) }
  }

  function onPointerDown(e: PointerEvent) {
    // **按钮上按下不算拖。**
    //
    // 把标题栏整条做成把手时，里面的按钮（缩小、关闭）也会把 pointerdown
    // 冒泡上来。一旦这里 `setPointerCapture`，后续指针事件全被重定向到
    // 标题栏，**按钮再也收不到自己的 click** —— 实测线上表现为
    // 「缩小按钮点了没反应」，而按钮本身、handler、样式全都正常。
    // 拖的是**被定位的那个元素**，可能是把手的祖先（浮框拖的是标题栏）
    const handle = e.currentTarget as HTMLElement

    // **把手里面的按钮上按下不算拖。**
    //
    // 把标题栏整条做成把手时，里面的按钮（缩小、关闭）也会把 pointerdown
    // 冒泡上来。一旦这里 `setPointerCapture`，后续指针事件全被重定向到
    // 标题栏，**按钮再也收不到自己的 click** —— 线上表现为
    // 「缩小按钮点了没反应」，而按钮本身、handler、样式全都正常。
    //
    // 判据必须是「**严格在把手内部**的交互元素」：桌面卡通自己就是
    // `role="button"`，只写 closest 会把它整个豁免掉，变成不能拖
    // （第一版就是这么把卡通拖坏的）。
    const from = e.target as HTMLElement | null
    const interactive = from?.closest('button, a, input, textarea, select')
    if (interactive && interactive !== handle && handle.contains(interactive)) return
    const el = (handle.closest<HTMLElement>('[data-draggable]') ?? handle)
    const parent = el.offsetParent as HTMLElement | null

    // 边界：有 offsetParent 就用它的尺寸，没有（position:fixed）就用视口
    bounds = parent
      ? { w: parent.clientWidth, h: parent.clientHeight }
      : { w: window.innerWidth, h: window.innerHeight }
    // jsdom 下所有布局数字都是 0，退回视口，免得 clamp 把一切压成 (0,0)
    if (!bounds.w || !bounds.h) bounds = { w: window.innerWidth, h: window.innerHeight }

    // **用 offsetLeft/offsetTop，不用 getBoundingClientRect** —— 见文件头 ③。
    // 它和我们要写进去的 left/top 是同一个坐标系。
    const fallback = opts.initial?.() ?? { left: 0, top: 0 }
    const hasLayout = el.offsetWidth > 0 || el.offsetHeight > 0
    origin = {
      x: e.clientX,
      y: e.clientY,
      left: pos.value?.left ?? (hasLayout ? el.offsetLeft : fallback.left),
      top: pos.value?.top ?? (hasLayout ? el.offsetTop : fallback.top),
    }
    dragged.value = false
    handle.setPointerCapture?.(e.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  function onPointerMove(e: PointerEvent) {
    if (!origin) return
    const dx = e.clientX - origin.x
    const dy = e.clientY - origin.y
    if (!dragged.value && Math.hypot(dx, dy) < threshold) return
    dragged.value = true
    dragging.value = true
    pos.value = clamp(origin.left + dx, origin.top + dy)
  }

  function onPointerUp() {
    origin = null
    dragging.value = false
    window.removeEventListener('pointermove', onPointerMove)
  }

  /**
   * 包一个 click 处理器：刚拖完的那一下吞掉，**只吞一次**，下一次点击照常生效。
   */
  function withClickGuard(fn: () => void) {
    return () => {
      if (dragged.value) {
        dragged.value = false
        return
      }
      fn()
    }
  }

  return { pos, style, dragging, dragged, onPointerDown, withClickGuard }
}
