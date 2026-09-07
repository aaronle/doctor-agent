import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * 主题收敛的产物校验。
 *
 * **测产物而不是测函数**：真正要守的不是「分类函数返回什么」，而是
 * 「收敛之后仓库处于什么状态」。前者过了后者仍可能坏（比如有人手改了 CSS，
 * 或者跑脚本时用的是旧版分类规则）。
 *
 * 三条不变量：
 *   1. 默认主题下计算样式与收敛前**逐字节相同** —— 还原度门禁的前提；
 *   2. 状态色一个都没被纳入主题 —— 临床安全，红色风险在任何主题下都必须是红色；
 *   3. 两套主题定义的变量集合完全相同 —— 否则换到某个主题会有色块漏改。
 *
 * 规格见 docs/product/20-个人配置需求规格说明书.md §3。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')
const STYLES = HERE

const isGenerated = (n: string) => n.startsWith('theme-') && n.endsWith('.css')

function sourceFiles(): string[] {
  const files: string[] = []
  for (const name of fs.readdirSync(STYLES)) {
    if (!name.endsWith('.css')) continue
    if (isGenerated(name) || name === 'themes.css' || name === '_tokens-reference.css') continue
    files.push(path.join(STYLES, name))
  }
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.vue')) files.push(full)
    }
  }
  walk(SRC)
  return files
}

const WRAPPED = /var\(--t-([0-9a-f]{6}),\s*(#[0-9a-fA-F]{3,8})\)/g

const expand = (hex: string) => {
  let h = hex.replace('#', '').toLowerCase()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return h.slice(0, 6)
}

describe('主题 · 默认态逐字节不变', () => {
  it('每个 var 的变量名都等于它的回退值', () => {
    // 这是「默认主题不定义任何变量 → 计算样式与收敛前完全相同」的**结构性保证**。
    // 一旦变量名与回退值不一致，默认态就被悄悄改了色，而 fidelity 门禁会全红 ——
    // 那时再回头查会很难，所以在这里先钉住。
    const bad: string[] = []
    let total = 0
    for (const file of sourceFiles()) {
      const text = fs.readFileSync(file, 'utf8')
      for (const m of text.matchAll(WRAPPED)) {
        total += 1
        if (expand(m[2]) !== m[1]) bad.push(`${path.basename(file)}: var(--t-${m[1]}, ${m[2]})`)
      }
    }
    expect(total).toBeGreaterThan(0)
    expect(bad).toEqual([])
  })
})

describe('主题 · 状态色绝不纳入', () => {
  /**
   * 红、橙、绿。这条是**临床安全约束，不是审美偏好**：
   * 医生换成护眼主题后危急值也变绿，那是会出人命的。
   */
  const STATUS = [
    'e6191a', 'ef4444', 'fef2f2', 'fecaca', 'dc2626', // 红：风险 / 危急
    'f59e0b', 'fffbeb', 'fde68a', 'b45309', 'd97706', '92400e', // 橙 / 琥珀：警告
    '16a34a', '52c41a', 'f0f9eb', // 绿：正常 / 通过
  ]

  it('源码里没有任何状态色被包成主题变量', () => {
    const leaked: string[] = []
    for (const file of sourceFiles()) {
      const text = fs.readFileSync(file, 'utf8')
      for (const hex of STATUS) {
        if (text.includes(`var(--t-${hex}`)) leaked.push(`${path.basename(file)} → #${hex}`)
      }
    }
    expect(leaked).toEqual([])
  })

  it('生成的主题文件里也没有状态色的定义', () => {
    for (const name of fs.readdirSync(STYLES).filter(isGenerated)) {
      const text = fs.readFileSync(path.join(STYLES, name), 'utf8')
      for (const hex of STATUS) {
        expect(text, `${name} 定义了状态色 #${hex}`).not.toContain(`--t-${hex}:`)
      }
    }
  })
})

describe('主题 · 两套主题覆盖同一组变量', () => {
  it('每个被收敛的颜色，两套主题都给了值 —— 少一个就是一块不跟着变的色', () => {
    const used = new Set<string>()
    for (const file of sourceFiles()) {
      const text = fs.readFileSync(file, 'utf8')
      for (const m of text.matchAll(WRAPPED)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(0)

    const generated = fs.readdirSync(STYLES).filter(isGenerated)
    expect(generated.length).toBeGreaterThan(0)

    for (const name of generated) {
      const text = fs.readFileSync(path.join(STYLES, name), 'utf8')
      const defined = new Set([...text.matchAll(/--t-([0-9a-f]{6}):/g)].map((m) => m[1]))
      const missing = [...used].filter((v) => !defined.has(v))
      expect(missing, `${name} 缺少 ${missing.length} 个变量`).toEqual([])
    }
  })

  it('主题选择器是 :root[data-theme="…"]，默认主题不在其中', () => {
    for (const name of fs.readdirSync(STYLES).filter(isGenerated)) {
      const text = fs.readFileSync(path.join(STYLES, name), 'utf8')
      const theme = name.replace('theme-', '').replace('.css', '')
      expect(text).toContain(`:root[data-theme="${theme}"]`)
    }
    // 默认主题靠回退值生效，**不该有 theme-default.css**
    expect(fs.existsSync(path.join(STYLES, 'theme-default.css'))).toBe(false)
  })
})

describe('主题 · 不动这三样', () => {
  it('圆角与基础字号不随主题变', () => {
    // --el-font-size-base 是 12px 而非 Element Plus 默认的 14px，
    // 它是整个界面显得紧凑的根本原因；主题把它改掉，所有间距行高全部走样。
    for (const name of fs.readdirSync(STYLES).filter(isGenerated)) {
      const text = fs.readFileSync(path.join(STYLES, name), 'utf8')
      expect(text).not.toContain('--el-font-size-base')
      expect(text).not.toContain('--el-border-radius-base')
      expect(text).not.toContain('--radius')
    }
  })
})
