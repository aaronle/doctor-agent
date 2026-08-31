/**
 * 诊断管理的自然语言命令。
 *
 * V4.3 里「修改诊断」「设为主诊断」这些不是按钮，是在 Copilot 输入框里打的命令 ——
 * 反向需求书早先把它们记成了「二级动作按钮」，是错的。
 *
 * 做成纯函数而不是塞进组件：命令解析是这一块唯一有分支的逻辑，
 * 单独拿出来才测得动，也才看得清「哪些输入会被抢答」。
 *
 * 返回 null 表示「这不是诊断命令」，调用方应把原文交给模型。
 * 抢答的代价很大：医生问「这个患者要不要抗凝」被当成命令吞掉，
 * 就再也拿不到模型的回答了，所以匹配一律锚定行首关键词。
 */

export type DiagnosisEntry = { name: string; icd?: string }

export type DiagnosisState = {
  selected: DiagnosisEntry[]
  primary: string
}

export type CommandResult = {
  /**
   * 回给医生的话。**纯文本，不含 HTML。**
   *
   * 原件用 <strong> 加粗，因为它的气泡渲染 HTML。我们的气泡渲染纯文本，
   * 直接照抄会把标签原样显示给医生（公网验收时就是这么发现的）。
   * 改用 v-html 更糟 —— 回复里插着诊断名，而名字来自医生输入与模型输出，
   * 等于开一个 XSS 口子。中文用「」强调足够。
   */
  reply: string
  /** 命令执行后的新状态（不改传入对象） */
  state: DiagnosisState
  /** 是否要触发一次诊断回写 */
  writeBack?: boolean
}

const CONFIRM = /^(确认诊断|诊断确认|确认并回写诊断|回写诊断)/
const VIEW = /^查看诊断/
const CLEAR = /^清空诊断/
const ADD = /^添加诊断\s*[:：]?\s*(.+)/
const REMOVE = /^删除诊断\s*[:：]?\s*(.+)/
const PRIMARY = /^设为主诊断\s*[:：]?\s*(.+)/
const RENAME = /^修改诊断\s*[:：]?\s*(.+?)\s*为\s*(.+)/
/**「修改诊断」开头但没写「为」，要给提示而不是当成普通对话放过去 */
const RENAME_LOOSE = /^修改诊断/

/** ICD 码形如 E11.9 / I10：一个字母跟一个数字起头 */
const ICD = /^[A-Za-z]\d/

const clone = (s: DiagnosisState): DiagnosisState => ({
  selected: s.selected.map((d) => ({ ...d })),
  primary: s.primary,
})

/**
 * 模糊匹配医生说的名字。
 *
 * 双向包含：医生不会每次都打全「高血压3级」，打「高血压」也得认；
 * 反过来复制粘贴带了后缀也得认。
 */
function findIndex(list: DiagnosisEntry[], query: string): number {
  const q = query.trim()
  const exact = list.findIndex((d) => d.name === q)
  if (exact >= 0) return exact
  return list.findIndex((d) => d.name.includes(q) || q.includes(d.name))
}

const EMPTY_HINT = '当前没有选中的诊断。输入「添加诊断：高血压」来添加。'

export function runDiagnosisCommand(input: string, current: DiagnosisState): CommandResult | null {
  const text = input.trim()
  const state = clone(current)

  if (CONFIRM.test(text)) {
    if (!state.selected.length) return { reply: EMPTY_HINT, state }
    if (!state.primary) {
      return {
        reply: '尚未指定主诊断。输入「设为主诊断：xxx」后再回写。',
        state,
      }
    }
    return { reply: `正在回写 ${state.selected.length} 条诊断，主诊断为「${state.primary}」。`, state, writeBack: true }
  }

  if (VIEW.test(text)) {
    if (!state.selected.length) return { reply: EMPTY_HINT, state }
    const lines = state.selected.map((d, i) => {
      const star = d.name === state.primary ? '★ ' : ''
      const icd = d.icd ? ` (ICD: ${d.icd})` : ''
      const tag = d.name === state.primary ? ' — 主诊断' : ''
      return `${i + 1}. ${star}「${d.name}」${icd}${tag}`
    })
    const usage = [
      '可输入：',
      '•「添加诊断：xxx」添加新诊断',
      '•「删除诊断：xxx」删除诊断',
      '•「设为主诊断：xxx」设置主诊断',
      '•「修改诊断：A 为 B」修改名称',
      '•「确认诊断回写」回写 HIS',
    ]
    return { reply: [`当前诊断（${state.selected.length} 条）：`, ...lines, '', ...usage].join('\n'), state }
  }

  if (CLEAR.test(text)) {
    const count = state.selected.length
    return { reply: `已清空全部 ${count} 条诊断。`, state: { selected: [], primary: '' } }
  }

  const rename = text.match(RENAME)
  if (rename) {
    const [, from, to] = rename
    const index = findIndex(state.selected, from)
    if (index < 0) return { reply: `未找到诊断「${from.trim()}」。输入「查看诊断」查看当前列表。`, state }
    const wasPrimary = state.selected[index].name === state.primary
    const next = to.trim()
    state.selected[index].name = next
    if (wasPrimary) state.primary = next
    return { reply: `已将「${from.trim()}」修改为「${next}」。`, state }
  }
  if (RENAME_LOOSE.test(text)) {
    return { reply: '格式是「修改诊断：原名 为 新名」，中间的「为」不能省。', state }
  }

  const add = text.match(ADD)
  if (add) {
    const parts = add[1].trim().split(/\s+/)
    const name = parts[0]
    const icd = parts.length > 1 && ICD.test(parts[1]) ? parts[1] : undefined
    if (findIndex(state.selected, name) >= 0) {
      return { reply: `「${name}」已在诊断列表中。`, state }
    }
    state.selected.push(icd ? { name, icd } : { name })
    // 第一条自动成为主诊断：回写必须有主诊断，让医生少一步
    if (!state.primary) state.primary = name
    return { reply: `已添加「${name}」${icd ? `（ICD: ${icd}）` : ''}。`, state }
  }

  const remove = text.match(REMOVE)
  if (remove) {
    const query = remove[1].trim()
    const index = findIndex(state.selected, query)
    if (index < 0) return { reply: `未找到诊断「${query}」。输入「查看诊断」查看当前列表。`, state }
    const [gone] = state.selected.splice(index, 1)
    // 主诊断被删掉就清空，不能留一个指向已删条目的悬空引用
    if (gone.name === state.primary) state.primary = ''
    return { reply: `已删除「${gone.name}」。`, state }
  }

  const primary = text.match(PRIMARY)
  if (primary) {
    const query = primary[1].trim()
    const index = findIndex(state.selected, query)
    if (index < 0) {
      return { reply: `未找到诊断「${query}」。请先添加该诊断，或输入「查看诊断」查看当前列表。`, state }
    }
    state.primary = state.selected[index].name
    return { reply: `已将「${state.primary}」设为主诊断。`, state }
  }

  return null
}
