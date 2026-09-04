import { computed, ref } from 'vue'

/**
 * 浮窗字号。
 *
 * ## 为什么用 `zoom` 而不是改 font-size
 *
 * 面板的字号是**满屏写死的 px**（11 / 12 / 10.5 / 9…，上百处）。逐条改成
 * 相对单位既不现实，也会把还原度门禁全部撞红 —— 那张表比的正是计算样式。
 *
 * `zoom` 一行搞定，而且**连间距一起缩放**：只放大字不放大行距，
 * 读起来反而更挤，等于没解决问题。
 *
 * ## 它带来的一个坑，以及为什么要分两层
 *
 * `zoom` 之后，指针的 `clientX` 是**视觉像素**，而元素的 `offsetLeft`、
 * 我们写进 `left` 的值都是**局部像素**，两者差一个缩放系数。
 * 拖拽如果跨着这条边界算，位移会被放大或缩小。
 *
 * 所以结构上分两层：**外层「壳」管定位（不缩放），内层面板管缩放**。
 * 拖拽只碰外层，两套坐标永远不相遇。
 *
 * ## 为什么存 localStorage
 *
 * 字号是「设一次就不想再设」的偏好 —— 换个病人、刷新页面都不该丢。
 * 窗口位置则只存本次会话：医生按当前这一屏摆的位置，换台机器不一定合适。
 */

export interface FontLevel {
  key: string
  label: string
  /** 传给 CSS `zoom` 的系数 */
  scale: number
}

export const FONT_LEVELS: readonly FontLevel[] = [
  { key: 'small', label: '小', scale: 0.9 },
  { key: 'normal', label: '标准', scale: 1 },
  { key: 'large', label: '大', scale: 1.15 },
  { key: 'xlarge', label: '特大', scale: 1.3 },
] as const

const STORAGE_KEY = 'doctor-agent:font-level'
const DEFAULT_KEY = 'normal'

/** 模块级共享：两个浮窗必须是同一个字号，各存一份必然会漂 */
const levelKey = ref(readStored())

function readStored(): string {
  try {
    const saved = window.localStorage?.getItem(STORAGE_KEY)
    return FONT_LEVELS.some((l) => l.key === saved) ? (saved as string) : DEFAULT_KEY
  } catch {
    // 隐私模式下 localStorage 会抛。字号不是关键功能，回落默认即可
    return DEFAULT_KEY
  }
}

export function useFontScale() {
  const level = computed(
    () => FONT_LEVELS.find((l) => l.key === levelKey.value) ?? FONT_LEVELS[1],
  )

  /**
   * 挂在**内层面板**上的样式。
   *
   * 标准档不输出 `zoom` —— 写 `zoom:1` 会凭空造出一个新的包含块，
   * 让里面 `position:fixed` 的东西改以面板为参照，
   * 而默认档本来一切正常，不该为了统一写法去动它。
   */
  const style = computed(() => (level.value.scale === 1 ? {} : { zoom: level.value.scale }))

  function setLevel(key: string) {
    if (!FONT_LEVELS.some((l) => l.key === key)) return
    levelKey.value = key
    // **在这里存，不用 watch。** watch 默认是异步的（flush:'pre'），
    // 「设了就该存下来」这件事没有理由等到下一个 tick；
    // 而且用 watch 时，读代码的人要跑到文件另一头才知道谁在写盘。
    try {
      window.localStorage?.setItem(STORAGE_KEY, key)
    } catch {
      // 隐私模式下会抛。存不了就算了，本次会话内仍然生效
    }
  }

  return { level, levelKey, style, setLevel, levels: FONT_LEVELS }
}
