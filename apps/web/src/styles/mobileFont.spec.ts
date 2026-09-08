import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 移动端默认字号。
 *
 * 产品反馈：「移动端的字体太小了，默认的应该是现在的特大」（2026-09-08）。
 *
 * **只改移动端。** 桌面端的字号压在还原度门禁下（119 个元素逐条比计算样式），
 * 动它会整片撞红 —— 而那道门禁守的是「与 V4.3 原件一致」，
 * 不该为了手机上的可读性去破坏。
 *
 * 做法是把移动端的**基准**上移一档，四档仍然保留：
 * 原来的「特大」变成新的默认，四档整体右移。
 */

const CSS = readFileSync(resolve(__dirname, 'mobile.css'), 'utf8')

/** 抓 `html[data-font='x'] … { zoom: N }` 里的 N */
function zoomFor(level: string): number | null {
  const re = new RegExp(`html\\[data-font='${level}'\\][^{]*\\{[^}]*zoom:\\s*([\\d.]+)`, 's')
  return Number(CSS.match(re)?.[1] ?? NaN) || null
}
/** 默认档（没有 data-font 属性时）的基准 zoom */
function baseZoom(): number | null {
  // 标记写在注释块里（不要求紧跟 `*/`），从标记往后找第一条 zoom
  const re = /MOBILE_BASE_ZOOM[\s\S]*?\{[^}]*zoom:\s*([\d.]+)/
  return Number(CSS.match(re)?.[1] ?? NaN) || null
}

describe('移动端字号基准', () => {
  it('默认档就是原来的「特大」（1.3）', () => {
    // 不是「加一档更大的」，是把整条标尺右移 —— 默认值本身要变大
    expect(baseZoom()).toBe(1.3)
  })

  it('四档仍然齐全，且**单调递增**', () => {
    const scale = [zoomFor('small'), baseZoom(), zoomFor('large'), zoomFor('xlarge')]
    expect(scale.every((n) => typeof n === 'number' && n > 0)).toBe(true)
    for (let i = 1; i < scale.length; i++) {
      expect(scale[i]!).toBeGreaterThan(scale[i - 1]!)
    }
  })

  it('最小档不小于改版前的默认（1.0）—— 没人需要比原来更小', () => {
    // 原来的默认是 1.0，那已经是「偏小」的那一档。
    // 新标尺的下限落在它上面，等于把「太小」这个区间整个砍掉
    expect(zoomFor('small')!).toBeGreaterThanOrEqual(1.0)
  })

  it('顶栏与标签栏也跟着放大 —— 它们不在 zoom 的作用范围里', () => {
    /*
     * `zoom` 挂在 `.m-body`，够不着 `.m-topbar` / `.m-tabbar` / `.m-input-bar`
     * （见 mobile.css 里那段注释：`.m-page` 是 position:fixed，
     * 给它加 zoom 会让浮层算错大小）。
     *
     * 所以这三处的字号必须**直接写大**，否则会出现
     * 「正文很大、导航很小」的割裂 —— 而导航恰恰是要点的地方。
     */
    const chrome = [
      { sel: '.m-tab-label', min: 12.5 },
      { sel: '.m-who-name', min: 17 },
      { sel: '.m-input-bar input', min: 16 },
    ]
    for (const { sel, min } of chrome) {
      const m = CSS.match(new RegExp(`\\${sel}\\s*\\{[^}]*font-size:\\s*([\\d.]+)px`, 's'))
      expect(m, `${sel} 找不到 font-size`).toBeTruthy()
      expect(Number(m![1]), `${sel} 太小`).toBeGreaterThanOrEqual(min)
    }
  })

  it('输入框不小于 16px —— 小于它 iOS 聚焦时会自动放大整页', () => {
    const m = CSS.match(/\.m-input-bar input\s*\{[^}]*font-size:\s*([\d.]+)px/s)
    expect(Number(m![1])).toBeGreaterThanOrEqual(16)
  })
})
