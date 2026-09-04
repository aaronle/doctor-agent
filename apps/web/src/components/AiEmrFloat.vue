<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import { api, sortByRiskLevel, streamSse, type RecordQuality, type RiskItem } from '../api'
import { RECORD_SECTIONS, useWorkstation } from '../stores/workstation'
import { useCopilotChat } from '../composables/useCopilotChat'
import { useInterview } from '../composables/useInterview'
import { runDiagnosisCommand, type DiagnosisEntry, type DiagnosisState } from '../composables/diagnosisCommands'
import AgentMascot from './AgentMascot.vue'
import FollowUpHints from './FollowUpHints.vue'
import { AUTO_OPEN_AFTER_MESSAGES, useFollowUp } from '../composables/useFollowUp'
import { useResizable } from '../composables/useResizable'
import { useDockedWindows } from '../composables/useDockedWindows'
import { useFontScale } from '../composables/useFontScale'
import { useMaximize } from '../composables/useMaximize'
import { useTelemetry } from '../composables/useTelemetry'

const ws = useWorkstation()

const TABS = ['智慧诊疗', '预警评估', '病历管理', '诊断管理', '医嘱管理', '共病管理', '健康档案', '时间轴'] as const
type Tab = (typeof TABS)[number]

/**
 * 需要等问诊才给的四块。
 *
 * 按「证据从哪来」分，不是按「重要不重要」分：这四块是模型**基于本次问诊**
 * 推断的，问诊前给出结论会让医生先看到答案再去找证据 —— 那是锚定，不是辅助。
 *
 * 其余四块（预警评估、医嘱管理、健康档案、时间轴）来自 HIS 已有数据与
 * 纯代码硬规则，与问诊无关，一进来就给。**预警评估尤其不能锁** ——
 * 让医生在不知道危急值的情况下问完一整轮，是不能接受的。
 */
const INTERVIEW_GATED: readonly Tab[] = ['智慧诊疗', '病历管理', '诊断管理', '共病管理']

function tabLocked(tab: Tab) {
  return !ws.analysisUnlocked && INTERVIEW_GATED.includes(tab)
}

/** 当前这一页是不是锁着的。锁着时整页让位给说明卡，而不是显示空面板。 */
const activeLocked = computed(() => tabLocked(activeTab.value))

/**
 * 预警评估这一页的卡片 = 硬规则红线 + 模型风险评估。
 *
 * 只取模型那份的话，问诊前这一页是空的 —— 而它恰恰是**不该锁**的那一页
 * （危急值不能等）。硬规则是纯代码判定，一进来就该在这里。
 */
const riskCards = computed(() => {
  const seen = new Set<string>()
  const out: RiskItem[] = []
  for (const r of [...ws.hardAlerts, ...(summary.value?.risk_assessments ?? [])]) {
    if (!r?.id || seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  // **按等级排，不按来源排。** 上面那个拼接顺序（硬规则在前）会把
  // 服务端排好的次序重新打乱 —— 而硬规则里有中风险（检查结论异常），
  // 线上因此出现过两条中风险压在两条高风险上面。
  // 风险列表的阅读顺序就是处置顺序。
  return sortByRiskLevel(out)
})

const unlocking = ref(false)

/** 跳过问诊。二次确认里把后果讲清楚，而不是一句「确定吗」。 */
async function skipInterview() {
  try {
    await ElMessageBox.confirm(
      '将只用 HIS 已有资料（检验、检查、既往就诊、既往史）生成分析，不含本次问诊内容。\n\n' +
        '生成结果会标注「未含问诊」，病历草稿里无出处的段落一律写「未采集」，不替患者编答案。\n' +
        '随后仍可点「开始问诊」，问完再重算一次。',
      '跳过问诊，直接生成分析？',
      { confirmButtonText: '跳过并生成', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  unlocking.value = true
  try {
    await ws.unlockAndAnalyse('skipped')
  } catch (error) {
    ElMessage.error(`生成失败：${(error as Error).message}`)
  } finally {
    unlocking.value = false
  }
}

const activeTab = ref<Tab>('智慧诊疗')

/**
 * AI 助手是否展开。**默认收起**（2026-09-02）。
 *
 * 一进来只有「医生智能体」。病历、鉴别诊断、风险、共病都由这一场问诊推导，
 * 问诊前先把结论摆出来，会让医生把「模型基于旧资料的猜测」当成本次判断 ——
 * 那正是问诊门禁存在的理由，界面不该反过来把门禁的结论提前展示。
 *
 * 点「生成」后自动展开（见 generateNow），医生也可以随时手动开合。
 */
const tipsOpen = ref(false)
const panelOpen = ref(true)

/** 这次展开是「结束问诊」自动触发的，用于在开关上标一句，让医生知道是谁打开的。 */
const justAutoExpanded = ref(false)

/**
 * 空状态里的「开始问诊」。
 *
 * 与右栏那个按钮走同一条路径 —— 两个入口做两件事，迟早会出现「从这里开始
 * 和从那里开始不一样」这种查起来极费劲的问题。
 */
function startInterviewFromPlaceholder() {
  void voice.start()
}

/**
 * 医生智能体收起后的桌面卡通（`AgentMascot`，方案 D1）。
 *
 * **只要面板关着就出现**，与 AI 助手抽屉开不开无关。
 *
 * 原件的条件是「抽屉与面板都关」，因为原件那个圆钮还的是**抽屉** ——
 * 抽屉开着时它确实没事可做。而这只卡通还的是**面板**，条件必须跟着
 * 「它还什么」走，不能照抄。
 *
 * 照抄的后果实测过，是一条死路：AI 助手展开着的时候关面板 ——
 * 面板没了、卡通不出（因为抽屉开着）、把手又长在面板内壁上跟着一起没了，
 * **页面上没有任何东西能把面板点回来**，只能先关掉 AI 助手才冒出卡通。
 * 这正是本文件反复防的那类问题：唤回入口必须永远够得着。
 *
 * **2026-09-03：它替掉了原件那个 52px 的「AI」圆钮**（`.ai-float-btn` /
 * `.float-icon` / `.float-ready-dot`）。位置沿用（right:24 bottom:32），
 * 职责一个字没变，换的只是长相 —— 圆钮上的「AI」是个标签，
 * 而这一格真正要说的是「医生智能体待命中」。一张脸能表达状态，两个字母不能。
 *
 * 注：原件里还有个 .solo-tips-open-btn（✦ 医护Copilot），显示条件为
 * `c && !r`，但在该 build 中未发现可达路径 —— 实测关抽屉、关面板两种组合
 * 都不触发。判定为死代码，不实现，以免显示原件从不显示的按钮。
 */
const showRoundEntry = computed(() => !panelOpen.value)

/**
 * 点卡通 → **把医生智能体面板找回来**，不是打开 AI 助手。
 *
 * 原件那个圆钮点下去只 `tipsOpen = true`。照搬会留一条死路：
 * 面板关着、把手长在面板内壁上，于是抽屉开起来之后**面板再也回不来**了。
 * 缩起来的是面板，点开就该还面板 —— 这也正是「缩小为一个卡通」的字面意思。
 *
 * 抽屉保持医生离开时的样子，不替他做主。
 */
function restoreAgentPanel() {
  panelOpen.value = true
}

/**
 * 智慧诊疗左右分栏比例。
 *
 * V4.3 把它做成可拖拽：宽度是 JS 写的内联 flex，CSS 里没有默认值。
 * 不还原这一点，两栏会退化成按内容撑开，右侧病历卡被挤成竖条。
 */
const leftRatio = ref(50)
const columnsEl = ref<HTMLElement | null>(null)

function startResize(event: MouseEvent) {
  event.preventDefault()
  const container = columnsEl.value
  if (!container) return

  const move = (e: MouseEvent) => {
    const rect = container.getBoundingClientRect()
    const ratio = ((e.clientX - rect.left) / rect.width) * 100
    leftRatio.value = Math.min(75, Math.max(25, ratio))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

const voice = useInterview(() => ws.patientId)
/** AI 追问提示。清单在 voice.start() 里取一次，判定随对话推进（见下面的 watch）。 */
const followUp = useFollowUp(() => ws.patientId)

/* ===================== 两个浮窗的宽度可拖 ===================== */

/**
 * 医生智能体面板宽度。默认 300（样式表里那个值），下限 260 上限 560。
 *
 * 下限不能再低：患者信息行是「姓名 + 性别年龄出生年月就诊号 + 过敏标记」，
 * 300px 已经很紧，260 是实测还能读全的底线。
 */
const panelSize = useResizable({ initial: 300, min: 260, max: 560 })

/**
 * AI 助手宽度。**拖的是整个组合的左边线。**
 *
 * 抽屉是 `flex:1`，自己没有宽度 —— 它的左边线就是 `.ai-float-wrapper`
 * 的左边线。所以这里调的是**组合总宽**，抽屉实际宽度 = 总宽 − 面板宽。
 * 起始值要运行时量（CSS 给的是 `left:30%`，换个屏幕就是另一个数）。
 */
const wrapperEl = ref<HTMLElement | null>(null)
const drawerSize = useResizable({
  initial: () => wrapperEl.value?.getBoundingClientRect().width || 900,
  min: 640,
  max: 1800,
})

/**
 * 两个浮窗的**高度**。拖各自的下边线。
 *
 * 只有下边线能拉：两个窗都锚在顶部（wrapper `top:15px`），上边线拖不动 ——
 * 和「靠右停靠所以只有左边线能拉宽」是同一个道理。
 *
 * 下限 320：再矮连患者信息行加两条气泡都放不下，只剩个标题栏。
 * 上限交给视口（见 `useResizable` 的 clamp）—— 比屏幕还高没有意义。
 */
const panelHeight = useResizable({
  initial: () => panelShell.value?.getBoundingClientRect().height || 800,
  min: 320, max: 2000, edge: 'bottom',
})
const drawerHeight = useResizable({
  initial: () => drawerShell.value?.getBoundingClientRect().height || 800,
  min: 320, max: 2000, edge: 'bottom',
})

/* ===================== 合并 / 分离，与字号 ===================== */

/**
 * 两个浮窗的合并与分离。默认合并（就是原来那样，拼成一整块靠右停靠）。
 * 拖标题栏拖开，拖回去靠近了自动吸附；双击标题栏一键还原。
 */
const dock = useDockedWindows()
const drawerShell = ref<HTMLElement | null>(null)
const panelShell = ref<HTMLElement | null>(null)

function beginDrag(key: 'drawer' | 'panel', e: PointerEvent) {
  // 标题栏里的按钮（✕ / — / Aa）不算拖 —— 否则指针被标题栏捕获，
  // 按钮收不到自己的 click。和追问提示浮框同一个坑。
  const from = e.target as HTMLElement | null
  if (from?.closest('button, .el-button, [role="button"]')) return
  const self = key === 'drawer' ? drawerShell.value : panelShell.value
  const other = key === 'drawer' ? panelShell.value : drawerShell.value
  if (self) dock.startDrag(key, e, self, other)
}

/**
 * 字号。
 *
 * **挂在内容区（`.chat-area` / `.tips-tab-body` / `.copilot-tab-bar`），
 * 不挂在面板本身。** 面板要承载拖动与调宽的坐标；`zoom` 一旦加上去，
 * 指针的 `clientX`（视觉像素）和我们写进 `left`/`width` 的值（局部像素）
 * 就差一个缩放系数，两个交互立刻算错。
 *
 * 挂在内容区还有一个附带好处：**标题栏不跟着放大**。它是外壳不是内容，
 * 放大了只是挤占本来就该留给正文的空间。
 *
 * 代价是面板宽度不会随字号变宽 —— 但现在边线可以拖，医生自己拉开就行。
 */
const font = useFontScale()
const fontMenuOpen = ref(false)

/**
 * 全屏（铺满视口）。ESC 退出。
 *
 * **一次只能一个** —— 两个窗都铺满会互相盖住，所以进全屏时另一个收起来。
 * 它是纯样式覆盖：底下的拖动位置、尺寸、停靠状态一点没动，退出时原样回来，
 * 不需要「保存现场再恢复」那套东西。
 *
 * 样式合并时**放在最后**：它要盖过 dock 的定位、resize 的宽高、
 * 以及分离态冻住的那份尺寸。
 */
const maxi = useMaximize()

/**
 * 埋点。**采医生实际点了什么** —— 后端的 HTTP 日志答不了这个：
 * 关掉追问提示、调字号、全屏、拖窗口、切标签页，全都不发请求。
 *
 * 只采「点了什么」，不采输入内容 —— 那是病历，另有 training_samples 管。
 */
const { track } = useTelemetry()

const wrapperStyle = computed(() =>
  drawerSize.width.value === null
    ? {}
    // `right:0` 还在，给了 width 就等于把左边线定在 innerWidth - width 处
    : { left: 'auto', width: `${drawerSize.width.value}px` },
)

/**
 * 外部（红线横幅的「逐条处置」）要求切到某个标签页。
 *
 * 用事件而不是把 activeTab 提到 store：标签页是这个组件自己的呈现状态，
 * 提到 store 会让两个组件共同拥有它，改一处必然漏一处。
 */
function onOpenTab(e: Event) {
  const tab = (e as CustomEvent).detail as Tab
  if (TABS.includes(tab)) {
    tipsOpen.value = true
    activeTab.value = tab
  }
}
onMounted(() => window.addEventListener('da:open-tab', onOpenTab))
onBeforeUnmount(() => window.removeEventListener('da:open-tab', onOpenTab))

const summary = computed(() => ws.summary)
const patient = computed(() => ws.patient)

/**
 * 患者信息行：性别 · 年龄 · 出生年月 · 就诊号，一行。
 *
 * 出生年月只到月。门诊核对身份用不到日，写全了这一行会被挤爆 ——
 * 而这一行右边还要留给过敏标记，那才是必须看见的东西。
 *
 * 「就诊号」用的是 P001 这类患者 ID，**不是身份证号**。身份证号只在服务端
 * 用来推出生日期，从不下发到前端（见 his.py 的 LIST_FIELDS）。
 */
const patientMeta = computed(() => {
  const p = patient.value
  if (!p) return ''
  const parts = [p.gender, p.age ? `${p.age}岁` : '', (p.birth_date || '').slice(0, 7), p.id]
  return parts.filter(Boolean).join(' · ')
})

/**
 * 过敏史三态。
 *
 * 后端把状态和过敏原包在一个对象里下发，就是为了让这里想漏都漏不掉 ——
 * 空的 items 既可能是「问过、没有」也可能是「没人问过」，只读 items 必然判错。
 */
const allergy = computed<{ status: string; items: string[] }>(() => {
  const a = (patient.value as { allergy?: { status?: string; items?: string[] } } | null)?.allergy
  return { status: a?.status || 'unknown', items: a?.items || [] }
})

/**
 * 两个浮层的位置。
 *
 * V4.3 把 position/right/top 写成内联样式（由 JS 按面板几何算出），
 * CSS 里只有观感没有位置 —— 只搬 CSS 会让浮层塌到文档流里。
 * 这里沿用它的取值；医生智能体面板关闭时右移，避免悬空。
 */
const floatRight = computed(() => (panelOpen.value ? 308 : 20))


// ---------------------------------------------------------------- 诊断管理

const checkedDiagnoses = ref<Set<string>>(new Set())
const primaryDiagnosis = ref('')
const writingBack = ref(false)

function toggleDiagnosis(name: string) {
  const next = new Set(checkedDiagnoses.value)
  if (next.has(name)) {
    next.delete(name)
    if (primaryDiagnosis.value === name) primaryDiagnosis.value = ''
  } else {
    next.add(name)
  }
  checkedDiagnoses.value = next
}

function markPrimary(name: string) {
  if (!checkedDiagnoses.value.has(name)) toggleDiagnosis(name)
  primaryDiagnosis.value = primaryDiagnosis.value === name ? '' : name
}

/**
 * 医生在 Copilot 里手打添加的诊断。
 *
 * 候选诊断来自模型的疑似诊断列表，医生想加一条列表里没有的，就落在这里，
 * 与候选合并后一起渲染、一起回写 —— 否则「添加诊断：xxx」执行完界面上看不见，
 * 医生只会以为没生效。
 */
const manualDiagnoses = ref<DiagnosisEntry[]>([])

/** 把界面状态摊成命令解释器认识的形状 */
function diagnosisState(): DiagnosisState {
  const known = new Map<string, string | undefined>(
    (summary.value?.suspected_diagnoses ?? []).map((d) => [d.name, d.icd]),
  )
  for (const d of manualDiagnoses.value) known.set(d.name, d.icd)
  return {
    selected: [...checkedDiagnoses.value].map((name) => {
      const icd = known.get(name)
      return icd ? { name, icd } : { name }
    }),
    primary: primaryDiagnosis.value,
  }
}

/**
 * 执行一条诊断命令。返回 false 表示这不是命令，应交给模型。
 */
function applyDiagnosisCommand(text: string): boolean {
  const result = runDiagnosisCommand(text, diagnosisState())
  if (!result) return false

  checkedDiagnoses.value = new Set(result.state.selected.map((d) => d.name))
  primaryDiagnosis.value = result.state.primary

  // 命令引入的新名字（候选列表里没有的）要留住，否则渲染不出来
  const candidates = new Set(candidateNames.value)
  manualDiagnoses.value = result.state.selected.filter((d) => !candidates.has(d.name))

  chatMessages.value.push({ role: 'assistant', content: result.reply })
  if (result.writeBack) void confirmDiagnoses()
  return true
}

/**
 * 风险等级色点。原件用**内联背景**上色（`style="background: rgb(230,25,26)"`），
 * `.risk-dot` 的 CSS 只有尺寸和圆角、没有颜色 —— 只渲染一个空 span，
 * 点就是透明的，等于看不见。
 */
const RISK_DOT_COLOR: Record<string, string> = {
  danger: '#e6191a',
  warning: '#e6a23c',
  success: '#52c41a',
  info: '#909399',
}

/** 把这条风险的完整依据与建议送进 Copilot 展开讲 */
function explainRisk(risk: RiskItem) {
  activeTab.value = '智慧诊疗'
  void sendChat(`请就「${risk.name}」这条风险展开解读：依据是${risk.evidence || risk.summary}，当前建议是${risk.suggestion || '（无）'}。`)
}

const candidateNames = computed(() => (summary.value?.suspected_diagnoses ?? []).map((d) => d.name))

/**
 * 渲染用的诊断列表：模型给的候选 + 医生手打添加的。
 *
 * 手打的必须并进来 —— 只渲染候选的话，「添加诊断：xxx」执行完界面上看不见，
 * 医生只会以为命令没生效。手打项没有置信度，进度条按 0 渲染。
 */
const diagnosisRows = computed(() => {
  const candidates = summary.value?.suspected_diagnoses ?? []
  const known = new Set(candidates.map((d) => d.name))
  const manual = manualDiagnoses.value
    .filter((d) => !known.has(d.name))
    .map((d) => ({ name: d.name, icd: d.icd, confidence: 0, desc: '医生手动添加' }))
  return [...candidates, ...manual]
})
const allChecked = computed(
  () => candidateNames.value.length > 0 && candidateNames.value.every((n) => checkedDiagnoses.value.has(n)),
)
const someChecked = computed(
  () => checkedDiagnoses.value.size > 0 && !allChecked.value,
)

function toggleAll() {
  checkedDiagnoses.value = allChecked.value ? new Set() : new Set(candidateNames.value)
  if (!checkedDiagnoses.value.size) primaryDiagnosis.value = ''
}

/** 「需鉴别（N）」的展开态，按诊断名记录 */
const expandedDifferentials = ref<Set<string>>(new Set())

function toggleDifferential(name: string) {
  const next = new Set(expandedDifferentials.value)
  next.has(name) ? next.delete(name) : next.add(name)
  expandedDifferentials.value = next
}

/** 可能性徽标配色，与 V4.3 的 .dd-likelihood.high|mid|low 对应 */
function likelihoodClass(likelihood: string) {
  if (likelihood === '高') return 'high'
  if (likelihood === '中') return 'mid'
  return 'low'
}

/**
 * 聚合结果就绪后，默认勾选置信度最高的一条并标为主诊断。
 *
 * 与 V4.3 一致：绝大多数情况下医生就是采纳首选，预勾能省一次点击。
 * 这只是界面预选 —— 回写仍要医生显式确认，且红色风险未闭环照样阻断，
 * 所以预选不会让任何东西被自动写出去。
 */
watch(
  () => summary.value?.suspected_diagnoses,
  (list) => {
    if (!list?.length || checkedDiagnoses.value.size) return
    const top = list[0]
    checkedDiagnoses.value = new Set([top.name])
    primaryDiagnosis.value = top.name
  },
  { immediate: true },
)

/** 回写前置条件：至少一条诊断、必须有主诊断、红色风险已闭环。 */
const writeBackReason = computed(() => {
  if (!checkedDiagnoses.value.size) return '请先勾选要纳入的诊断'
  if (!primaryDiagnosis.value) return '请点击「主」标记一个主诊断'
  if (ws.writeBackBlocked) return `${ws.openRedAlerts.length} 条红色风险未处置`
  return ''
})

async function confirmDiagnoses() {
  if (writeBackReason.value) {
    ElMessage.warning(writeBackReason.value)
    return
  }
  writingBack.value = true
  try {
    await ElMessageBox.confirm(
      `将写回 ${checkedDiagnoses.value.size} 条诊断，主诊断为「${primaryDiagnosis.value}」。一期写入本地库并留审计，不触达真实 HIS。`,
      '确认回写',
      { type: 'warning' },
    )
    const result = await api.diagnosisWriteBack(
      ws.patientId,
      [...checkedDiagnoses.value],
      primaryDiagnosis.value,
      ws.handledAlertIds,
    )
    ElMessage.success(result.message)
    ws.patient = await api.patient(ws.patientId)
  } catch (error) {
    // ElMessageBox 取消会抛字符串 'cancel'，真实错误才提示
    if (error instanceof Error) ElMessage.error(`回写失败：${error.message}`)
  } finally {
    writingBack.value = false
  }
}

// ---------------------------------------------------------------- 风险处置

async function handleAlert(alert: RiskItem) {
  await ElMessageBox.confirm(
    `${alert.summary}\n\n依据：${alert.evidence ?? '—'}\n来源：${alert.source ?? '—'}\n阈值：${alert.threshold ?? '—'}\n建议：${alert.suggestion ?? '—'}`,
    `处置红色风险 · ${alert.name}`,
    { type: 'error', confirmButtonText: '已处置并留痕', cancelButtonText: '稍后处理' },
  )
  try {
    const result = await api.handleAlert(ws.patientId, alert.id, alert.name)
    ws.markAlertHandled(alert.id)
    ElMessage.success(result.message)
  } catch (error) {
    // 没落库就不要标成已处置 —— 否则界面放行了提交，服务端门禁却仍会拦
    ElMessage.error(`处置未能留痕：${(error as Error).message}`)
  }
}

// ---------------------------------------------------------------- 病历生成

const generating = ref(false)
const streamingField = ref('')
/** 智能笔记：医生随手记的要点，作为 note_text 一并送进病历生成 */
const smartNote = ref('')

async function generateRecord() {
  if (!ws.patientId) return
  generating.value = true
  ws.draft = {}
  try {
    await streamSse(
      '/api/emr/copilot/chat',
      { patient_id: ws.patientId, messages: [], generate_record: true, note_text: smartNote.value },
      (event) => {
        if (event.type === 'record_node_start') {
          streamingField.value = String(event.node_id)
          ws.draft = { ...ws.draft, [streamingField.value]: '' }
        } else if (event.type === 'record_token') {
          const key = String(event.node_id)
          ws.draft = { ...ws.draft, [key]: (ws.draft[key] ?? '') + String(event.token) }
        } else if (event.type === 'record_done') {
          streamingField.value = ''
          if (event.degraded) ElMessage.warning('模型不可用，病历为本地规则生成，请人工补全')
        }
      },
    )
  } catch (error) {
    ElMessage.error(`病历生成失败：${(error as Error).message}`)
  } finally {
    generating.value = false
    streamingField.value = ''
  }
}

function acceptField(field: string) {
  ws.acceptDraftField(field)
  ElMessage.success(`已写回「${sectionLabel(field)}」`)
}

function sectionLabel(key: string) {
  return RECORD_SECTIONS.find(([k]) => k === key)?.[1] ?? key
}

const recordCompleteness = computed(() => {
  const filled = RECORD_SECTIONS.filter(([key]) => (ws.record[key] ?? '').trim() && ws.record[key] !== '未采集').length
  return Math.round((filled / RECORD_SECTIONS.length) * 100)
})

// ---------------------------------------------------------------- 医嘱回写

const addingOrder = ref('')
const writingOrders = ref(false)

/** 单条推荐用药加入医嘱单 */
async function addRecommendedOrder(order: { drug: string; dose: string; freq: string; route: string }) {
  addingOrder.value = order.drug
  try {
    await api.createOrder({
      patient_id: ws.patientId,
      drug: order.drug,
      dose: order.dose,
      freq: order.freq,
      route: order.route,
      days: '30',
    })
    ElMessage.success(`「${order.drug}」已加入医嘱单`)
    ws.patient = await api.patient(ws.patientId)
  } catch (error) {
    ElMessage.error(`加入失败：${(error as Error).message}`)
  } finally {
    addingOrder.value = ''
  }
}

/** 整单回写：把全部推荐用药与推荐检查一次性开出 */
async function writeBackAllOrders() {
  const drugs = summary.value?.recommended_orders ?? []
  const exams = summary.value?.recommended_exams ?? []
  if (!drugs.length && !exams.length) {
    ElMessage.warning('没有可回写的推荐医嘱')
    return
  }
  if (ws.writeBackBlocked) {
    ElMessage.warning(`${ws.openRedAlerts.length} 条红色风险未处置，已阻断回写`)
    return
  }

  await ElMessageBox.confirm(
    `将开立 ${drugs.length} 条用药、${exams.length} 项检查。一期写入本地库并留审计，不触达真实 HIS。`,
    '确认回写到医嘱',
    { type: 'warning' },
  )

  writingOrders.value = true
  try {
    for (const order of drugs) {
      await api.createOrder({
        patient_id: ws.patientId,
        drug: order.drug,
        dose: order.dose,
        freq: order.freq,
        route: order.route,
        days: '30',
      })
    }
    for (const exam of exams) {
      await api.createExam({
        patient_id: ws.patientId,
        name: exam.name,
        type: '检验',
        route: '门诊',
        freq: '一次',
      })
    }
    ElMessage.success(`已回写 ${drugs.length + exams.length} 条医嘱（本地库 + 审计）`)
    ws.patient = await api.patient(ws.patientId)
  } catch (error) {
    ElMessage.error(`回写失败：${(error as Error).message}`)
  } finally {
    writingOrders.value = false
  }
}

// ---------------------------------------------------------------- 智能笔记检索

/**
 * 智能笔记的「检」按钮：按关键词检索本次问诊内容。
 * 原件 title 是「检索语音就诊内容」（本版改为「检索本次问诊内容」）—— 它不是重新生成病历。
 */
const noteHits = ref<{ role: string; text: string }[]>([])

function searchVoiceContent() {
  const keyword = smartNote.value.trim()
  if (!keyword) {
    ElMessage.warning('先在智能笔记里输入关键词')
    return
  }
  const source = voice.messages.value.length ? voice.messages.value : (summary.value?.dialog_script ?? [])
  noteHits.value = source.filter((turn) => turn.text.includes(keyword))
  ElMessage.info(
    noteHits.value.length ? `在问诊内容里命中 ${noteHits.value.length} 处` : `问诊内容里没有「${keyword}」`,
  )
}

// ---------------------------------------------------------------- 共病

const requestingConsult = ref(false)

async function requestNutritionConsult() {
  requestingConsult.value = true
  try {
    const result = await api.comorbidityConsultation(ws.patientId, true)
    ElMessage.success(result.message)
  } catch (error) {
    ElMessage.error(`会诊申请失败：${(error as Error).message}`)
  } finally {
    requestingConsult.value = false
  }
}

// ---------------------------------------------------------------- 病历卡体征

/** 病历卡的体征行与左侧 HIS 表单同源，只读展示，不重复维护一份数据 */
const cardVitals = computed(() => {
  const v = (patient.value?.vitals ?? {}) as Record<string, string | number>
  const bp = String(v.bp ?? '').match(/(\d+)\s*\/\s*(\d+)/)
  return [
    { label: '身高', value: v.height ?? '', unit: 'CM', isBp: false, systolic: '', diastolic: '' },
    { label: '体重', value: v.weight ?? '', unit: 'KG', isBp: false, systolic: '', diastolic: '' },
    { label: 'BMI', value: v.bmi ?? '', unit: '', isBp: false, systolic: '', diastolic: '' },
    { label: '体温', value: v.temp ?? '', unit: '℃', isBp: false, systolic: '', diastolic: '' },
    { label: '脉搏', value: v.hr ?? '', unit: '次/分', isBp: false, systolic: '', diastolic: '' },
    { label: '呼吸', value: v.breath ?? '', unit: '次/分', isBp: false, systolic: '', diastolic: '' },
    { label: '血压', value: '', unit: 'mmHg', isBp: true, systolic: bp?.[1] ?? '', diastolic: bp?.[2] ?? '' },
    { label: '心率', value: v.hr ?? '', unit: '次/分', isBp: false, systolic: '', diastolic: '' },
  ]
})

// ---------------------------------------------------------------- 随访计划

const planningFollowUp = ref(false)

/**
 * 生成随访计划：让智能体按本次时间轴与待办产出随访安排，
 * 结果进对话区供医生审阅 —— 不直接落库，与其他 AI 产出一致。
 */
async function generateFollowUpPlan() {
  planningFollowUp.value = true
  try {
    await sendChat('请根据本次就诊的时间轴与待办事项，给出随访计划：复查项目、时间间隔与需要观察的指标。')
    activeTab.value = '智慧诊疗'
    ElMessage.success('随访计划已生成在医生智能体对话区，确认后可写入病历')
  } finally {
    planningFollowUp.value = false
  }
}

// ---------------------------------------------------------------- 病历质控


const GAP_PREVIEW = 4
const quality = ref<RecordQuality | null>(null)

/** 质控明细的图标：红线 / 未采集 / 建议项，三者必须一眼可分 */
const QC_ICONS: Record<string, string> = { error: '❌', warning: '⚠️', info: 'ℹ️' }

/** 被质控提醒点中的那一段，短暂高亮 */
const focusedField = ref<string | null>(null)

/** 医生最近一次确认「已审阅质控提醒」的时刻 */
const qcReviewedAt = ref<string | null>(null)

let focusTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 点质控提醒 → 定位到对应那一段病历。
 *
 * 原件只做 scrollIntoView。但目标段本来就在视野里时，滚动等于没动，
 * 医生完全不知道点上没有 —— 所以补一个 1.6 秒的高亮做反馈。
 * 只加边框与底色，不改尺寸与布局。
 */
function focusRecordField(key: string) {
  focusedField.value = key
  clearTimeout(focusTimer)
  focusTimer = setTimeout(() => { focusedField.value = null }, 1600)

  nextTick(() => {
    const node = document.querySelector(`[data-record-node="${key}"]`)
    // 测试 DOM 里没有 scrollIntoView，不设防会抛未捕获异常，把整轮测试判失败
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  })
}

/**
 * 医生确认「已审阅质控提醒」。
 *
 * 只收起明细并记一次确认，**不清空遗漏** —— 审阅代表看过，不代表病历改好了。
 * 把遗漏一并抹掉，等于用一次点击给红线消音，下一个接手的人再也看不到。
 */
async function markQcReviewed() {
  try {
    const result = await api.qcReview(ws.patientId, quality.value?.gaps?.length ?? 0)
    showAllGaps.value = false
    qcReviewedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    ElMessage.success(result.message)
  } catch (error) {
    ElMessage.error(`审阅未能留痕：${(error as Error).message}`)
  }
}
const showAllGaps = ref(false)

const visibleGaps = computed(() => {
  const gaps = quality.value?.gaps ?? []
  return showAllGaps.value ? gaps : gaps.slice(0, GAP_PREVIEW)
})

/**
 * 质控由后端的确定性规则算，不让模型给自己的输出打分。
 * 病历一变就重算 —— 医生边改边看得到完整度与遗漏的变化。
 */
async function refreshQuality() {
  if (!ws.patientId) return
  const fields = Object.fromEntries(
    RECORD_SECTIONS.map(([key]) => [key, ws.draft[key] ?? ws.record[key] ?? '']),
  )
  try {
    quality.value = await api.recordQuality(ws.patientId, fields)
  } catch {
    quality.value = null
  }
}

function showQualityDetail() {
  const metrics = quality.value?.metrics ?? []
  ElMessageBox.alert(
    metrics.map((m) => `${m.name}：${m.value}%\n　　依据：${m.basis}`).join('\n\n') || '暂无质控数据',
    '质控详情',
    { confirmButtonText: '知道了' },
  )
}

watch(
  () => [ws.patientId, ws.record, ws.draft],
  () => void refreshQuality(),
  { deep: true, immediate: true },
)

// ---------------------------------------------------------------- 时间轴

interface TimelineEvent {
  time?: string
  type?: string
  category?: string
  action?: string
  detail?: string
  result?: string
  analysisHint?: string
}

/** 异常判定沿用原件：detail 或 result 里带箭头或「异常」二字 */
function isAbnormalEvent(event: TimelineEvent) {
  const text = `${event.detail ?? ''}${event.result ?? ''}`
  return /[↑↓]|异常/.test(text)
}

function showTimelineAnalysis(event: TimelineEvent) {
  ElMessageBox.alert(event.analysisHint ?? '', `AI 分析 · ${event.action ?? ''}`, {
    confirmButtonText: '知道了',
    type: isAbnormalEvent(event) ? 'warning' : 'info',
  })
}

// ---------------------------------------------------------------- 健康档案

const ARCHIVE_FILTERS = ['全部', '门诊', '住院', '急诊'] as const
const archiveFilter = ref<(typeof ARCHIVE_FILTERS)[number]>('全部')
const expandedVisits = ref<Set<string>>(new Set())

interface VisitRecord {
  id: string
  datetime?: string
  date?: string
  visit_type: string
  dept: string
  diagnosis: string
  icd?: string
  record_id?: string
  chief_complaint?: string
  course?: string
  exam_points?: string
  plan?: string
  labs?: { name: string; value: string; unit?: string; ref?: string; abnormal?: string }[]
  exams?: { name: string; result: string }[]
}

interface HealthArchive {
  primary_disease?: string
  diagnosis_date?: string
  diagnoses?: string[]
  treatments?: string[]
}

const archive = computed(() => (patient.value?.health_archive ?? {}) as HealthArchive)
const visits = computed(() => ((patient.value?.visit_history ?? []) as VisitRecord[]))

const visibleVisits = computed(() =>
  archiveFilter.value === '全部'
    ? visits.value
    : visits.value.filter((v) => v.visit_type === archiveFilter.value),
)

/** 概览里的「8 次展示 · 住 1 / 门 6 / 急 1」 */
const visitSummary = computed(() => {
  const all = visits.value
  if (!all.length) return '—'
  const count = (type: string) => all.filter((v) => v.visit_type === type).length
  return `${all.length} 次展示 · 住 ${count('住院')} / 门 ${count('门诊')} / 急 ${count('急诊')}`
})

/** 概览里的「1917 天（2021-03-18 ~ 2026-06-17）」 */
const visitSpan = computed(() => {
  const dates = visits.value
    .map((v) => (v.datetime || v.date || '').slice(0, 10))
    .filter(Boolean)
    .sort()
  if (dates.length < 2) return dates[0] ?? '—'
  const first = dates[0]
  const last = dates[dates.length - 1]
  const days = Math.round((Date.parse(last) - Date.parse(first)) / 86400000)
  return `${days} 天（${first} ~ ${last}）`
})

function visitTypeClass(type: string) {
  if (type === '住院') return 'inpatient'
  if (type === '急诊') return 'emergency'
  return 'outpatient'
}

function toggleVisit(id: string) {
  const next = new Set(expandedVisits.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expandedVisits.value = next
}

// ---------------------------------------------------------------- 专项评估目录

const catalog = ref<{ name: string; count: number; items: { name: string; level: string; desc: string; default_expanded?: boolean }[] }[]>([])

/**
 * 专项评估小助手的默认态：**五个分类全部折叠**（2026-09-02 产品决策）。
 *
 * 与 V4.3 原件不同 —— 原件默认全展开。一期只做目录展示、33 项都还没 Agent 化，
 * 铺开占掉大半屏，把下面真正在用的内容挤没了；折叠起来当索引用。
 *
 * 展开态本身仍与原件一致，所以两道界面闸照旧比得了 —— 但它们的
 * prepare/collect 必须先把分类点开，否则比的是「默认态差异」而不是「漏做」。
 * `check-v43-coverage.mjs` 的 `ensureAssessmentVisible` 就是干这个的。
 */
const expandedCategories = ref<Set<string>>(new Set())

function toggleCategory(name: string) {
  const next = new Set(expandedCategories.value)
  next.has(name) ? next.delete(name) : next.add(name)
  expandedCategories.value = next
}

// ---------------------------------------------------------------- 专项评估展开

const expandedSkills = ref<Set<string>>(new Set())

function toggleSkill(name: string) {
  const next = new Set(expandedSkills.value)
  next.has(name) ? next.delete(name) : next.add(name)
  expandedSkills.value = next
}

// ---------------------------------------------------------------- 共病操作

const remindingPatient = ref(false)

async function remindPatient() {
  remindingPatient.value = true
  try {
    const result = await api.remind([ws.patientId])
    ElMessage.success(result.message)
  } catch (error) {
    ElMessage.error(`提醒失败：${(error as Error).message}`)
  } finally {
    remindingPatient.value = false
  }
}

/** 发起共病会诊：非营养专项，走全科协同 */
async function requestComorbidityConsult() {
  requestingConsult.value = true
  try {
    const result = await api.comorbidityConsultation(ws.patientId, false)
    ElMessage.success(result.message)
  } catch (error) {
    ElMessage.error(`会诊申请失败：${(error as Error).message}`)
  } finally {
    requestingConsult.value = false
  }
}

// ---------------------------------------------------------------- 手动新增诊断

async function addManualDiagnosis() {
  try {
    const { value } = await ElMessageBox.prompt('输入诊断名称，将并入待勾选列表', '新增诊断', {
      inputPlaceholder: '如：糖尿病周围神经病变',
      inputValidator: (v: string) => (v?.trim() ? true : '诊断名称不能为空'),
    })
    const name = String(value).trim()
    if (!summary.value) return
    // 医生手写的诊断没有模型证据，置信度留空并标注来源，不伪装成 AI 推断
    summary.value.suspected_diagnoses = [
      ...summary.value.suspected_diagnoses,
      {
        name,
        confidence: 0,
        icd: '',
        desc: '医生手动新增，未经模型评估。',
        rank_label: '备选',
        rank_key: 'is-alt',
        likelihood: '低',
        differentials: [],
      },
    ]
    checkedDiagnoses.value = new Set([...checkedDiagnoses.value, name])
  } catch {
    // 取消
  }
}

// ---------------------------------------------------------------- 对话

/**
 * 对话逻辑与移动端对话页共用同一个 composable —— 同一个流式端点、同一套
 * 知识库匹配。抄一份到移动端的话，以后修一个必漏一个。
 *
 * 诊断命令通过 onCommand 注入，不下沉到公共层：它读写的是本组件的勾选
 * 状态，移动端没有诊断面板，执行了也看不见。
 */
const {
  chatInput,
  chatMessages,
  chatting,
  chatScrollEl,
  kbHits,
  kbDialogOpen,
  kbEntry,
  kbLoading,
  scrollToBottom,
  openKnowledge,
  sendChat,
} = useCopilotChat({
  patientId: () => ws.patientId,
  // 诊断命令在本地结算，不走模型：结果必须确定，而且要立刻反映到勾选状态上。
  // 交给模型的话，「删除诊断」可能被答成一段说明文字，界面纹丝不动。
  onCommand: (text) => applyDiagnosisCommand(text),
})

/** 对话区自动滚到底，让新播出的一条始终可见。问诊对话也计入。 */
watch(() => [voice.messages.value.length, chatMessages.value.length], scrollToBottom)

// ---------------------------------------------------------------- 生成与更新

/**
 * 「生成」与「更新」是两种不同性质的动作，刻意分开：
 *
 *   生成 → 起草一份新东西（病历七段），走 copilot/chat，约 10 秒
 *   更新 → 把已有分析按新信息重算（概况/诊断/风险/共病），走 report-summary，约 20 秒
 *
 * 合成一个按钮的话，医生只改了智能笔记也要等 20 秒的重算；分开之后各付各的时间。
 */

const finishing = ref(false)
const actionStep = ref('')

/* ===================== AI 追问提示浮框 ===================== */

/**
 * 「AI 追问提示」：问诊**进行中**浮在面板右上角的清单，问到一条划掉一条。
 *
 * ## 这个功能撤过一次，又回来了
 *
 * 2026-09-02 撤掉，理由是「一期没有临床知识库，追问做不准，对医生是干扰」。
 * 2026-09-04 恢复 —— **那条理由对当时的做法成立，对现在这版不成立**，
 * 差别在清单从哪来：当初是教科书式的鉴别问诊清单（「问 Levine 征」，
 * 需要知识库），现在是**这位患者档案里明摆着的缺口**（「过敏史空着，
 * 没人问过」），后者不需要任何知识库。
 *
 * 中间还有一个过渡版（2026-09-03 的「问诊提示浮框」）：点「生成」或「暂停」
 * 才弹一次，内容是问诊小结的 gaps，静态、不划掉、不能拖。**这一版把它替掉了** ——
 * 同一个右上角不放两个浮框。
 *
 * | 当初（已撤） | 过渡版 | 现在 |
 * | --- | --- | --- |
 * | 常驻，一开始就挂一列 | 点生成/暂停才弹 | 攒够 3 条对话自动浮出 |
 * | 关不掉 | 可缩小、可关闭 | 可缩小、可关闭、**可拖动** |
 * | 已问到的不管 | 不划掉 | **问到一条划掉一条** |
 * | 没内容也占位 | 空则不显示 | 空则不显示 |
 *
 * 判错的方向见 `useFollowUp.ts` 的三条不变量：单调、非阻塞、拿不准就不划。
 */
const hintMinimized = ref(false)
/** 医生按过「✕」。本轮不再自动弹 —— 他已经明确说过不需要。 */
const hintDismissed = ref(false)
/** 医生手动收起过。与 dismissed 不同：收起还能再展开，关闭是本轮不再自动弹。 */
const hintOpen = ref(false)

/** 有内容才可能显示。空清单一律不弹，绝不弹空框。 */
const hasHints = computed(() => followUp.hasItems.value)

/**
 * 自动浮出的判据：**攒够几条对话**，且清单里还有没问的。
 *
 * 不在问诊一开始就弹：那时一条都没划掉，浮框看起来像在催人。
 * 也不在「清单全划完」时弹：那时它没有任何要说的。
 */
const shouldAutoOpen = computed(
  () =>
    !hintDismissed.value &&
    voice.messages.value.length >= AUTO_OPEN_AFTER_MESSAGES &&
    followUp.pending.value.length > 0,
)

watch(shouldAutoOpen, (ready) => {
  if (ready) {
    hintOpen.value = true
    hintMinimized.value = false
  }
})

/**
 * 对话每推进一条，让追问提示自己决定要不要跑判定。
 *
 * **不 await** —— 它是提示，不在关键路径上；一次判定 4–6 秒，
 * 而对话每 1.4 秒推进一条，等它会让整个播放卡住。
 */
watch(
  () => voice.messages.value.length,
  (n) => {
    if (n > 0) void followUp.advance(voice.messages.value)
  },
)

/**
 * 问诊一开始就把清单取回来（**盯状态，不在 start() 调用点挂钩子**——
 * start() 有三处调用点，挨个挂必然漏一处，而漏掉的那处表现为
 * 「这个入口进来就是没有提示」，很难联想到原因）。
 *
 * 回到 idle 说明换了病人或重来一遍，整份清单连同「医生关过」的标记一起清掉。
 */
watch(
  () => voice.state.value,
  (now, before) => {
    if (now === 'idle') {
      followUp.reset()
      hintOpen.value = false
      hintMinimized.value = false
      return
    }
    if (before === 'idle') void followUp.loadPlan()
  },
)

function closeHints() {
  hintOpen.value = false
  hintDismissed.value = true
  // 「被关掉多少次」是这个功能有没有用的最直接信号
  track('hints_dismiss', '', { pending: voice.hints.value.length })
}

/** 暂停/生成时把浮框叫出来 —— 医生停下来，通常就是在想「还该问什么」。 */
function offerHints() {
  if (hintDismissed.value || !hasHints.value) return
  hintOpen.value = true
  hintMinimized.value = false
}

/**
 * 暂停时顺带给提示 —— 医生停下来，通常就是在想「还该问什么」。
 *
 * 只在**暂停**那一下给，继续时不给：正在问的时候弹东西是打断。
 */
function onToggleCapture() {
  const wasPlaying = voice.state.value === 'playing'
  voice.toggleCapture()
  track('interview_toggle', wasPlaying ? 'pause' : 'resume')
  if (wasPlaying) offerHints()
}

/**
 * 「生成」：用**此刻已有的问诊内容**重算全部下游产出。
 *
 * 病情概况、鉴别诊断、风险、共病都是打开工作站时算好的，也就是在问诊之前。
 * 不回灌一次，医生问出来的新信息就进不了那些面板，这一场问诊等于白做。病历同理。
 *
 * 顺序：落库问诊记录 → 重算聚合分析 → 重新起草病历。
 * 落库必须在最前 —— 下游上下文（latest_dialog）读的是持久化后的记录。
 *
 * ## 为什么它不再结束问诊
 *
 * 原来这个按钮叫「结束问诊」，红色，点下去 `finish()` 把状态置为 ended。
 * 那把两件事绑死了：**想看看 AI 怎么说** 和 **我问完了**。
 * 医生问了三句想瞄一眼分析，就得先把问诊终结掉，要接着问还得再点「继续」。
 *
 * 现在只 `persist()` 不 `finish()` —— 生成多少次都行，问诊状态一动不动。
 * 「结束」这件事本身交给医生关掉浮窗或接诊下一位，不需要一个专门的红色按钮。
 */
async function generateNow() {
  if (!ws.patientId || finishing.value) return
  finishing.value = true
  // 「一场问诊里点了几次生成」直接说明这个按钮的定位对不对 ——
  // 当初就是因为它绑死了「看一眼」和「问完了」才改的
  track('generate', '', { patient_id: ws.patientId, turns: voice.messages.value.length })
  try {
    // 落库自己会判空（persist 里 `!messages.length` 直接返回），这里不必再判。
    actionStep.value = voice.messages.value.length ? '落库问诊记录…' : '准备…'
    await voice.persist()

    actionStep.value = '重新分析病情、诊断与风险…'
    // 走状态机：interview/complete 已在服务端把这一场标为「问诊解锁」，
    // 这里重拉状态再算，八个标签页随之解锁。
    await ws.unlockAndAnalyse('interview')
    if (ws.summaryError) throw new Error(ws.summaryError)

    actionStep.value = '起草病历…'
    await generateRecord()

    // 生成完自动展开 AI 助手：这一刻医生要看的正是刚算出来的东西。
    // 标上「刚刚自动展开」，免得界面自己变了而医生不知道是什么触发的。
    tipsOpen.value = true
    justAutoExpanded.value = true
    offerHints()
    ElMessage.success('已按当前问诊内容生成')
  } catch (error) {
    ElMessage.error(`生成失败：${(error as Error).message}`)
  } finally {
    finishing.value = false
    actionStep.value = ''
  }
}

// ---------------------------------------------------------------- 接诊流转

/**
 * 接诊下一位：按候诊队列顺序切到下一个患者，走到队尾回候诊列表。
 * 与 V4.3 的同名按钮一致，是问诊结束后的主要去向。
 */
const router = useRouter()

/* ===================== ＋ 菜单 ===================== */

/** 五条常用提示词，逐字取自 V4.3，改动即偏离原件 */
const PROMPT_PRESETS = [
  '请根据检查结果给出初步诊断',
  '请分析患者的用药风险',
  '请评估该患者的并发症风险',
  '请生成门诊随访计划',
  '请解读最近一次血糖报告',
]

const plusMenuOpen = ref(false)
const promptsOpen = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)

/** 每次点 ＋ 都把二级菜单重置为收起，与原件一致 */
function togglePlusMenu() {
  plusMenuOpen.value = !plusMenuOpen.value
  promptsOpen.value = false
}

function closePlusMenu() {
  plusMenuOpen.value = false
  promptsOpen.value = false
}

/** 选中提示词只填进输入框，不直接发出去 */
function pickPrompt(text: string) {
  chatInput.value = text
  closePlusMenu()
}

function chooseUpload(kind: 'file' | 'image') {
  plusMenuOpen.value = false
  const input = kind === 'file' ? fileInputRef.value : imageInputRef.value
  input?.click()
}

/**
 * 只把文件名回显进对话，不发请求、不落存储 —— 一期不接收任何真实患者文件。
 * 回显格式与原件一致。
 */
function onFilePicked(event: Event, label: '上传文件' | '上传图片') {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) chatMessages.value.push({ role: 'user', content: `[${label}] ${file.name}` })
  input.value = ''
}

function goPatientManage() {
  closePlusMenu()
  router.push('/outpatient/manage')
}


/**
 * 接诊下一位：按候诊队列顺序切到下一个患者，走到队尾回候诊列表。
 * 与 V4.3 的同名按钮一致，是问诊结束后的主要去向。
 */
function nextPatient() {
  const queue = ws.queue
  const index = queue.findIndex((p) => p.id === ws.patientId)
  const next = queue[index + 1]
  if (next) router.push(`/outpatient/${next.id}`)
  else router.push('/outpatient/list')
}

// ---------------------------------------------------------------- 语音问诊

/** 问诊已开始时，输入框用于补录患者所述；否则用于向智能体提问。 */
const inVoice = computed(() => voice.state.value !== 'idle')

function submitInput() {
  const text = chatInput.value.trim()
  if (!text) return
  chatInput.value = ''
  if (inVoice.value) voice.recordPatientUtterance(text)
  else sendChat(text)
}

const quickSkills = computed(() => {
  const dept = patient.value?.dept ?? ''
  if (dept.includes('内分泌')) {
    return [
      { icon: '🩸', label: '血糖控制评估' },
      { icon: '💊', label: '高血压复诊套餐' },
      { icon: '🔍', label: '并发症风险筛查' },
      { icon: '✅', label: '用药审核优化' },
      { icon: '📋', label: '多病共存管理' },
    ]
  }
  if (dept.includes('心内')) {
    return [
      { icon: '❤️', label: '胸痛评估' },
      { icon: '💊', label: '抗栓方案审核' },
      { icon: '📈', label: '心功能分级' },
      { icon: '🔍', label: 'ASCVD 风险分层' },
      { icon: '📋', label: '多病共存管理' },
    ]
  }
  return [
    { icon: '🧠', label: '卒中风险评估' },
    { icon: '💊', label: '二级预防审核' },
    { icon: '📈', label: '神经功能评分' },
    { icon: '🔍', label: '复发风险筛查' },
    { icon: '📋', label: '多病共存管理' },
  ]
})

onMounted(async () => {
  // 点页面任意处收起 ＋ 菜单（＋ 按钮自己 .stop，不会被这个监听立刻关掉）
  document.addEventListener('click', closePlusMenu)
  try {
    catalog.value = (await api.assessmentCatalog()).categories
    // 分类默认全折叠 —— 不预置任何一个（见 expandedCategories 的说明）。
    //
    // 条目内部的展开态照旧跟着数据走：`default_expanded` 标了的先展开，
    // 这样医生点开分类时看到的层次与原件一致。默认态跟数据走，
    // 不在组件里写死条目名（组件禁止写死临床数据）。
    expandedSkills.value = new Set(
      catalog.value.flatMap((c) => c.items.filter((i) => i.default_expanded).map((i) => i.name)),
    )
  } catch {
    // 目录加载失败不影响主流程，界面显示空目录即可
  }
})

onBeforeUnmount(() => document.removeEventListener('click', closePlusMenu))
</script>

<template>
  <div class="ai-emr-root">
    <!--
      医生智能体收起后的桌面卡通（D1「微笑」）。位置沿用原件圆钮的
      right:24px / bottom:32px —— 医生上一版在哪找它，这一版还在哪。

      三个入参都是**透传**，卡通自己不算任何数：
      - hint-count 与问诊提示浮框同源，两处对不上医生不知道该信哪个
      - thinking 跟着分析走，让它在忙的时候看起来在忙
    -->
    <AgentMascot
      v-if="showRoundEntry"
      :hint-count="voice.hints.value.length"
      :thinking="ws.loadingSummary || finishing"
      @open="restoreAgentPanel"
    />
    <div ref="wrapperEl" class="ai-float-wrapper" :style="wrapperStyle">
      <!-- ======================= AI 助手 ======================= -->
      <!--
        AI 助手收起时，它原来占的位置不能就这么空着 —— HIS 门面撤掉之后，
        那是整个页面最大的一块，空着会让人以为「页面没加载完」。
        放一张说明卡：讲清为什么现在没有结论，以及两条出路。
      -->
      <!--
        这里原本是「AI 助手待问诊后展开」的说明卡（.assistant-placeholder / .ap-card）。
        **2026-09-03 整块删除。**

        它占着 AI 助手收起后腾出的一整片区域，讲的是「为什么现在还没有结论」——
        而那件事界面已经说过两遍了：八个标签页上挂着 🔒，医生智能体里有门禁说明卡。
        同一个道理讲三遍，第三遍就只是挡住底下的 HIS。

        （做 HIS 门面时还发现它 `flex:1` 且吃点击，把底下的医嘱页签全挡死了 ——
        当时是给它加 `pointer-events:none` 放行的。现在整块没了，那条补丁也随之作废。）
      -->
      <!--
        AI 助手的调宽边线。**拖它改的是整个组合的左边线** ——
        抽屉是 flex:1，它的左边线就是 .ai-float-wrapper 的左边线，
        所以这里调的是组合总宽（抽屉宽 = 总宽 − 面板宽）。
        双击恢复默认。
      -->
      <div
        v-if="tipsOpen && !maxi.maximized.value"
        class="resize-edge"
        :class="{ active: drawerSize.resizing.value }"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整 AI 助手宽度，双击恢复默认"
        title="拖动调整宽度 · 双击恢复默认"
        @pointerdown="drawerSize.onPointerDown"
        @dblclick="drawerSize.reset"
      />
      <div
        v-if="tipsOpen"
        v-show="!maxi.isHidden('drawer')"
        ref="drawerShell"
        class="tips-drawer connected-right"
        :class="{ undocked: !dock.merged.value, dragging: dock.dragging.value === 'drawer', 'will-snap': dock.willSnap.value }"
        :style="{ ...dock.styleFor('drawer').value, ...drawerHeight.style.value, ...maxi.styleFor('drawer').value }"
      >
        <div
          class="tips-header"
          title="拖动移动窗口 · 双击恢复默认布局"
          @pointerdown="beginDrag('drawer', $event)"
          @dblclick="dock.resetLayout"
        >
          <span class="tips-title"><span class="panel-ai-dot" />AI 助手</span>
          <div class="tips-header-actions">
            <el-tag v-if="ws.isDegraded" size="small" type="warning" effect="plain">降级</el-tag>
            <el-button
              text
              size="small"
              class="tips-action-btn win-max"
              :title="maxi.isMax('drawer') ? '退出全屏（Esc）' : '全屏'"
              :aria-label="maxi.isMax('drawer') ? '退出全屏' : '全屏'"
              @click="maxi.toggle('drawer'); track('window_maximize', 'drawer', { on: maxi.isMax('drawer') })"
            >{{ maxi.isMax('drawer') ? '⛶' : '⛶' }}</el-button>
            <el-button text size="small" class="tips-close" @click="tipsOpen = false">×</el-button>
          </div>
        </div>

        <div class="tips-tab-nav">
          <div
            v-for="tab in TABS"
            :key="tab"
            class="ttab"
            :class="{ active: activeTab === tab, locked: tabLocked(tab) }"
            :title="tabLocked(tab) ? '待问诊结束后生成' : ''"
            @click="activeTab = tab; track('tab_switch', tab)"
          >
            <span v-if="tabLocked(tab)" class="ttab-lock">🔒</span>{{ tab }}
            <span v-if="tab === '诊断管理' && summary?.suspected_diagnoses?.length" class="ttab-dot primary">
              {{ summary.suspected_diagnoses.length }}
            </span>
            <span v-if="tab === '共病管理' && summary?.comorbidity?.nutrition?.triggered" class="ttab-dot danger">营</span>
            <span v-if="tab === '预警评估' && ws.openRedAlerts.length" class="ttab-dot danger">
              {{ ws.openRedAlerts.length }}
            </span>
          </div>
        </div>

        <div v-loading="ws.loadingSummary" class="tips-tab-body" :style="font.style.value">
          <!--
            锁定说明。**整页让位给它**，而不是显示一个空面板 ——
            空面板会让医生以为「分析跑失败了」，而不是「还没到时候」。

            也不让标签页消失：消失会让人以为系统没这功能（与移动端 ＋ 菜单
            里那三个「工作站专属」同一个道理）。
          -->
          <div v-if="activeLocked" class="gate-pane">
            <div class="gate-card">
              <div class="gate-icon">🔒</div>
              <div class="gate-title">AI 分析待问诊后生成</div>
              <p class="gate-why">
                病情概要、鉴别诊断、共病管理、病历草稿这四块，是模型<b>基于本次问诊</b>推断的。
                问诊前给出结论会让医生先看到答案再去找证据 —— 那是锚定，不是辅助。
              </p>
              <p class="gate-why">
                预警评估、医嘱管理、健康档案、时间轴来自 HIS 已有数据与纯代码硬规则，与问诊无关，现在就能点。
              </p>
              <div class="gate-actions">
                <el-button type="primary" size="small" :loading="voice.state.value === 'playing'" @click="voice.start()">
                  ● 开始问诊
                </el-button>
                <el-button size="small" :loading="unlocking" @click="skipInterview">跳过问诊，直接分析</el-button>
              </div>
              <p class="gate-foot">
                跳过入口不能少：复诊、患者不配合、医生已自行问完 —— 这些情况下分析不能因此永远出不来。
              </p>
              <!--
                进度改成「已录几轮」。原来是「追问提示 N/M 已问到」——
                那个分母来自已撤掉的追问清单，而且它表达的是「模型觉得你还该问几条」，
                本身就是这次要去掉的那种未经知识库支撑的判断。
                已录轮数是纯事实，不需要任何模型判断。
              -->
              <div v-if="voice.active.value" class="gate-progress">
                <span class="gate-progress-text">
                  问诊进行中 · 已录 {{ voice.messages.value.length }} 轮
                </span>
              </div>
            </div>
          </div>

          <!--
            解锁后的横幅。标明「含本次问诊」还是「未含问诊」——
            跳过路径下必须如实标，否则医生会以为这份分析听过患者说话。
          -->
          <div v-else-if="ws.analysisUnlocked && INTERVIEW_GATED.includes(activeTab)" class="gate-banner"
            :class="{ skipped: !ws.interviewIncluded }">
            <span v-if="ws.interviewIncluded">✓ 已按本次问诊生成</span>
            <span v-else>⚠ 未含问诊 · 仅基于 HIS 已有资料</span>
            <span class="gate-banner-meta">
              <template v-if="ws.interviewIncluded">对话 {{ voice.messages.value.length }} 轮</template>
              <template v-else>随后可点「开始问诊」，问完重算一次</template>
            </span>
          </div>

          <!-- ---------------- 智慧诊疗 ---------------- -->
          <div v-if="!tabLocked('智慧诊疗')" v-show="activeTab === '智慧诊疗'" class="tips-tab-pane">
            <div ref="columnsEl" class="analysis-columns">
              <div class="analysis-left" :style="{ flex: `0 0 calc(${leftRatio}% - 4px)` }">
                <div class="condition-overview-card">
                  <div class="coc-header">
                    <span class="coc-title">AI病情概要</span>
                    <el-tag v-if="summary?.overall_conclusion?.risk_level" size="small" effect="light" round
                      :type="summary.overall_conclusion.risk_level.includes('高') ? 'danger' : 'warning'">
                      {{ summary.overall_conclusion.risk_level }}
                    </el-tag>
                  </div>
                  <div class="coc-summary">
                    <p>{{ summary?.overall_conclusion?.summary || '智能体分析中…' }}</p>
                  </div>
                  <div v-if="summary?.overall_conclusion?.problems?.length" class="coc-summary">
                    <p v-for="problem in summary.overall_conclusion.problems" :key="problem">· {{ problem }}</p>
                  </div>
                  <div v-if="summary?.overall_conclusion?.conflicts?.length" class="coc-summary">
                    <p v-for="conflict in summary.overall_conclusion.conflicts" :key="conflict">
                      <strong>信息冲突：</strong>{{ conflict }}
                    </p>
                  </div>
                </div>

                <div class="dd-card">
                  <div class="dd-header">
                    <el-checkbox
                      class="dd-title-check"
                      :model-value="allChecked"
                      :indeterminate="someChecked"
                      title="全选诊断"
                      @change="toggleAll"
                    />
                    <span class="dd-title">鉴别诊断</span>
                    <button class="todo-action-btn tab-record dd-confirm-btn" @click="confirmDiagnoses">确认诊断</button>
                  </div>

                  <div class="dd-rec-list">
                    <div
                      v-for="item in summary?.suspected_diagnoses ?? []"
                      :key="item.name"
                      class="dd-rec-item"
                      :class="{
                        primary: item.rank === 0,
                        selected: checkedDiagnoses.has(item.name),
                        focus: primaryDiagnosis === item.name,
                      }"
                    >
                      <div class="dd-card-main">
                        <el-checkbox
                          class="todo-item-check dd-card-check"
                          :model-value="checkedDiagnoses.has(item.name)"
                          @change="toggleDiagnosis(item.name)"
                        />
                        <div class="dd-card-body">
                          <div class="dd-card-top">
                            <span class="dd-primary-tag dd-rank-tag" :class="item.rank_key">{{ item.rank_label }}</span>
                            <span class="dd-primary-name" @click="markPrimary(item.name)">{{ item.name }}</span>
                            <em v-if="item.icd" class="dd-icd">{{ item.icd }}</em>
                          </div>
                          <p class="dd-reason">{{ item.desc }}</p>
                        </div>
                      </div>

                      <div class="dd-inline-panel">
                        <div class="dd-inline-summary">
                          <div class="dd-diff-block">
                            <div class="dd-diff-label dd-diff-toggle" @click="toggleDifferential(item.name)">
                              <span>需鉴别</span>
                              <span class="dd-diff-count">（{{ item.differentials?.length ?? 0 }}）</span>
                              <span class="dd-diff-arrow" :class="{ open: expandedDifferentials.has(item.name) }">›</span>
                            </div>
                            <div v-if="expandedDifferentials.has(item.name)" class="dd-diff-body">
                              <div v-for="(other, i) in item.differentials ?? []" :key="other.name" class="dd-diff-row">
                                <span class="dd-diff-idx">{{ i + 1 }}</span>
                                <div class="dd-diff-main">
                                  <div class="dd-diff-title">
                                    <span class="dd-diff-name">{{ other.name }}</span>
                                    <span class="dd-likelihood sm" :class="likelihoodClass(other.likelihood)">
                                      {{ other.likelihood }}
                                    </span>
                                  </div>
                                  <p class="dd-reason">{{ other.reason }}</p>
                                </div>
                              </div>
                              <div v-if="item.suggestion" class="dd-suggest">
                                <span class="dd-suggest-label">建议</span>
                                <span>{{ item.suggestion }}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div v-if="!summary?.suspected_diagnoses?.length" class="diag-empty">
                      {{ ws.loadingSummary ? '智能体分析中…' : '暂无鉴别诊断' }}
                    </div>
                  </div>
                </div>

                <!-- 风险提示：红/黄分级 + 逐条「查看建议」，与 V4.3 的 risk-alert-section 一致 -->
                <div v-if="summary?.risk_assessments?.length" class="risk-alert-section">
                  <div class="ra-header">
                    <div class="ra-title">风险提示</div>
                  </div>
                  <div class="ra-list">
                    <div
                      v-for="risk in summary.risk_assessments"
                      :key="risk.id"
                      class="ra-card"
                      :class="risk.color === 'danger' ? 'ra-card-danger' : 'ra-card-warning'"
                    >
                      <div class="ra-card-body">
                        <div
                          class="ra-card-name"
                          :class="risk.color === 'danger' ? 'ra-name-danger' : 'ra-name-warning'"
                        >
                          {{ risk.name }}
                        </div>
                        <div class="ra-card-suggestion">{{ risk.summary }}</div>
                      </div>
                      <button class="ra-view-btn" @click="handleAlert(risk)">查看建议</button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="analysis-resize-handle" title="拖动调整左右宽度" @mousedown="startResize" />

              <div class="analysis-right" :style="{ flex: `0 0 calc(${100 - leftRatio}% - 4px)` }">
                <div class="record-card">
                  <div class="rc-header">
                    <span class="rc-title">病历</span>
                    <el-button
                      type="primary"
                      size="small"
                      link
                      title="按本次问诊重新起草病历七段"
                      :loading="generating"
                      @click="generateNow"
                    >
                      AI 生成
                    </el-button>
                  </div>
                  <div class="rc-body">
                    <!-- 智能笔记：医生随手记的要点，作为 note_text 参与病历生成。
                         对应 V4.3 的 smart-note-row，是病历卡的第一行。 -->
                    <div class="rc-row smart-note-row">
                      <span class="rc-label">智能笔记</span>
                      <div class="rc-field smart-note-field">
                        <textarea v-model="smartNote" placeholder="输入关键词，点击“检”检索本次问诊内容" />
                      </div>
                      <button
                        class="rc-writeback-icon smart-note-search"
                        title="检索本次问诊内容"
                        @click="searchVoiceContent"
                      >
                        检
                      </button>
                    </div>

                    <!-- 检索命中：点一条把该句并入智能笔记，供病历生成参考 -->
                    <div v-if="noteHits.length" class="rc-row">
                      <span class="rc-label">命中</span>
                      <div class="rc-field">
                        <div
                          v-for="(hit, i) in noteHits"
                          :key="i"
                          class="note-hit-item"
                          :title="'点击并入智能笔记'"
                          @click="smartNote = `${smartNote}｜${hit.text}`"
                        >
                          {{ hit.role === 'doctor' ? '医生' : '患者' }}：{{ hit.text }}
                        </div>
                      </div>
                      <button class="rc-writeback-icon" title="清空检索结果" @click="noteHits = []">清</button>
                    </div>

                    <template v-for="[key, label] in RECORD_SECTIONS" :key="key">
                      <div class="rc-row" :class="{ 'rc-row-single': key === 'chief_complaint' }">
                        <span class="rc-label">{{ label }}</span>
                        <div class="rc-field">
                          <textarea :value="ws.draft[key] ?? ws.record[key] ?? ''" readonly rows="2" />
                        </div>
                        <button class="rc-writeback-icon" title="回写至 HIS" @click="acceptField(key)">回</button>
                      </div>

                      <!-- 体征行紧跟个人史之后，与左侧 HIS 表单同源，只读展示 -->
                      <div v-if="key === 'personal_history'" class="rc-row rc-vitals-row">
                        <span class="rc-label">体征</span>
                        <div class="rc-field rc-vitals-field">
                          <div v-for="v in cardVitals" :key="v.label" class="rc-vital" :class="{ 'rc-vital-bp': v.isBp }">
                            <span class="rc-vk">{{ v.label }}</span>
                            <template v-if="v.isBp">
                              <input class="rc-bp" :value="v.systolic" readonly />
                              <span class="rc-slash">/</span>
                              <input class="rc-bp" :value="v.diastolic" readonly />
                            </template>
                            <template v-else>
                              <input :value="v.value" readonly />
                              <span v-if="v.unit" class="rc-vu">{{ v.unit }}</span>
                            </template>
                          </div>
                        </div>
                        <button class="rc-writeback-icon" title="回写至 HIS" @click="acceptField('physical_exam')">回</button>
                      </div>
                    </template>
                  </div>
                </div>

                <div class="key-assessment-section">
                  <div class="ka-header"><div class="ka-title">专项评估小助手</div></div>
                  <div class="ka-categories">
                    <div v-for="category in catalog" :key="category.name" class="ka-category">
                      <div class="ka-cat-header" @click="toggleCategory(category.name)">
                        <div class="ka-cat-title"><span class="ka-cat-name">{{ category.name }}</span></div>
                        <span class="ka-cat-count">{{ category.count }}项</span>
                        <span class="ka-cat-arrow" :class="{ expanded: expandedCategories.has(category.name) }">›</span>
                      </div>
                      <div v-if="expandedCategories.has(category.name)" class="ka-list">
                        <div
                          v-for="item in category.items"
                          :key="item.name"
                          class="ka-card"
                          :class="[`ka-card-${item.level}`, { collapsed: !expandedSkills.has(item.name) }]"
                        >
                          <div class="ka-card-body">
                            <div class="ka-card-title-row" title="展开/收起说明" @click="toggleSkill(item.name)">
                              <div class="ka-card-name">{{ item.name }}</div>
                              <span class="ka-card-toggle" :class="{ expanded: expandedSkills.has(item.name) }">›</span>
                            </div>
                            <div v-if="expandedSkills.has(item.name)" class="ka-card-detail-row" title="查看预警评估">
                              <div class="ka-card-detail"><div class="ka-card-assessment">{{ item.desc }}</div></div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ---------------- 预警评估 ---------------- -->
          <div v-show="activeTab === '预警评估'" class="tips-tab-pane">
            <div class="risk-assess-block">
              <div class="tab-section-title">专项评估</div>
              <div v-for="risk in riskCards" :key="risk.id" class="risk-card">
                <div class="risk-card-header">
                  <span class="risk-dot" :style="{ background: RISK_DOT_COLOR[risk.color] ?? RISK_DOT_COLOR.info }" />
                  <span class="risk-name">{{ risk.name }}</span>
                  <el-tag size="small" round effect="light" :type="risk.color === 'danger' ? 'danger' : risk.color === 'warning' ? 'warning' : 'success'">
                    {{ risk.level }}
                  </el-tag>
                  <div class="risk-actions">
                    <el-button type="primary" size="small" link @click="explainRisk(risk)">大模型解读</el-button>
                    <el-button size="small" link title="在 Copilot 中放大展示" @click="explainRisk(risk)">↗</el-button>
                    <el-button v-if="risk.level === '高风险'" type="primary" size="small" link @click="handleAlert(risk)">
                      {{ ws.openRedAlerts.some((a) => a.id === risk.id) ? '处置' : '✓ 已处置' }}
                    </el-button>
                  </div>
                </div>
                <p class="risk-summary"><strong>依据：</strong>{{ risk.evidence || '—' }}</p>
                <p class="risk-summary">{{ risk.assessment || risk.summary }}</p>
                <p class="risk-summary"><strong>建议：</strong>{{ risk.suggestion || '—' }}</p>
                <p v-if="risk.source" class="risk-summary"><strong>来源：</strong>{{ risk.source }}<template v-if="risk.threshold"> · 阈值 {{ risk.threshold }}</template></p>
              </div>
              <div v-if="!summary?.risk_assessments?.length" class="diag-empty">
                <!--
                  「暂无风险项」在未评估时是误导 —— 它读起来像「已评估、没风险」，
                  而实际是根本还没评估。这两种状态对医生的意义完全相反。
                -->
                <template v-if="ws.loadingSummary">智能体分析中…</template>
                <template v-else-if="!ws.analysisUnlocked">
                  硬规则已扫描，未发现危急值与过敏冲突。<b>模型风险评估待问诊后生成</b> ——
                  这不等于「无风险」，只是还没评。
                </template>
                <template v-else>暂无风险项</template>
              </div>
            </div>
          </div>

          <!-- ---------------- 病历管理 ---------------- -->
          <div v-if="!tabLocked('病历管理')" v-show="activeTab === '病历管理'" class="tips-tab-pane record-pane">
            <div class="record-layout">
              <div class="record-main">
                <div class="btab-writeback-bar">
                  <el-button type="success" size="small" class="writeback-primary-btn" @click="ws.acceptAllDraft()">
                    ✔ 确认并回写到病历
                  </el-button>
                  <span class="record-complete-badge">病历完整度 {{ quality?.completeness ?? 0 }}%</span>
                  <span class="writeback-hint">AI 草稿需确认后才进入正式病历</span>
                </div>
                <div
                  v-for="[key, label] in RECORD_SECTIONS"
                  :key="key"
                  class="record-node"
                  :class="{ focused: focusedField === key }"
                  :data-record-node="key"
                >
                  <div class="node-header">
                    <span class="node-title">{{ label }}</span>
                    <el-button type="primary" size="small" link class="node-writeback-btn" @click="acceptField(key)">
                      回写此字段
                    </el-button>
                  </div>
                  <div class="node-content">{{ ws.draft[key] ?? ws.record[key] ?? '未采集' }}</div>
                </div>
              </div>

              <aside class="record-qc-side">
                <div class="rc-side-card rc-risk-card">
                  <div class="rc-side-head warn">
                    <span class="rc-side-icon">⚠</span>
                    <span class="rc-side-title">病历风险与遗漏</span>
                  </div>
                  <div class="rc-risk-list">
                    <div v-for="(gap, i) in visibleGaps" :key="i" class="rc-risk-row">
                      <span class="rc-risk-dot" :class="gap.level === 'danger' ? 'warn' : gap.level" />
                      <span class="rc-risk-text">{{ gap.text }}</span>
                      <span class="rc-risk-status" :class="gap.level === 'danger' ? 'warn' : gap.level">
                        {{ gap.status }}
                      </span>
                    </div>
                    <div v-if="!quality?.gaps?.length" class="rc-risk-row">
                      <span class="rc-risk-dot ok" />
                      <span class="rc-risk-text">未发现明显遗漏</span>
                      <span class="rc-risk-status ok">已确认</span>
                    </div>
                  </div>
                  <button type="button" class="rc-side-more" @click="showAllGaps = !showAllGaps">
                    {{ showAllGaps ? '收起' : `查看全部 ${quality?.gaps?.length ?? 0} 处遗漏` }} <span>›</span>
                  </button>

                  <!-- 展开后的逐条明细：点一条跳到对应那一段病历去改 -->
                  <div v-if="showAllGaps && quality?.gaps?.length" class="rc-qc-detail">
                    <div
                      v-for="(gap, i) in quality.gaps"
                      :key="i"
                      class="qc-item"
                      :class="gap.type"
                      @click="focusRecordField(gap.field_key)"
                    >
                      <span class="qc-icon">{{ QC_ICONS[gap.type] ?? 'ℹ️' }}</span>
                      <div class="qc-body">
                        <span class="qc-field">【{{ gap.field }}】</span>
                        <span class="qc-issue">{{ gap.issue }}</span>
                      </div>
                    </div>
                    <el-button
                      type="warning"
                      plain
                      size="small"
                      class="qc-reviewed-btn"
                      style="width: 100%; margin-top: 6px"
                      @click="markQcReviewed"
                    >我已审阅质控提醒</el-button>
                  </div>
                </div>

                <div class="rc-side-card rc-qc-card">
                  <div class="rc-side-head ok">
                    <span class="rc-side-icon">✓</span>
                    <span class="rc-side-title">质控与完整性</span>
                  </div>
                  <div class="rc-qc-list">
                    <div v-for="metric in quality?.metrics ?? []" :key="metric.name" class="rc-qc-row" :title="metric.basis">
                      <span class="rc-qc-check">✓</span>
                      <span class="rc-qc-name">{{ metric.name }}</span>
                      <span class="rc-qc-pill">{{ metric.value }}%</span>
                    </div>
                    <div v-if="!quality" class="rc-qc-row">
                      <span class="rc-qc-name">质控计算中…</span>
                    </div>
                  </div>
                  <button type="button" class="rc-side-more ok" @click="showQualityDetail">查看质控详情 <span>›</span></button>
                </div>
              </aside>
            </div>
          </div>

          <!-- ---------------- 诊断管理 ---------------- -->
          <div v-if="!tabLocked('诊断管理')" v-show="activeTab === '诊断管理'" class="tips-tab-pane">
            <div class="tab-section">
              <div class="tab-section-title">
                疑似诊断
                <el-button type="primary" size="small" link class="diag-add-link" @click="addManualDiagnosis">
                  + 新增诊断
                </el-button>
              </div>
              <p class="susp-hint">勾选拟纳入诊断；点击右侧 <strong>主</strong> 标记指定主诊断</p>
              <div class="suspected-list">
                <div
                  v-for="item in diagnosisRows"
                  :key="item.name"
                  class="suspected-item"
                  :class="{ selected: checkedDiagnoses.has(item.name), primary: primaryDiagnosis === item.name }"
                >
                  <div class="susp-conf-bar" :style="{ width: `${item.confidence}%` }" />
                  <span class="susp-checkbox" @click="toggleDiagnosis(item.name)">
                    <span v-if="checkedDiagnoses.has(item.name)" class="susp-check-mark">✓</span>
                  </span>
                  <div class="susp-main" @click="toggleDiagnosis(item.name)">
                    <div class="susp-top">
                      <span class="susp-name">{{ item.name }}</span>
                      <span class="susp-conf">{{ item.confidence }}%</span>
                      <em v-if="item.icd" class="susp-icd">{{ item.icd }}</em>
                    </div>
                    <div class="susp-desc">{{ item.desc }}</div>
                  </div>
                  <button
                    class="primary-mark-btn"
                    :class="{ active: primaryDiagnosis === item.name }"
                    @click="markPrimary(item.name)"
                  >
                    主
                  </button>
                </div>
              </div>

              <div class="diag-selection-actions">
                <div class="diag-selected-summary">
                  已选 <strong>{{ checkedDiagnoses.size }}</strong> 条诊断
                  <span v-if="primaryDiagnosis"> · 主诊断：<strong>{{ primaryDiagnosis }}</strong></span>
                </div>
                <el-tooltip :content="writeBackReason" :disabled="!writeBackReason" placement="top">
                  <span>
                    <el-button type="primary" size="small" :disabled="!!writeBackReason" :loading="writingBack" @click="confirmDiagnoses">
                      确认并回写 HIS
                    </el-button>
                  </span>
                </el-tooltip>
              </div>
            </div>
          </div>

          <!-- ---------------- 医嘱管理 ---------------- -->
          <div v-show="activeTab === '医嘱管理'" class="tips-tab-pane">
            <div class="treat-panel">
              <div class="treat-section-head">
                <div class="treat-section-title">推荐用药</div>
                <span class="treat-section-count">{{ summary?.recommended_orders?.length ?? 0 }} 项</span>
              </div>

              <div class="btab-writeback-bar">
                <el-button
                  type="success"
                  size="small"
                  class="writeback-primary-btn"
                  :loading="writingOrders"
                  @click="writeBackAllOrders"
                >
                  ✔ 确认并回写到医嘱
                </el-button>
                <span class="writeback-hint">
                  {{ ws.writeBackBlocked ? `${ws.openRedAlerts.length} 条红色风险未处置，回写被阻断` : '回写后写入本地医嘱表并留审计' }}
                </span>
              </div>
              <div class="treat-list">
                <div v-for="order in summary?.recommended_orders ?? []" :key="order.drug" class="treat-card">
                  <div class="treat-top">
                    <div class="treat-drug-wrap"><span class="treat-drug">{{ order.drug }}</span></div>
                    <el-button
                      type="primary"
                      size="small"
                      link
                      class="treat-writeback-btn"
                      :loading="addingOrder === order.drug"
                      @click="addRecommendedOrder(order)"
                    >
                      添加到医嘱单
                    </el-button>
                  </div>
                  <div class="treat-spec">{{ order.dose }} · {{ order.freq }} · {{ order.route }}</div>
                  <div class="treat-basis">{{ order.basis }}</div>
                </div>
                <div v-if="!summary?.recommended_orders?.length" class="diag-empty">暂无推荐用药</div>
              </div>

              <div class="treat-section-head exam">
                <div class="treat-section-title">推荐检查</div>
                <span class="treat-section-count">{{ summary?.recommended_exams?.length ?? 0 }} 项</span>
              </div>
              <div class="exam-list">
                <div v-for="exam in summary?.recommended_exams ?? []" :key="exam.id" class="exam-rec-order">
                  <div class="ero-head">
                    <div class="ero-title-wrap">
                      <span class="ero-name">{{ exam.name }}</span>
                      <el-tag size="small" type="warning" effect="plain">检验</el-tag>
                    </div>
                  </div>
                  <div class="ero-spec">门诊 · 一次</div>
                  <div class="ero-basis">{{ exam.basis }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- ---------------- 共病管理 ---------------- -->
          <div v-if="!tabLocked('共病管理')" v-show="activeTab === '共病管理'" class="tips-tab-pane">
            <div class="tab-section">
              <div class="tab-section-title">共病</div>

              <div v-if="summary?.comorbidity?.nutrition?.triggered" class="nutrition-alert-banner">
                <div class="nutrition-alert-head">
                  <span class="nutrition-alert-badge">营养共病</span>
                  <span class="nutrition-alert-title">营养共病提醒</span>
                  <el-tag size="small" type="danger" effect="plain">评分 {{ summary.comorbidity.nutrition.score }} 分</el-tag>
                </div>
                <div class="nutrition-alert-msg">{{ summary.comorbidity.nutrition.message }}</div>
                <div class="nutrition-alert-actions">
                  <el-button type="primary" size="small" :loading="requestingConsult" @click="requestNutritionConsult">
                    申请营养科会诊
                  </el-button>
                </div>
              </div>

              <div class="comorbidity-overview">
                <div v-for="condition in summary?.comorbidity?.conditions ?? []" :key="condition.name" class="comorbidity-condition-card">
                  <div class="condition-header">
                    <span class="condition-name">{{ condition.name }}</span>
                    <el-tag size="small" effect="plain" :type="condition.risk_level === '高危' ? 'danger' : 'warning'">
                      {{ condition.risk_level }}
                    </el-tag>
                    <el-tag v-if="condition.duration" size="small" type="info" effect="plain">{{ condition.duration }}</el-tag>
                  </div>
                  <div class="condition-body">
                    <div class="condition-analysis">{{ condition.analysis }}</div>
                    <div class="condition-dept">
                      <strong>推荐科室：</strong>
                      <el-tag size="small" type="success" effect="light">{{ condition.recommended_dept }}</el-tag>
                    </div>
                  </div>
                </div>
                <div v-if="!summary?.comorbidity?.conditions?.length" class="diag-empty">
                  {{ ws.loadingSummary ? '智能体分析中…' : '未识别到共病' }}
                </div>
              </div>

              <p v-if="summary?.comorbidity?.recommendation" class="risk-summary">
                <strong>协同管理建议：</strong>{{ summary.comorbidity.recommendation }}
              </p>

              <div v-if="summary?.comorbidity?.detected" class="comorbidity-actions-bar">
                <el-button type="warning" :loading="remindingPatient" @click="remindPatient">提醒患者</el-button>
                <el-button type="primary" :loading="requestingConsult" @click="requestComorbidityConsult">
                  发起共病会诊
                </el-button>
              </div>
            </div>
          </div>

          <!-- ---------------- 健康档案 ---------------- -->
          <div v-show="activeTab === '健康档案'" class="tips-tab-pane">
            <div class="tab-section archive-panel">
              <div class="archive-overview">
                <div class="ao-title">疾病与就诊概览</div>
                <div class="ao-row">
                  <span class="ao-k">主病</span>
                  <span class="ao-v strong">{{ archive.primary_disease || '—' }}</span>
                </div>
                <div class="ao-row">
                  <span class="ao-k">诊断日</span>
                  <span class="ao-v">{{ archive.diagnosis_date || '—' }}</span>
                </div>
                <div class="ao-row">
                  <span class="ao-k">诊断</span>
                  <span class="ao-v">{{ (archive.diagnoses ?? []).join('、') || '—' }}</span>
                </div>
                <div class="ao-row">
                  <span class="ao-k">就诊</span>
                  <span class="ao-v">{{ visitSummary }}</span>
                </div>
                <div class="ao-row">
                  <span class="ao-k">跨度</span>
                  <span class="ao-v">{{ visitSpan }}</span>
                </div>
                <div class="ao-row">
                  <span class="ao-k">评估</span>
                  <span class="ao-v">{{ (archive.treatments ?? []).join('、') || '—' }}</span>
                </div>
              </div>

              <div class="archive-toolbar">
                <div class="archive-head">
                  <div class="tab-section-title">全周期时间轴</div>
                  <span class="archive-muted">覆盖门诊 / 住院 / 急诊健康数据</span>
                </div>
                <div class="archive-filters">
                  <button
                    v-for="type in ARCHIVE_FILTERS"
                    :key="type"
                    type="button"
                    class="af-chip"
                    :class="{ active: archiveFilter === type }"
                    @click="archiveFilter = type"
                  >
                    {{ type }}
                  </button>
                </div>
              </div>

              <div class="visit-list">
                <div
                  v-for="visit in visibleVisits"
                  :key="visit.id"
                  class="visit-card"
                  :class="{ expanded: expandedVisits.has(visit.id) }"
                  @click="toggleVisit(visit.id)"
                >
                  <div class="vc-row">
                    <span class="vc-type" :class="visitTypeClass(visit.visit_type)">{{ visit.visit_type }}</span>
                    <span class="vc-time">{{ visit.datetime || visit.date }}</span>
                    <span class="vc-dept">{{ visit.dept }}</span>
                    <span class="vc-toggle" :class="{ expanded: expandedVisits.has(visit.id) }">›</span>
                  </div>
                  <div class="vc-meta">
                    <span>主诊 {{ visit.diagnosis }}<template v-if="visit.icd"> ({{ visit.icd }})</template></span>
                    <span v-if="visit.record_id" class="vc-rid">· record {{ visit.record_id }}</span>
                  </div>
                  <div class="vc-cc">{{ visit.chief_complaint }}</div>

                  <div v-if="expandedVisits.has(visit.id)" class="vc-detail" @click.stop>
                    <div v-if="visit.course" class="vc-detail-row">
                      <span class="vc-detail-label">病程：</span><span class="vc-detail-content">{{ visit.course }}</span>
                    </div>
                    <div v-if="visit.exam_points" class="vc-detail-row">
                      <span class="vc-detail-label">检查要点：</span><span class="vc-detail-content">{{ visit.exam_points }}</span>
                    </div>
                    <div v-if="visit.plan" class="vc-detail-row">
                      <span class="vc-detail-label">处置计划：</span><span class="vc-detail-content">{{ visit.plan }}</span>
                    </div>

                    <div v-if="visit.labs?.length" class="vd-block">
                      <div class="vd-title">检验</div>
                      <table class="vd-table labs">
                        <thead>
                          <tr><th>项目</th><th>结果</th><th>参考</th></tr>
                        </thead>
                        <tbody>
                          <tr v-for="(lab, i) in visit.labs" :key="i">
                            <td>{{ lab.name }}</td>
                            <td :class="{ abnormal: !!lab.abnormal }">
                              {{ lab.value }}{{ lab.unit ?? '' }}<template v-if="lab.abnormal"> {{ lab.abnormal }}</template>
                            </td>
                            <td>{{ lab.ref ?? '—' }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <div v-if="visit.exams?.length" class="vd-block">
                      <div class="vd-title">检查</div>
                      <table class="vd-table">
                        <thead>
                          <tr><th>项目</th><th>结果</th></tr>
                        </thead>
                        <tbody>
                          <tr v-for="(exam, i) in visit.exams" :key="i">
                            <td>{{ exam.name }}</td>
                            <td>{{ exam.result }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <div v-if="!visibleVisits.length" class="diag-empty">该筛选下暂无就诊记录</div>
              </div>
            </div>
          </div>

          <!-- ---------------- 时间轴 ---------------- -->
          <div v-show="activeTab === '时间轴'" class="tips-tab-pane">
            <div class="tab-section">
              <div class="tab-section-title">本次就诊时间轴</div>
              <div class="timeline-list">
                <div v-for="(event, index) in ws.timeline" :key="index" class="timeline-group">
                  <div class="tl-time-tag">{{ event.time }}</div>
                  <div class="tl-group-card">
                    <div class="tl-group-header">
                      <span class="tl-group-action">{{ event.action }}</span>
                    </div>
                    <div class="tl-sub-section" :class="event.type">
                      <div v-if="event.type !== 'system'" class="tl-sub-label">
                        {{ event.type === 'ai' ? 'AI' : '医生' }}
                      </div>
                      <div class="tl-sub-item-wrap">
                        <div
                          class="tl-sub-item"
                          :class="{ 'tl-lab-exam': !!event.category, 'tl-abnormal': isAbnormalEvent(event) }"
                        >
                          <div class="tl-sub-main">
                            <span v-if="event.category" class="tl-cat-tag" :class="event.category">
                              {{ event.category === 'lab' ? '检验' : '检查' }}
                            </span>
                            <span class="tl-sub-action">{{ event.action }}</span>
                            <span v-if="isAbnormalEvent(event)" class="tl-abnormal-tag">异常</span>
                            <span class="tl-sub-detail" :class="{ 'tl-detail-abnormal': isAbnormalEvent(event) }">
                              {{ event.detail }}
                            </span>
                            <el-button
                              v-if="event.analysisHint"
                              type="primary"
                              size="small"
                              link
                              class="tl-ai-btn"
                              @click="showTimelineAnalysis(event)"
                            >
                              AI 分析
                            </el-button>
                          </div>
                          <div v-if="event.result" class="tl-result-body" :class="{ abnormal: isAbnormalEvent(event) }">
                            {{ event.result }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-if="!ws.timeline.length" class="diag-empty">暂无时间轴事件</div>
              </div>

              <div v-if="ws.timeline.length" class="timeline-actions">
                <el-button type="primary" size="small" plain :loading="planningFollowUp" @click="generateFollowUpPlan">
                  生成随访计划并标记完成
                </el-button>
              </div>
            </div>
          </div>
        </div>
        <!--
          下边线：拖它改高度。只有下边线能拉 —— 两个窗都锚在顶部
          （wrapper top:15px），上边线拖不动，和「靠右停靠所以只有左边线
          能拉宽」是同一个道理。双击恢复默认。
        -->
        <div
          class="resize-edge-bottom"
          :class="{ active: drawerHeight.resizing.value }"
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整AI 助手高度，双击恢复默认"
          title="拖动调整高度 · 双击恢复默认"
          @pointerdown="drawerHeight.onPointerDown"
          @dblclick="drawerHeight.reset"
        />
      </div>

      <!-- ======================= 医生智能体 ======================= -->
      <!--
        医生智能体的调宽边线。
        它和抽屉把手（.assistant-handle）在同一条边上 —— 把手贴在**面板内壁**、
        占中间 52px 且 z-index 更高，这条边线在它外侧，两者不抢同一块区域。
      -->
      <div
        v-if="panelOpen && !maxi.maximized.value"
        class="resize-edge"
        :class="{ active: panelSize.resizing.value }"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整医生智能体宽度，双击恢复默认"
        title="拖动调整宽度 · 双击恢复默认"
        @pointerdown="panelSize.onPointerDown"
        @dblclick="panelSize.reset"
      />
      <div
        v-if="panelOpen"
        v-show="!maxi.isHidden('panel')"
        ref="panelShell"
        class="assistant-panel connected-left"
        :class="{ undocked: !dock.merged.value, dragging: dock.dragging.value === 'panel' }"
        :style="{ ...dock.styleFor('panel').value, ...panelSize.style.value, ...panelHeight.style.value, ...maxi.styleFor('panel').value }"
      >
        <div
          class="panel-header"
          title="拖动移动窗口 · 双击恢复默认布局"
          @pointerdown="beginDrag('panel', $event)"
          @dblclick="dock.resetLayout"
        >
          <span class="panel-title"><span class="panel-ai-dot" />医生智能体</span>
          <div class="panel-header-actions">
            <!--
              字号。放在医生智能体这边而不是 AI 助手：这个窗口**一直在**
              （AI 助手可以整个关掉），设置该挂在关不掉的那个上。
              两个窗共用一个字号 —— 各调各的必然会漂。
            -->
            <el-popover
              v-model:visible="fontMenuOpen"
              placement="bottom-end"
              trigger="click"
              :width="150"
              popper-class="font-pop"
            >
              <template #reference>
                <el-button
                  text
                  size="small"
                  class="panel-action-btn font-btn"
                  title="调整字号"
                  aria-label="调整字号"
                >Aa</el-button>
              </template>
              <div class="font-menu">
                <div class="font-menu-title">字号</div>
                <!-- 选项本身就用对应字号显示 —— 选之前先看见效果 -->
                <button
                  v-for="lv in font.levels"
                  :key="lv.key"
                  class="font-opt"
                  :class="{ on: lv.key === font.level.value.key }"
                  :style="{ fontSize: `${11 * lv.scale}px` }"
                  @click="font.setLevel(lv.key); fontMenuOpen = false; track('font_change', lv.key)"
                >
                  <span>{{ lv.label }}</span>
                  <span class="font-opt-pct">{{ Math.round(lv.scale * 100) }}%</span>
                </button>
              </div>
            </el-popover>
            <!--
              **「—」不是「×」。**
              医生智能体没有「关掉就没了」这个状态 —— 缩起来的东西一直在
              右下角待着（D1 卡通），点它就回来。

              原来这里是 ×，只靠 title 说明它其实是最小化。不够：
              提这个功能的人自己都没找到入口，两次问「怎么缩小」。
              图形本身就该说清楚，靠 tooltip 补救的语义等于没有。

              也**不再给一个额外的「彻底关掉」** —— 两个按钮做同一件事
              只会让人犹豫点哪个；真做一个「关了就没」的，就又造出一条
              回不来的死路，这个项目已经踩过两次了。
            -->
            <el-button
              text
              size="small"
              class="panel-action-btn win-max"
              :title="maxi.isMax('panel') ? '退出全屏（Esc）' : '全屏'"
              :aria-label="maxi.isMax('panel') ? '退出全屏' : '全屏'"
              @click="maxi.toggle('panel'); track('window_maximize', 'panel', { on: maxi.isMax('panel') })"
            >⛶</el-button>
            <el-button
              text
              size="small"
              class="panel-action-btn panel-close"
              title="缩成卡通（收到右下角，点它可还原）"
              aria-label="缩成卡通，收到右下角"
              @click="panelOpen = false; track('panel_minimize')"
            >—</el-button>
          </div>
        </div>

        <!--
          AI 助手抽屉把手 —— **贴在本面板的左内壁**。

          它在面板**内部**（`position:absolute; left:0`），左边直角、右边圆角：
          读起来像从框壁上伸出的一个小舌片，明确属于医生智能体。

          之前它是面板的兄弟节点、flex 行里独立一列 —— 那样会在两块之间
          撑出一道空隙，看着像浮在中间、不属于任何一边。

          放进面板要满足一个约束：`.assistant-panel` 带 `overflow:hidden`（裁圆角），
          所以把手**不能探出左边线**，只能整个待在里面。正文因此让出 26px 左内距
          （`.chat-area`），不让它压住患者气泡。
        -->
        <button
          class="assistant-handle"
          :class="{ expanded: tipsOpen, attention: justAutoExpanded }"
          type="button"
          :title="tipsOpen ? '收起 AI 助手' : '展开 AI 助手（病历、鉴别诊断、风险、共病）'"
          :aria-label="tipsOpen ? '收起 AI 助手' : '展开 AI 助手'"
          :aria-expanded="tipsOpen"
          @click="tipsOpen = !tipsOpen; justAutoExpanded = false"
        >
          <span class="ah-chevron">{{ tipsOpen ? '›' : '‹' }}</span>
        </button>

        <!--
          AI 助手的展开开关。**做成一整块带说明的卡片，不是一个小箭头** ——
          它要承担「AI 助手是医生智能体的延伸」这个意思，一个 ‹ › 承担不起，
          而且医生第一次用时根本不知道那里可以点。

          收起态是虚线灰框（看着「还没打开」），展开态是实线蓝框加蓝底
          （看着「正开着」）。两种状态的差别要一眼可辨，否则等于没有状态。
        -->
        <!--
          AI 追问提示。浮在患者信息行下方、面板右侧 —— **不挡患者身份**，
          那一行是核对身份用的，最不该被遮。

          三态：展开 / 缩小成胶囊 / 关闭；可拖动。空清单整个不渲染。
        -->
        <FollowUpHints
          v-if="hintOpen && hasHints"
          v-model:minimized="hintMinimized"
          :items="followUp.items.value"
          @close="closeHints"
        />

        <div class="copilot-tab-bar" :style="font.style.value">
          <div class="ctab active">
            <span class="patient-tab-name">{{ patient?.name }}</span>
            <span class="patient-tab-meta">{{ patientMeta }}</span>
            <!--
              过敏标记。**红色在这个产品里只给临床风险**（F06：不得用红色表示
              普通删除、加载失败或表单校验），所以这个位置以前挂的那个红色「语」
              标记已经删掉 —— 它标的是「语音问诊模式」，而一期根本没有语音识别，
              等于用最强的颜色标了一个不存在的状态。

              三态，不是两态：
                有过敏 → 红标 + 过敏原（**必须写出是什么**，只写「有过敏」等于没说）
                已否认 → 不给标记，干净就是信息
                未采集 → 黄标。这不是「没有过敏」，是没人问过。
            -->
            <span
              v-if="allergy.status === 'confirmed'"
              class="allergy-badge danger"
              :title="`药物过敏史：${allergy.items.join('、')}`"
            >⚠ {{ allergy.items[0] }}过敏<template v-if="allergy.items.length > 1"> +{{ allergy.items.length - 1 }}</template></span>
            <span
              v-else-if="allergy.status === 'unknown'"
              class="allergy-badge warn"
              title="本次就诊未采集药物过敏史，开具处方前需补问"
            >? 过敏史未采集</span>
          </div>
        </div>

        <div class="chat-area" :style="font.style.value">
          <div ref="chatScrollEl" class="chat-messages">
            <div v-if="!chatMessages.length && !voice.messages.value.length" class="quick-skill-area">
              <div class="quick-skill-title">本科常用 Skill</div>
              <div class="quick-skill-grid">
                <div v-for="skill in quickSkills" :key="skill.label" class="skill-chip" @click="sendChat(skill.label)">
                  <span class="skill-chip-icon">{{ skill.icon }}</span>
                  <span class="skill-chip-label">{{ skill.label }}</span>
                </div>
              </div>
            </div>

            <!-- 问诊对话气泡：医生绿、患者蓝，与 V4.3 一致 -->
            <div v-for="(turn, index) in voice.messages.value" :key="`v${index}`" class="msg-bubble" :class="turn.role">
              <div class="bubble-meta">
                <span class="bubble-role">{{ turn.role === 'doctor' ? '医生' : '患者' }}</span>
              </div>
              <div class="bubble-content">{{ turn.text || '…' }}</div>
            </div>

            <!-- 与智能体的普通问答 -->
            <div v-for="(message, index) in chatMessages" :key="`c${index}`" class="msg-bubble" :class="message.role === 'user' ? 'doctor' : 'patient'">
              <div class="bubble-meta">
                <span class="bubble-role">{{ message.role === 'user' ? '医生' : 'AI' }}</span>
              </div>
              <div class="bubble-content">{{ message.content || '…' }}</div>
              <!-- 命中的知识库条目：原件嵌在回复 HTML 里，这里挂成按钮 -->
              <div v-if="kbHits.get(index)?.length" class="kb-links">
                <button
                  v-for="hit in kbHits.get(index)"
                  :key="hit.key"
                  class="kb-link"
                  @click="openKnowledge(hit.key)"
                >{{ hit.title }}</button>
              </div>
            </div>

            <div v-if="actionStep" class="voice-ready-hint">⚡ {{ actionStep }}</div>
            <div v-if="voice.error.value" class="voice-ready-hint">{{ voice.error.value }}</div>
          </div>

          <div class="action-bar">
            <el-button v-if="voice.state.value === 'idle'" type="primary" size="small" @click="voice.start()">
              ● 开始问诊
            </el-button>

            <!--
              问诊中两个按钮，各管一件互不相干的事：

              **继续 / 暂停** 是同一个按钮的两态。原先是「继续问诊」在进行中被
              禁用 —— 那等于医生想停一下时没有出路，只能等它播完，
              或者点那个红色的「结束问诊」把整场终结掉。
              「我想停一下」和「我问完了」是完全不同的两个意图。

              文字只留「继续 / 暂停」，不带「问诊」二字：它就长在问诊面板里，
              上下文已经说明了对象，重复一遍只是把两个字的按钮撑成四个字。
              和右边的「生成」也就对齐成了两字对两字。

              **生成** 随时可点、可重复点，只落库不结束问诊。
              医生问了三句想瞄一眼 AI 怎么说，不该为此把问诊终结掉。
              也因此它不是红色 —— 红色在本产品里是「危险/不可逆」，
              而这个动作既不危险也可以再来一次。
            -->
            <template v-else>
              <!--
                主次分明（2026-09-03 定的方案 B）：
                「继续/暂停」是**过程控制**，做成描边次级按钮；
                「生成」是这一屏真正的产出动作，独占实心蓝。

                原先两个都是实心、还是不同色系（蓝 + 绿），视觉权重一样重 ——
                医生要挨个读才知道该点哪个。主操作只能有一个。
              -->
              <el-button
                class="ib-secondary"
                :class="{ paused: voice.state.value !== 'playing' }"
                size="small"
                plain
                :title="voice.state.value === 'playing' ? '暂停（已录内容保留）' : '继续记录，或补充患者所述'"
                @click="onToggleCapture"
              >
                {{ voice.state.value === 'playing' ? '暂停' : '继续' }}
              </el-button>

              <el-button
                class="ib-primary"
                type="primary"
                size="small"
                :loading="finishing"
                title="按此刻已有的问诊内容生成病历与全部分析。可以随时点，也可以再点一次重算。"
                @click="generateNow"
              >
                生成
              </el-button>
            </template>
          </div>

          <div class="chat-input-wrap">
            <div class="chat-textarea-wrap">
              <el-input
                v-model="chatInput"
                class="chat-textarea"
                type="textarea"
                :rows="2"
                :placeholder="inVoice ? '补充患者所述内容…' : '发消息或补充内容...'"
                @keyup.enter.exact="submitInput"
              />
              <div class="chat-float-actions">
                <button class="float-voice-btn" title="继续记录问诊内容" @click="voice.resumeCapture()">
                  🎤
                </button>
                <button class="float-send-btn" :disabled="chatting" @click="submitInput">↑</button>
              </div>
            </div>
            <div class="chat-toolbar">
              <!--
                这里原本是 .tb-left，里面是「＋」菜单：上传文件 / 上传图片 /
                常用提示词 / 患者管理 / 技能管理。**一期整块撤掉**（2026-09-03）——
                五项没有一项是这一期要交付的能力，留着只会让医生点进去发现每条都不通。
                患者管理与技能管理在别处有正经入口。
              -->
              <div class="tb-actions">
                <button class="tb-action-btn" @click="nextPatient">接诊下一位</button>
                <!--
                  「报告解读」2026-09-03 撤掉：一期不做。
                  「鉴别诊断」改名「科室看板」—— **内容待定**，所以它现在
                  只切到智慧诊疗页，不假装已经有一个看板。
                  等看板定义清楚再接上去；在那之前，一个点了跳到别处的按钮
                  比一个点了弹「敬请期待」的按钮诚实。
                -->
                <button class="tb-action-btn" @click="activeTab = '智慧诊疗'">科室看板</button>
              </div>
            </div>
          </div>
        </div>
        <!--
          下边线：拖它改高度。只有下边线能拉 —— 两个窗都锚在顶部
          （wrapper top:15px），上边线拖不动，和「靠右停靠所以只有左边线
          能拉宽」是同一个道理。双击恢复默认。
        -->
        <div
          class="resize-edge-bottom"
          :class="{ active: panelHeight.resizing.value }"
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整医生智能体高度，双击恢复默认"
          title="拖动调整高度 · 双击恢复默认"
          @pointerdown="panelHeight.onPointerDown"
          @dblclick="panelHeight.reset"
        />
      </div>

    </div>

    <!--
      技能管理对话框 2026-09-03 删除：它唯一的入口是「＋」菜单，
      而「＋」按一期范围整块撤掉了 —— 留着就是**打不开的死代码**。
      （撤「＋」时我先写了句「技能管理在别处有正经入口」，
      查了一遍发现那是错的：全仓只有那一个入口。写注释前得先验证。）
    -->
    <!-- 临床知识库词条 -->
    <el-dialog v-model="kbDialogOpen" :title="kbEntry?.title ?? '临床知识库'" width="680px" class="kb-dialog" append-to-body>
      <div v-if="kbLoading" class="kb-loading">加载中…</div>
      <!--
        eslint-disable-next-line vue/no-v-html
        正文是本仓库静态提供的结构化 HTML，无用户输入或模型输出参与拼接；
        「不含可执行标记」由后端一条测试把守（见 test_api.py）。
      -->
      <div v-else-if="kbEntry" class="kb-body" v-html="kbEntry.content" />
      <template #footer>
        <el-button @click="kbDialogOpen = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped src="../styles/AiEmrFloat.scoped.css"></style>
