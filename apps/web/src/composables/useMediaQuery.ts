import { onBeforeUnmount, readonly, ref, type Ref } from 'vue'

/**
 * 移动端断点。
 *
 * 768px 取自「iPad 竖屏及以上算桌面」——工作站的三层面板在 768px 以下
 * 一定会溢出，而 V4.3 的 `html,body{overflow:hidden}` 会把溢出部分裁掉、
 * 够都够不着。所以这个断点不是审美选择，是可达性的分界线。
 */
export const MOBILE_QUERY = '(max-width: 768px)'

/**
 * 响应式媒体查询。
 *
 * 测试环境（jsdom）里 `matchMedia` 可能不存在 —— 直接调用会让整个组件挂载
 * 失败，而不是退化成桌面。所以这里做存在性判断，缺失时一律按桌面处理。
 */
export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  const matches = ref(false)

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mql = window.matchMedia(query)
    matches.value = mql.matches

    const onChange = (event: MediaQueryListEvent) => {
      matches.value = event.matches
    }

    // Safari 14 之前只有 addListener；两个都试一下，别在旧 iOS 上静默失效
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      onBeforeUnmount(() => mql.removeEventListener('change', onChange))
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(onChange)
      onBeforeUnmount(() => mql.removeListener(onChange))
    }
  }

  return readonly(matches)
}

export function useIsMobile(): Readonly<Ref<boolean>> {
  return useMediaQuery(MOBILE_QUERY)
}
