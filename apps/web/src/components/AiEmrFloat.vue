<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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

const summary = computed(() => ws.summary)
const patient = computed(() => ws.patient)

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
    ElMessage.success('诊断已回写（本地库 + 审计）')
  } catch {
    // 用户取消
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

async function generateRecord() {
  if (!ws.patientId) return
  generating.value = true
  ws.draft = {}
  try {
    await streamSse('/api/emr/copilot/chat', { patient_id: ws.patientId, messages: [], generate_record: true }, (event) => {
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
    })
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

// ---------------------------------------------------------------- 语音问诊

const voice = useVoiceInterview(() => ws.patientId)

/**
 * 输入框一个框服务两种模式：语音问诊进行中时写患者所述，否则写向智能体提问。
 * 用可读写 computed 代理，避免在模板里对 v-model 写三元表达式（那是非法的）。
 */
const inputText = computed({
  get: () => (voice.active.value ? voice.transcript.value : chatInput.value),
  set: (value: string) => {
    if (voice.active.value) voice.transcript.value = value
    else chatInput.value = value
  },
})

function submitInput() {
  if (voice.active.value) voice.submitTurn()
  else sendChat()
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
                    <span class="dd-title">鉴别诊断</span>
                    <button class="todo-action-btn tab-record dd-confirm-btn" @click="activeTab = '诊断管理'">去确认诊断</button>
                  </div>
                  <div class="dd-rec-list">
                    <div
                      v-for="(item, index) in summary?.differential_diagnosis?.items ?? []"
                      :key="item.name"
                      class="dd-rec-item"
                      :class="{ primary: index === 0, selected: index === 0 }"
                    >
                      <div class="dd-card-main">
                        <div class="dd-card-body">
                          <div class="susp-top">
                            <span class="susp-name">{{ item.name }}</span>
                          </div>
                          <div class="dd-inline-summary">
                            <div><strong>支持：</strong>{{ (item.supporting ?? []).join('；') || '未获得' }}</div>
                            <div><strong>反对：</strong>{{ (item.opposing ?? []).join('；') || '未获得' }}</div>
                            <div><strong>缺失：</strong>{{ (item.missing ?? []).join('；') || '—' }}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div v-if="!summary?.differential_diagnosis?.items?.length" class="diag-empty">
                      {{ ws.loadingSummary ? '智能体分析中…' : '暂无鉴别诊断' }}
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
              <div class="treat-list">
                <div v-for="order in summary?.recommended_orders ?? []" :key="order.drug" class="treat-card">
                  <div class="treat-top">
                    <div class="treat-drug-wrap"><span class="treat-drug">{{ order.drug }}</span></div>
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
            <span class="patient-tab-name">{{ patient?.name }}</span>
            <span class="patient-tab-meta">· {{ patient?.gender }} · {{ patient?.age }}岁</span>
          </div>
        </div>

        <div class="chat-area">
          <div class="chat-messages">
            <div v-if="!chatMessages.length && !voice.messages.value.length" class="quick-skill-area">
              <div class="quick-skill-title">本科常用 Skill</div>
              <div class="quick-skill-grid">
                <div v-for="skill in quickSkills" :key="skill.label" class="skill-chip" @click="sendChat(skill.label)">
                  <span class="skill-chip-icon">{{ skill.icon }}</span>
                  <span class="skill-chip-label">{{ skill.label }}</span>
                </div>
              </div>
            </div>

            <div v-for="(message, index) in chatMessages" :key="`c${index}`" class="record-node">
              <div class="node-header">
                <span class="node-title">{{ message.role === 'user' ? '医生' : 'AI' }}</span>
              </div>
              <div class="node-content">{{ message.content || '…' }}</div>
            </div>

            <template v-if="voice.active.value || voice.messages.value.length">
              <div class="tab-section-title">语音问诊</div>
              <div v-for="(turn, index) in voice.messages.value" :key="`v${index}`" class="record-node">
                <div class="node-header">
                  <span class="node-title">{{ turn.role === 'doctor' ? '建议追问' : '患者' }}</span>
                </div>
                <div class="node-content">{{ turn.text }}</div>
              </div>
              <div v-if="voice.observations.value.length" class="risk-summary">
                <strong>观察项：</strong>{{ voice.observations.value.join('；') }}
              </div>
              <div v-if="voice.error.value" class="risk-summary"><strong>提示：</strong>{{ voice.error.value }}</div>
            </template>
          </div>

          <div class="action-bar">
            <el-button v-if="!voice.active.value" type="primary" size="small" @click="voice.start()">● 语音问诊</el-button>
            <template v-else>
              <el-button size="small" :loading="voice.thinking.value" @click="voice.submitTurn()">提交本轮</el-button>
              <el-button type="danger" size="small" @click="voice.finish()">结束问诊</el-button>
            </template>
          </div>

          <div class="chat-input-wrap">
            <div class="chat-textarea-wrap">
              <el-input
                v-model="inputText"
                class="chat-textarea"
                type="textarea"
                :rows="2"
                :placeholder="voice.active.value ? '患者所述（语音识别结果可编辑，也可手动输入）' : '向医生智能体提问…'"
                @keyup.enter.exact="submitInput"
              />
              <div class="chat-float-actions">
                <button
                  class="float-voice-btn"
                  :class="{ active: voice.listening.value }"
                  :title="voice.supported ? '语音识别' : '当前浏览器不支持语音识别，请手动输入'"
                  @click="voice.toggleListening()"
                >
                  🎤
                </button>
                <button class="float-send-btn" :disabled="chatting" @click="submitInput">↑</button>
              </div>
            </div>
            <div class="chat-toolbar">
              <div class="tb-left">
                <span class="tb-hint">{{ voice.supported ? '' : '浏览器不支持语音识别，已切换为手动输入' }}</span>
              </div>
              <div class="tb-actions">
                <button class="tb-action-btn" @click="sendChat('请解读本次检查检验的异常结果')">报告解读</button>
                <button class="tb-action-btn" @click="activeTab = '诊断管理'">鉴别诊断</button>
                <button class="tb-action-btn" @click="generateRecord">生成病历</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="../styles/AiEmrFloat.scoped.css"></style>
