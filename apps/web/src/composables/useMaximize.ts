import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type { WindowKey } from './useDockedWindows'

/**
 * 浮窗全屏（铺满视口）。
 *
 * ## 为什么不用浏览器的 Fullscreen API
 *
 * `requestFullscreen()` 会把浏览器边框一起隐掉，看起来更彻底，但代价不划算：
 *
 * - 它必须由用户手势触发，且**退出由浏览器管**（ESC 直接退，我们收到的是
 *   事后通知）—— 状态的真相因此有两份，一份在我们这儿一份在浏览器那儿。
 * - 全屏元素会新建一个**顶层渲染上下文**，里面的 `position:fixed` 改以它为参照。
 *   而这套界面里 `fixed` 到处都是（两个浮窗本身、卡通、追问提示浮框），
 *   进出全屏时它们会集体跳位。
 * - 字号用的是 `zoom`，和顶层上下文叠在一起还要再算一次坐标。
 *
 * 铺满视口是**纯样式覆盖**：底下的拖动位置、尺寸、停靠状态一点没动，
 * 退出时原样回来 —— 不需要「保存现场再恢复」那套东西，因为现场根本没被破坏。
 *
 * ## 一次只能一个
 *
 * 两个窗都铺满会互相盖住。所以进全屏时另一个**收起来**，退出时回来。
 */

/** 同一时刻最多一个窗全屏。null = 都没有 */
export function useMaximize() {
  const maximized = ref<WindowKey | null>(null)

  const isMax = (key: WindowKey) => maximized.value === key
  /** 另一个窗要不要藏起来 */
  const isHidden = (key: WindowKey) => maximized.value !== null && maximized.value !== key

  const styleFor = (key: WindowKey) =>
    computed(() =>
      maximized.value === key
        ? {
            position: 'fixed' as const,
            left: '0px',
            top: '0px',
            right: '0px',
            bottom: '0px',
            width: 'auto',
            height: 'auto',
            // 盖住底下的 HIS 门面与另一个窗（.ai-float-wrapper 是 2000）
            zIndex: 2050,
            borderRadius: '0',
            flex: 'none',
          }
        : {},
    )

  function toggle(key: WindowKey) {
    maximized.value = maximized.value === key ? null : key
  }

  function exit() {
    maximized.value = null
  }

  /** ESC 退出全屏 —— 这是所有人都会先按的那个键 */
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && maximized.value !== null) {
      e.stopPropagation()
      exit()
    }
  }

  onMounted(() => document.addEventListener('keydown', onKey))
  onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

  return { maximized, isMax, isHidden, styleFor, toggle, exit, onKey }
}
