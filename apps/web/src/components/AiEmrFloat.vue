<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import { api, streamSse, type RiskItem } from '../api'
import { RECORD_SECTIONS, useWorkstation } from '../stores/workstation'
import { useVoiceInterview } from '../composables/useVoiceInterview'

const ws = useWorkstation()

const TABS = ['智慧诊疗', '预警评估', '病历管理', '诊断管理', '医嘱管理', '共病管理', '健康档案', '时间轴'] as const
type Tab = (typeof TABS)[number]

const activeTab = ref<Tab>('智慧诊疗')
const tipsOpen = ref(true)
const panelOpen = ref(true)

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

const voice = useVoiceInterview(() => ws.patientId)

const summary = computed(() => ws.summary)
const patient = computed(() => ws.patient)

/**
 * 两个浮层的位置。
 *
 * V4.3 把 position/right/top 写成内联样式（由 JS 按面板几何算出），
 * CSS 里只有观感没有位置 —— 只搬 CSS 会让浮层塌到文档流里。
 * 这里沿用它的取值；医生智能体面板关闭时右移，避免悬空。
 */
const floatRight = computed(() => (panelOpen.value ? 308 : 20))
const pendingStyle = computed(() => ({
  position: 'fixed' as const,
  right: `${floatRight.value}px`,
  top: '105px',
  width: '220px',
  zIndex: 2100,
}))
const obsStyle = computed(() => ({
  position: 'fixed' as const,
  right: `${floatRight.value}px`,
  top: '320px',
  width: '220px',
  maxHeight: 'calc(100vh - 340px)',
  zIndex: 2090,
}))


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

const candidateNames = computed(() => (summary.value?.suspected_diagnoses ?? []).map((d) => d.name))
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
  ws.markAlertHandled(alert.id)
  ElMessage.success(`已记录「${alert.name}」的处置`)
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
  const exams = (summary.value?.todos ?? []).filter((t) => t.type === 'exam')
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
        name: exam.title,
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
 * 智能笔记的「检」按钮：按关键词检索本次语音问诊内容。
 * 原件 title 就是「检索语音就诊内容」—— 它不是重新生成病历。
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

// ---------------------------------------------------------------- 专项评估目录

const catalog = ref<{ name: string; count: number; items: { name: string; level: string; desc: string }[] }[]>([])
const expandedCategories = ref<Set<string>>(new Set())

function toggleCategory(name: string) {
  const next = new Set(expandedCategories.value)
  next.has(name) ? next.delete(name) : next.add(name)
  expandedCategories.value = next
}

// ---------------------------------------------------------------- 对话

const chatInput = ref('')
const chatMessages = ref<{ role: 'user' | 'assistant'; content: string }[]>([])
const chatting = ref(false)

/**
 * 对话区自动滚到底，让新播出的一条始终可见。
 * 必须放在 chatMessages 声明之后 —— 放前面会在模块求值时命中暂时性死区，
 * 整个组件挂载失败（构建不报错，只在运行时炸）。
 */
const chatScrollEl = ref<HTMLElement | null>(null)

watch(
  () => [voice.messages.value.length, chatMessages.value.length],
  async () => {
    await nextTick()
    const el = chatScrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

async function sendChat(preset?: string) {
  const text = (preset ?? chatInput.value).trim()
  if (!text || chatting.value) return
  chatInput.value = ''
  chatMessages.value.push({ role: 'user', content: text })
  chatMessages.value.push({ role: 'assistant', content: '' })
  const index = chatMessages.value.length - 1
  chatting.value = true

  try {
    await streamSse(
      '/api/emr/copilot/chat',
      { patient_id: ws.patientId, messages: chatMessages.value.slice(0, -1).map((m) => ({ role: m.role, content: m.content })) },
      (event) => {
        if (event.type === 'token') {
          chatMessages.value[index].content += String(event.token)
        }
      },
    )
  } catch (error) {
    chatMessages.value[index].content = `（请求失败：${(error as Error).message}）`
  } finally {
    chatting.value = false
  }
}

// ---------------------------------------------------------------- 一键生成

const generatingAll = ref(false)
const generateStep = ref('')

/**
 * 「生成」：把本次问诊的内容灌进下游全部 AI 产出。
 *
 * 为什么必须有这个动作：病情概况、鉴别诊断、风险、共病都是**打开工作站时**
 * 算好的，也就是在问诊之前。医生问出来的新信息不会自动回流到那些面板 ——
 * 不点这一下，问诊就白做了。
 *
 * 步骤：先把问诊记录落库（后续上下文装配会优先取它而不是演示脚本），
 * 再强制刷新聚合分析，最后重新起草病历。
 */
async function generateAll() {
  if (!ws.patientId || generatingAll.value) return
  generatingAll.value = true
  try {
    if (voice.messages.value.length && voice.state.value !== 'ended') {
      generateStep.value = '落库问诊记录…'
      await voice.finish()
    }

    generateStep.value = '重新分析病情、诊断与风险…'
    await ws.loadSummary(true)

    generateStep.value = '起草病历…'
    await generateRecord()

    ElMessage.success('已按本次问诊内容重新生成病历与分析')
  } catch (error) {
    ElMessage.error(`生成失败：${(error as Error).message}`)
  } finally {
    generatingAll.value = false
    generateStep.value = ''
  }
}

// ---------------------------------------------------------------- 接诊流转

/**
 * 接诊下一位：按候诊队列顺序切到下一个患者，走到队尾回候诊列表。
 * 与 V4.3 的同名按钮一致，是问诊结束后的主要去向。
 */
const router = useRouter()

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
  if (inVoice.value) voice.askManual(text)
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
  try {
    catalog.value = (await api.assessmentCatalog()).categories
  } catch {
    // 目录加载失败不影响主流程，界面显示空目录即可
  }
})
</script>

<template>
  <div class="ai-emr-root">
    <div class="ai-float-wrapper">
      <!-- ======================= AI 助手 ======================= -->
      <div v-if="tipsOpen" class="tips-drawer connected-right">
        <div class="tips-header">
          <span class="tips-title"><span class="panel-ai-dot" />AI 助手</span>
          <div class="tips-header-actions">
            <el-tag v-if="ws.isDegraded" size="small" type="warning" effect="plain">降级</el-tag>
            <el-button text size="small" class="tips-close" @click="tipsOpen = false">×</el-button>
          </div>
        </div>

        <div class="tips-tab-nav">
          <div
            v-for="tab in TABS"
            :key="tab"
            class="ttab"
            :class="{ active: activeTab === tab }"
            @click="activeTab = tab"
          >
            {{ tab }}
            <span v-if="tab === '诊断管理' && summary?.suspected_diagnoses?.length" class="ttab-dot primary">
              {{ summary.suspected_diagnoses.length }}
            </span>
            <span v-if="tab === '共病管理' && summary?.comorbidity?.nutrition?.triggered" class="ttab-dot danger">营</span>
            <span v-if="tab === '预警评估' && ws.openRedAlerts.length" class="ttab-dot danger">
              {{ ws.openRedAlerts.length }}
            </span>
          </div>
        </div>

        <div v-loading="ws.loadingSummary" class="tips-tab-body">
          <!-- ---------------- 智慧诊疗 ---------------- -->
          <div v-show="activeTab === '智慧诊疗'" class="tips-tab-pane">
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
                    <el-button type="primary" size="small" link :loading="generating" @click="generateRecord">
                      AI 生成
                    </el-button>
                  </div>
                  <div class="rc-body">
                    <!-- 智能笔记：医生随手记的要点，作为 note_text 参与病历生成。
                         对应 V4.3 的 smart-note-row，是病历卡的第一行。 -->
                    <div class="rc-row smart-note-row">
                      <span class="rc-label">智能笔记</span>
                      <div class="rc-field smart-note-field">
                        <textarea v-model="smartNote" placeholder="输入关键词，点击“检”检索语音就诊内容" />
                      </div>
                      <button
                        class="rc-writeback-icon smart-note-search"
                        title="检索语音就诊内容"
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
                          class="obs-float-item"
                          :title="'点击并入智能笔记'"
                          @click="smartNote = `${smartNote}｜${hit.text}`"
                        >
                          {{ hit.role === 'doctor' ? '医生' : '患者' }}：{{ hit.text }}
                        </div>
                      </div>
                      <button class="rc-writeback-icon" title="清空检索结果" @click="noteHits = []">清</button>
                    </div>

                    <div v-for="[key, label] in RECORD_SECTIONS" :key="key" class="rc-row">
                      <span class="rc-label">{{ label }}</span>
                      <div class="rc-field">
                        <textarea :value="ws.draft[key] ?? ws.record[key] ?? ''" readonly rows="2" />
                      </div>
                      <button class="rc-writeback-icon" :title="`写回${label}`" @click="acceptField(key)">回</button>
                    </div>
                  </div>
                </div>

                <div class="key-assessment-section">
                  <div class="ka-header"><div class="ka-title">专项评估</div></div>
                  <div class="ka-categories">
                    <div v-for="category in catalog" :key="category.name" class="ka-category">
                      <div class="ka-cat-header" @click="toggleCategory(category.name)">
                        <div class="ka-cat-title">{{ category.name }}</div>
                        <span class="ka-cat-count">{{ category.count }}项</span>
                        <span class="ka-cat-arrow" :class="{ expanded: expandedCategories.has(category.name) }">›</span>
                      </div>
                      <div v-if="expandedCategories.has(category.name)" class="ka-list">
                        <div v-for="item in category.items" :key="item.name" class="ka-card" :class="`ka-card-${item.level}`">
                          <div class="ka-card-body">
                            <div class="ka-card-title-row">
                              <div class="ka-card-name">{{ item.name }}</div>
                            </div>
                            <div class="ka-card-detail-row">
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
              <div v-for="risk in summary?.risk_assessments ?? []" :key="risk.id" class="risk-card">
                <div class="risk-card-header">
                  <span class="risk-dot" />
                  <span class="risk-name">{{ risk.name }}</span>
                  <el-tag size="small" round effect="light" :type="risk.color === 'danger' ? 'danger' : risk.color === 'warning' ? 'warning' : 'success'">
                    {{ risk.level }}
                  </el-tag>
                  <div class="risk-actions">
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
                {{ ws.loadingSummary ? '智能体分析中…' : '暂无风险项' }}
              </div>
            </div>
          </div>

          <!-- ---------------- 病历管理 ---------------- -->
          <div v-show="activeTab === '病历管理'" class="tips-tab-pane">
            <div class="record-layout">
              <div class="record-main">
                <div class="btab-writeback-bar">
                  <el-button type="success" size="small" class="writeback-primary-btn" @click="ws.acceptAllDraft()">
                    ✔ 确认并回写到病历
                  </el-button>
                  <span class="record-complete-badge">病历完整度 {{ recordCompleteness }}%</span>
                  <span class="writeback-hint">AI 草稿需确认后才进入正式病历</span>
                </div>
                <div v-for="[key, label] in RECORD_SECTIONS" :key="key" class="record-node">
                  <div class="node-header">
                    <span class="node-title">{{ label }}</span>
                    <el-button type="primary" size="small" link class="node-writeback-btn" @click="acceptField(key)">
                      回写此字段
                    </el-button>
                  </div>
                  <div class="node-content">{{ ws.draft[key] ?? ws.record[key] ?? '未采集' }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- ---------------- 诊断管理 ---------------- -->
          <div v-show="activeTab === '诊断管理'" class="tips-tab-pane">
            <div class="tab-section">
              <div class="tab-section-title">疑似诊断</div>
              <p class="susp-hint">勾选拟纳入诊断；点击右侧 <strong>主</strong> 标记指定主诊断</p>
              <div class="suspected-list">
                <div
                  v-for="item in summary?.suspected_diagnoses ?? []"
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
                <span class="treat-section-count">{{ summary?.todos?.filter((t) => t.type === 'exam').length ?? 0 }} 项</span>
              </div>
              <div class="exam-list">
                <div v-for="todo in summary?.todos?.filter((t) => t.type === 'exam') ?? []" :key="todo.title" class="exam-rec-order">
                  <div class="ero-head">
                    <div class="ero-title-wrap">
                      <span class="ero-name">{{ todo.title }}</span>
                      <el-tag size="small" type="warning" effect="plain">检验</el-tag>
                    </div>
                  </div>
                  <div class="ero-spec">门诊 · 一次</div>
                  <div class="ero-basis">{{ todo.detail }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- ---------------- 共病管理 ---------------- -->
          <div v-show="activeTab === '共病管理'" class="tips-tab-pane">
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
            </div>
          </div>

          <!-- ---------------- 健康档案 ---------------- -->
          <div v-show="activeTab === '健康档案'" class="tips-tab-pane">
            <div class="tab-section">
              <div class="tab-section-title">健康档案</div>
              <div class="rc-body">
                <div v-for="(value, key) in (patient?.health_archive ?? {})" :key="key" class="rc-row rc-row-single">
                  <span class="rc-label">{{ key }}</span>
                  <div class="rc-field">{{ value }}</div>
                </div>
              </div>
              <div class="tab-section-title">既往就诊</div>
              <div v-for="(visit, index) in summary?.visit_history ?? []" :key="index" class="record-node">
                <div class="node-content">{{ JSON.stringify(visit).replace(/[{}"]/g, ' ') }}</div>
              </div>
            </div>
          </div>

          <!-- ---------------- 时间轴 ---------------- -->
          <div v-show="activeTab === '时间轴'" class="tips-tab-pane">
            <div class="tab-section">
              <div class="tab-section-title">本次就诊时间轴</div>
              <div class="timeline-list">
                <div v-for="(event, index) in summary?.timeline ?? []" :key="index" class="timeline-group">
                  <div class="tl-time-tag">{{ event.time }}</div>
                  <div class="tl-group-card">
                    <div class="tl-group-header"><span class="tl-group-action">{{ event.action }}</span></div>
                    <div class="tl-sub-section" :class="event.actor === 'AI' ? 'ai' : event.actor === '医生' ? 'doctor' : 'system'">
                      <div class="tl-sub-label">{{ event.actor ?? '系统' }}</div>
                      <div class="tl-sub-item-wrap">
                        <div class="tl-sub-item">
                          <span class="tl-sub-action">{{ event.action }}</span>
                          <span class="tl-sub-detail">{{ event.detail }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-if="!summary?.timeline?.length" class="diag-empty">暂无时间轴事件</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel-tips-toggle" :class="{ active: tipsOpen }" @click="tipsOpen = !tipsOpen" title="展开/收起 AI 助手">
        {{ tipsOpen ? '›' : '‹' }}
      </div>

      <!-- ======================= 医生智能体 ======================= -->
      <div v-if="panelOpen" class="assistant-panel connected-left">
        <div class="panel-header">
          <span class="panel-title"><span class="panel-ai-dot" />医生智能体</span>
          <div class="panel-header-actions">
            <el-button text size="small" class="panel-action-btn panel-close" @click="panelOpen = false">×</el-button>
          </div>
        </div>

        <div class="copilot-tab-bar">
          <div class="ctab active">
            <span v-if="voice.state.value !== 'idle'" class="mode-badge voice">语</span>
            <span class="patient-tab-name">{{ patient?.name }}</span>
            <span class="patient-tab-meta">· {{ patient?.gender }} · {{ patient?.age }}岁</span>
          </div>
        </div>

        <div class="chat-area">
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
            </div>

            <div v-if="generateStep" class="voice-ready-hint">⚡ {{ generateStep }}</div>
            <div v-if="voice.error.value" class="voice-ready-hint">{{ voice.error.value }}</div>
          </div>

          <div class="action-bar">
            <el-button v-if="voice.state.value === 'idle'" type="primary" size="small" @click="voice.start()">
              ● 语音问诊
            </el-button>

            <template v-else>
              <!-- 播放中 / 暂停：控制推进 -->
              <el-button v-if="voice.state.value === 'playing'" type="warning" size="small" @click="voice.pause()">
                ⏸ 暂停问诊
              </el-button>
              <el-button v-else-if="voice.state.value === 'paused'" type="primary" size="small" @click="voice.resume()">
                ▶ 继续问诊
              </el-button>
              <el-button v-else size="small" @click="voice.restart()">🔄 重新问诊</el-button>

              <el-button size="small" plain class="obs-toggle-btn" @click="voice.showObservations.value = true">
                📋 补充观察
              </el-button>

              <!--
                结束问诊只有这一个入口，且只能由医生点。
                内容播完只是进入 awaiting，不代表问诊结束 —— 结束会生成问诊小结，
                小结要进病历，属于有后果的动作，必须医生确认。
              -->
              <el-button
                v-if="voice.state.value !== 'ended'"
                type="danger"
                size="small"
                :loading="voice.finishing.value"
                @click="voice.finish()"
              >
                ■ 结束问诊
              </el-button>

              <!--
                生成：把问诊内容灌进下游全部 AI 产出。
                病情概况/鉴别诊断/风险/共病都是打开工作站时算好的（问诊之前），
                不点这一下，医生问出来的新信息就进不了那些面板。
              -->
              <el-button
                v-if="voice.messages.value.length"
                type="success"
                size="small"
                :loading="generatingAll"
                @click="generateAll"
              >
                ⚡ 生成
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
                <button class="float-voice-btn" title="语音问诊" @click="voice.state.value === 'idle' ? voice.start() : voice.pause()">
                  🎤
                </button>
                <button class="float-send-btn" :disabled="chatting || voice.manualThinking.value" @click="submitInput">↑</button>
              </div>
            </div>
            <div class="chat-toolbar">
              <div class="tb-left">
                <button class="tb-plus-btn" title="上传/提示词">＋</button>
                <span class="tb-hint" />
              </div>
              <div class="tb-actions">
                <button class="tb-action-btn" @click="nextPatient">接诊下一位</button>
                <button class="tb-action-btn" @click="sendChat('请解读本次检查检验的异常结果')">报告解读</button>
                <button class="tb-action-btn" @click="activeTab = '智慧诊疗'">鉴别诊断</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- AI 追问提示：问诊播放中浮在右侧，已问到的逐条划掉 -->
      <div v-if="voice.active.value && voice.questions.value.length" class="pending-float" :style="pendingStyle">
        <div class="pending-title"><span class="pending-dot" /> AI 追问提示 </div>
        <div class="pending-list">
          <!-- 当前该问的一条。点一下可手动标记已问，模型判错时医生能一键纠正。 -->
          <div
            v-if="voice.currentQuestion.value"
            class="pq-item"
            title="点击标记为已问"
            @click="voice.toggleQuestionDone(voice.currentQuestion.value.index)"
          >
            <span class="pq-num">{{ voice.currentQuestion.value.index + 1 }}</span>
            <span class="pq-text">{{ voice.currentQuestion.value.text }}</span>
          </div>
          <div class="pq-done-list">
            <div
              v-for="item in voice.pendingQuestions.value.filter((q) => q.done)"
              :key="item.index"
              class="pq-item done"
              :title="item.evidence ? `依据：${item.evidence}` : '点击撤销'"
              @click="voice.toggleQuestionDone(item.index)"
            >
              <span class="pq-check">✓</span>
              <span class="pq-text">{{ item.text }}</span>
            </div>
          </div>
        </div>
      </div>

      <!--
        补充观察：随对话动态过滤后的「待观察」清单。
        已经在对话里问到的条目会自动移出，剩下的才需要医生补问；勾选后并入问诊小结。
      -->
      <div v-if="voice.showObservations.value" class="obs-float" :style="obsStyle">
        <div class="obs-float-header">
          <span class="obs-float-title">补充观察</span>
          <el-button link size="small" class="obs-float-close" @click="voice.showObservations.value = false">✕</el-button>
        </div>
        <div class="obs-float-list">
          <div
            v-for="item in voice.observations.value"
            :key="item"
            class="obs-float-item"
            :class="{ picked: voice.pickedObservations.value.has(item) }"
            @click="voice.toggleObservation(item)"
          >
            {{ item }}
          </div>
          <div v-if="!voice.observations.value.length" class="obs-float-item mute">
            {{ voice.messages.value.length ? '本次对话已覆盖全部候选观察项' : '待患者描述主诉后动态更新' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="../styles/AiEmrFloat.scoped.css"></style>
