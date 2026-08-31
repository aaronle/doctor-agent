<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import AiEmrFloat from '../components/AiEmrFloat.vue'
import { api, type LabResult, type PatientOrder } from '../api'
import { useSession } from '../stores/session'
import { useWorkstation } from '../stores/workstation'

const route = useRoute()
const router = useRouter()
const session = useSession()
const ws = useWorkstation()

const sidebarCollapsed = ref(true)
const orderTab = ref<'drug' | 'exam' | 'lab'>('drug')
const orderDialog = ref(false)
const submitting = ref(false)

const newOrder = ref({ drug: '', dose: '', freq: 'qd', route: '口服', days: '30' })
const drugs = ref<{ id: string; name: string; spec?: string }[]>([])

/** 左侧 HIS 病历表单。与 V4.3 的十行一致，比 AI 七段多出过敏史、体征、建议。 */
const form = ref({
  chief_complaint: '',
  present_illness: '',
  past_history: '',
  personal_history: '',
  allergies: '',
  physical_exam: '',
  auxiliary_exam: '',
  advice: '',
})

const vitals = ref({ height: '', weight: '', bmi: '', temp: '', pulse: '', breath: '', bpHigh: '', bpLow: '', hr: '' })

const patient = computed(() => ws.patient)
const summary = computed(() => ws.summary)

const allOrders = computed<PatientOrder[]>(() => patient.value?.orders ?? [])
const drugOrders = computed(() => allOrders.value.filter((o) => o.category !== 'exam'))
const examOrders = computed(() => allOrders.value.filter((o) => o.category === 'exam' && o.exam_type !== '检验'))
const labResults = computed<LabResult[]>(() => patient.value?.lab_results ?? [])

/**
 * 阳性结果：异常检验 + 异常检查，与 V4.3 的 result-panel 一致。
 *
 * 字段名与形状对齐原件（id / type / label / detail / extra）—— detail 是展开态
 * 要显示的内容，早先的实现没有它，所以点开只能重复一遍名字。
 * 顺序也按原件：检查在前，检验在后。
 */
type PositiveResult = { id: string; type: 'exam' | 'lab'; label: string; detail: string; extra: string }

const positiveResults = computed<PositiveResult[]>(() => {
  const labs = labResults.value
    .filter((l) => l.abnormal)
    .map((l) => ({
      id: `lab-${l.name}`,
      type: 'lab' as const,
      label: l.name,
      detail: `${l.value} ${l.unit ?? ''}（参考: ${l.ref ?? '—'}）`,
      extra: l.diff_note || '偏高',
    }))
  const exams = (summary.value?.examinations ?? [])
    .filter((e) => {
      const row = e as Record<string, unknown>
      // 优先用结构化的 abnormal；没有该字段时退回结论文本判断
      return row.abnormal === true || String(row.conclusion ?? '').includes('异常')
    })
    .map((e, i) => {
      const row = e as Record<string, string>
      return {
        id: String(row.id ?? `exam-${i}`),
        type: 'exam' as const,
        label: row.name,
        detail: row.result ?? row.conclusion ?? '',
        extra: row.conclusion ?? '',
      }
    })
  return [...exams, ...labs]
})

/** 展开查看的那一条。null 表示看列表。 */
const openedResult = ref<PositiveResult | null>(null)

/** 再点同一条即收起 —— 与原件一致 */
function toggleResult(item: PositiveResult) {
  openedResult.value = openedResult.value?.id === item.id ? null : item
}

/** 结论里出现「异常」「偏高」即标红 */
const openedAbnormal = computed(() => {
  const extra = openedResult.value?.extra ?? ''
  return extra.includes('异常') || extra.includes('偏高')
})

// 换患者时收起展开态，否则会把上一位患者的结果留在面板里
watch(() => ws.patientId, () => { openedResult.value = null })

const allergyText = computed(() => {
  const value = patient.value?.allergies
  if (Array.isArray(value)) return value.join('、') || '无'
  return value || '无'
})

function riskType(level = '') {
  if (level.includes('高')) return 'danger'
  if (level.includes('中')) return 'warning'
  return 'success'
}

/** 把患者主数据回填进病历表单与体征输入框 */
function hydrate() {
  const p = patient.value
  if (!p) return
  form.value.chief_complaint = ws.record.chief_complaint ?? p.chief_complaint ?? ''
  form.value.present_illness = ws.record.present_illness ?? ''
  form.value.past_history = ws.record.past_history ?? p.past_history ?? ''
  form.value.personal_history = ws.record.personal_history ?? ''
  form.value.physical_exam = ws.record.physical_exam ?? ''
  form.value.auxiliary_exam = ws.record.auxiliary_exam ?? ''
  form.value.allergies = allergyText.value

  const v = (p.vitals ?? {}) as Record<string, string | number>
  const bp = String(v.bp ?? '').match(/(\d+)\s*\/\s*(\d+)/)
  vitals.value = {
    height: String(v.height ?? ''),
    weight: String(v.weight ?? ''),
    bmi: String(v.bmi ?? ''),
    temp: String(v.temp ?? ''),
    pulse: String(v.hr ?? ''),
    breath: String(v.breath ?? ''),
    bpHigh: bp?.[1] ?? '',
    bpLow: bp?.[2] ?? '',
    hr: String(v.hr ?? ''),
  }
}

async function openOrderDialog() {
  orderDialog.value = true
  if (!drugs.value.length) {
    drugs.value = (await api.drugs()) as { id: string; name: string; spec?: string }[]
  }
}

async function submitOrder() {
  if (!newOrder.value.drug) {
    ElMessage.warning('请选择药品')
    return
  }
  submitting.value = true
  try {
    await api.createOrder({ patient_id: ws.patientId, ...newOrder.value })
    ElMessage.success('医嘱已开立（写入本地库，未触达真实 HIS）')
    orderDialog.value = false
    newOrder.value = { drug: '', dose: '', freq: 'qd', route: '口服', days: '30' }
    ws.patient = await api.patient(ws.patientId)
  } catch (error) {
    ElMessage.error(`开立失败：${(error as Error).message}`)
  } finally {
    submitting.value = false
  }
}

// ---------------------------------------------------------------- 转诊 / 住院 / 检查

const referralDialog = ref(false)
const admissionDialog = ref(false)
const examDialog = ref(false)

const DEPARTMENTS = [
  '内分泌科', '心内科', '神经内科', '肾内科', '消化内科', '呼吸内科',
  '血液科', '风湿免疫科', '普外科', '骨科', '妇科', '眼科',
  '营养科', '康复科', '精神心理科', '全科医学科',
]

const newReferral = ref({ target_dept: '', reason: '', urgent: false })
const newAdmission = ref({ target_dept: '', indication: '', urgent: false })
const newExam = ref({ name: '', type: '检查', route: '门诊', freq: '一次' })

async function submitReferral() {
  if (!newReferral.value.target_dept) {
    ElMessage.warning('请选择转入科室')
    return
  }
  submitting.value = true
  try {
    const result = await api.createReferral({ patient_id: ws.patientId, ...newReferral.value })
    ElMessage.success(result.message)
    referralDialog.value = false
    newReferral.value = { target_dept: '', reason: '', urgent: false }
  } catch (error) {
    ElMessage.error(`提交失败：${(error as Error).message}`)
  } finally {
    submitting.value = false
  }
}

async function submitAdmission() {
  if (!newAdmission.value.target_dept) {
    ElMessage.warning('请选择入院科室')
    return
  }
  if (ws.writeBackBlocked) {
    ElMessage.warning(`${ws.openRedAlerts.length} 条红色风险未处置，已阻断住院申请`)
    return
  }
  submitting.value = true
  try {
    const result = await api.createAdmission({
      patient_id: ws.patientId,
      patient_name: patient.value?.name ?? '',
      ...newAdmission.value,
    })
    ElMessage.success(result.message)
    admissionDialog.value = false
    newAdmission.value = { target_dept: '', indication: '', urgent: false }
  } catch (error) {
    ElMessage.error(`提交失败：${(error as Error).message}`)
  } finally {
    submitting.value = false
  }
}

async function submitExam() {
  if (!newExam.value.name) {
    ElMessage.warning('请填写项目名称')
    return
  }
  submitting.value = true
  try {
    await api.createExam({ patient_id: ws.patientId, ...newExam.value })
    ElMessage.success(`${newExam.value.type}已开立（写入本地库，未触达真实 HIS）`)
    examDialog.value = false
    newExam.value = { name: '', type: '检查', route: '门诊', freq: '一次' }
    ws.patient = await api.patient(ws.patientId)
  } catch (error) {
    ElMessage.error(`开立失败：${(error as Error).message}`)
  } finally {
    submitting.value = false
  }
}

/** 提交病历。红色风险未逐条处置时按 F06 规格阻断。 */
async function submitRecord() {
  if (ws.writeBackBlocked) {
    await ElMessageBox.alert(
      `尚有 ${ws.openRedAlerts.length} 条红色风险未处置：${ws.openRedAlerts.map((a) => a.name).join('、')}。请先在「预警评估」中逐条处置后再提交病历。`,
      '红色风险未闭环，已阻断提交',
      { type: 'error', confirmButtonText: '去处置' },
    )
    return
  }
  submitting.value = true
  try {
    const result = await api.submitRecord(ws.patientId, recordFields(), [...ws.handledAlertIds])
    ElMessage.success(`${result.message} · 第 ${result.version} 版`)
    savedHint.value = `已提交 · 第 ${result.version} 版`
  } catch (error) {
    // 服务端门禁返回 409 时如实报出来，不要吞成一句「提交成功」
    ElMessage.error(`提交失败：${(error as Error).message}`)
  } finally {
    submitting.value = false
  }
}

/** 把十行表单摊成后端认识的七段 + 体征 */
function recordFields(): Record<string, string> {
  const v = vitals.value
  return {
    ...form.value,
    vitals_text: [
      v.height && `身高 ${v.height}cm`, v.weight && `体重 ${v.weight}kg`, v.bmi && `BMI ${v.bmi}`,
      v.temp && `体温 ${v.temp}℃`, v.pulse && `脉搏 ${v.pulse}次/分`, v.breath && `呼吸 ${v.breath}次/分`,
      (v.bpHigh || v.bpLow) && `血压 ${v.bpHigh}/${v.bpLow} mmHg`, v.hr && `心率 ${v.hr}次/分`,
    ].filter(Boolean).join('，'),
  }
}

/** 最近一次保存的提示。医生需要一眼看到「存没存住」。 */
const savedHint = ref('')

/**
 * 暂存。不过红线门禁 —— 它的用途正是「还没弄完，先存着」。
 */
async function stashRecord() {
  submitting.value = true
  try {
    const result = await api.stashRecord(ws.patientId, recordFields())
    ElMessage.success(`${result.message} · 第 ${result.version} 版`)
    savedHint.value = `已暂存 · 第 ${result.version} 版`
  } catch (error) {
    ElMessage.error(`暂存失败：${(error as Error).message}`)
  } finally {
    submitting.value = false
  }
}

/**
 * 恢复上次保存的病历。
 *
 * 没有这一步，医生刷新一次页面就得从头再写 —— 那不叫系统，叫演示。
 * 已保存的内容优先于患者主档回填。
 */
async function restoreSavedRecord() {
  if (!ws.patientId) return
  try {
    const saved = await api.savedRecord(ws.patientId)
    const fields = saved.submitted?.fields ?? saved.latest?.fields
    if (!fields) return
    for (const key of Object.keys(form.value) as (keyof typeof form.value)[]) {
      if (fields[key]) form.value[key] = fields[key]
    }
    savedHint.value = saved.submitted
      ? `已提交 · 第 ${saved.submitted.version} 版`
      : `上次暂存 · 第 ${saved.latest?.version} 版`
  } catch {
    // 读不到就按新病历处理，不打扰医生
  }
}

function switchPatient(id: string) {
  router.push(`/outpatient/${id}`)
}

function logout() {
  session.logout()
  router.push('/login')
}

watch(
  () => route.params.patientId,
  async (id) => {
    if (typeof id === 'string' && id) {
      await ws.selectPatient(id)
      hydrate()
      savedHint.value = ''
      await restoreSavedRecord()
    }
  },
)

watch(() => ws.record, hydrate, { deep: true })

onMounted(async () => {
  await ws.loadQueue()
  const id = route.params.patientId
  if (typeof id === 'string' && id) {
    await ws.selectPatient(id)
    hydrate()
    await restoreSavedRecord()
  } else if (ws.queue.length) {
    // /outpatient 无患者时接诊队列第一位，与 V4.3 的 OutpatientHome 行为一致
    router.replace(`/outpatient/${ws.queue[0].id}`)
  }
})
</script>

<template>
  <div class="workstation-page">
    <div class="his-header">
      <div class="his-header-left">
        <el-button text class="back-btn" :icon="ArrowLeft" @click="router.push('/outpatient/list')">候诊列表</el-button>
        <span class="his-divider">|</span>
        <span class="his-logo">🏥</span>
        <span class="his-title">AI 门诊工作站</span>
      </div>
      <div class="his-header-right">
        <el-tag v-if="ws.isDegraded" size="small" type="warning" effect="light">
          {{ ws.degradedAgents.length }} 个智能体已降级
        </el-tag>
        <el-button text size="small" @click="referralDialog = true">转诊</el-button>
        <el-button text size="small" @click="admissionDialog = true">住院</el-button>
        <el-button text size="small" @click="router.push('/admin')">Agent 控制台</el-button>
        <el-button text size="small" @click="router.push('/outpatient/manage')">患者管理</el-button>
        <el-button text type="danger" size="small" @click="logout">退出</el-button>
      </div>
    </div>

    <div v-if="patient" class="basic-info-strip">
      <div class="strip-fields">
        <span class="strip-field bold">{{ patient.name }}</span>
        <span class="strip-sep">·</span>
        <span class="strip-field">{{ patient.gender }}</span>
        <span class="strip-sep">·</span>
        <span class="strip-field">{{ patient.age }}岁</span>
        <span class="strip-divider" />
        <span class="strip-field"><span class="sf-label">科室</span>{{ patient.dept }}</span>
        <span class="strip-field"><span class="sf-label">主治</span>{{ patient.doctor }}</span>
        <span class="strip-field"><span class="sf-label">就诊</span>{{ patient.visit_date }}</span>
        <span class="strip-field"><span class="sf-label">电话</span>{{ patient.phone }}</span>
        <span class="strip-field"><span class="sf-label">过敏</span><span class="sf-allergy">{{ allergyText }}</span></span>
      </div>
      <div class="strip-actions">
        <el-tag size="small" type="success" round effect="light">{{ patient.visit_type }}</el-tag>
        <el-tag size="small" round effect="light" :type="riskType(patient.risk_level)">{{ patient.risk_level }}</el-tag>
      </div>
    </div>

    <div class="workstation-body">
      <div class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <div class="sidebar-header">
          <button class="sidebar-toggle" type="button" @click="sidebarCollapsed = !sidebarCollapsed">
            {{ sidebarCollapsed ? '›' : '‹' }}
          </button>
        </div>
        <div class="sidebar-avatars">
          <div
            v-for="item in ws.queue"
            :key="item.id"
            class="sa-avatar"
            :class="{ active: item.id === ws.patientId }"
            :title="`${item.name ?? '—'} · ${item.dept ?? ''}`"
            @click="switchPatient(item.id)"
          >
            <!-- 缺名字不能让 charAt 抛错：渲染函数一抛，整个工作站白屏 -->
            {{ (item.name ?? '?').charAt(0) }}
          </div>
        </div>
      </div>

      <div class="main-two-col">
        <!-- 门诊病历 -->
        <div class="his-record-panel">
          <div class="panel-title-bar">
            <span class="pt-title">📋 门诊病历</span>
            <div class="pt-actions">
              <span class="shortcut-hint">AI 结果需确认后写入</span>
              <el-button size="small" :loading="submitting" @click="stashRecord">暂存</el-button>
              <el-button type="primary" size="small" :loading="submitting" @click="submitRecord">提交病历</el-button>
              <span v-if="savedHint" class="saved-hint">{{ savedHint }}</span>
            </div>
          </div>

          <div class="diagnosis-section">
            <div class="diag-section-header">
              <span class="diag-section-title">📌 诊断</span>
              <div class="diag-section-actions">
                <el-button type="primary" size="small">保存诊断</el-button>
                <el-button size="small">编辑</el-button>
              </div>
            </div>
            <div class="diag-list">
              <div class="diag-empty">暂无确诊诊断</div>
            </div>
            <div class="suspected-diag-section">
              <div class="suspected-diag-title">疑似诊断（AI 推测）</div>
              <div class="suspected-diag-list">
                <el-tag
                  v-for="item in summary?.suspected_diagnoses ?? []"
                  :key="item.name"
                  class="suspected-diag-tag"
                  type="warning"
                  effect="plain"
                >
                  <span class="sd-name">{{ item.name }}</span>
                  <span v-if="item.icd" class="sd-icd">[{{ item.icd }}]</span>
                  <span class="sd-conf">{{ item.confidence }}%</span>
                </el-tag>
                <span v-if="!summary?.suspected_diagnoses?.length" class="diag-empty">
                  {{ ws.loadingSummary ? '智能体分析中…' : '暂无疑似诊断' }}
                </span>
              </div>
            </div>
          </div>

          <div class="record-form-scroll">
            <div class="form-row">
              <span class="fl required-mark">主诉</span>
              <div class="fi"><textarea v-model="form.chief_complaint" class="form-textarea" rows="2" /></div>
            </div>
            <div class="form-row">
              <span class="fl required-mark">现病史</span>
              <div class="fi"><textarea v-model="form.present_illness" class="form-textarea" rows="4" /></div>
            </div>
            <div class="form-row">
              <span class="fl">既往史</span>
              <div class="fi"><textarea v-model="form.past_history" class="form-textarea" rows="3" /></div>
            </div>
            <div class="form-row">
              <span class="fl">个人史</span>
              <div class="fi"><textarea v-model="form.personal_history" class="form-textarea" rows="2" /></div>
            </div>
            <div class="form-row single-line">
              <span class="fl">过敏史</span>
              <div class="fi"><input v-model="form.allergies" class="form-input" /></div>
            </div>

            <div class="form-row single-line vitals-row">
              <span class="fl">体征</span>
              <div class="fi vitals-inline">
                <div class="vf-item"><span class="vf-label">身高</span><input v-model="vitals.height" class="vf-input" /><span class="vf-unit">CM</span></div>
                <div class="vf-item"><span class="vf-label">体重</span><input v-model="vitals.weight" class="vf-input" /><span class="vf-unit">KG</span></div>
                <div class="vf-item"><span class="vf-label">BMI</span><input v-model="vitals.bmi" class="vf-input" /></div>
                <div class="vf-item"><span class="vf-label">体温</span><input v-model="vitals.temp" class="vf-input" /><span class="vf-unit">℃</span></div>
                <div class="vf-item"><span class="vf-label">脉搏</span><input v-model="vitals.pulse" class="vf-input" /><span class="vf-unit">次/分</span></div>
                <div class="vf-item"><span class="vf-label">呼吸</span><input v-model="vitals.breath" class="vf-input" /><span class="vf-unit">次/分</span></div>
                <div class="vf-item bp-item">
                  <span class="vf-label">血压</span>
                  <input v-model="vitals.bpHigh" class="vf-input bp-half" /><span class="vf-slash">/</span
                  ><input v-model="vitals.bpLow" class="vf-input bp-half" />
                </div>
                <div class="vf-item"><span class="vf-label">心率</span><input v-model="vitals.hr" class="vf-input" /><span class="vf-unit">次/分</span></div>
              </div>
            </div>

            <div class="form-row">
              <span class="fl">体格检查</span>
              <div class="fi"><textarea v-model="form.physical_exam" class="form-textarea" rows="3" /></div>
            </div>
            <div class="form-row auxiliary-row">
              <span class="fl auxiliary-label">辅助检查</span>
              <div class="fi"><textarea v-model="form.auxiliary_exam" class="form-textarea" rows="3" /></div>
            </div>
            <div class="form-row">
              <span class="fl">建议</span>
              <div class="fi"><textarea v-model="form.advice" class="form-textarea" rows="2" /></div>
            </div>
          </div>
        </div>

        <!-- 医嘱 -->
        <div class="his-orders-panel">
          <div class="panel-title-bar">
            <span class="pt-title">💊 医嘱</span>
            <el-button
              type="primary"
              size="small"
              :icon="Plus"
              @click="orderTab === 'drug' ? openOrderDialog() : (examDialog = true)"
            >
              开嘱
            </el-button>
          </div>

          <div class="order-sub-tabs">
            <div class="ostab" :class="{ active: orderTab === 'drug' }" @click="orderTab = 'drug'">
              💊 药品<span class="ostab-badge">{{ drugOrders.length }}</span>
            </div>
            <div class="ostab" :class="{ active: orderTab === 'exam' }" @click="orderTab = 'exam'">
              🔬 检查<span class="ostab-badge">{{ examOrders.length }}</span>
            </div>
            <div class="ostab" :class="{ active: orderTab === 'lab' }" @click="orderTab = 'lab'">
              🧪 检验<span class="ostab-badge">{{ labResults.length }}</span>
            </div>
          </div>

          <div class="order-table-wrap">
            <el-table v-if="orderTab === 'drug'" :data="drugOrders" class="compact-table" size="small" border stripe height="100%">
              <el-table-column label="药品名称" min-width="150">
                <template #default="{ row }">{{ row.drug ?? row.name }}</template>
              </el-table-column>
              <el-table-column prop="dose" label="剂量" width="80" />
              <el-table-column prop="freq" label="频次" width="70" />
              <el-table-column prop="route" label="用法" width="70" />
              <el-table-column prop="days" label="天数" width="60" />
              <el-table-column prop="status" label="状态" width="70" />
            </el-table>

            <el-table v-else-if="orderTab === 'exam'" :data="examOrders" class="compact-table" size="small" border stripe height="100%">
              <el-table-column prop="name" label="检查项目" min-width="180" />
              <el-table-column prop="route" label="途径" width="80" />
              <el-table-column prop="freq" label="频次" width="80" />
              <el-table-column prop="status" label="状态" width="80" />
            </el-table>

            <el-table v-else :data="labResults" class="compact-table" size="small" border stripe height="100%">
              <el-table-column prop="name" label="检验项目" min-width="160" />
              <el-table-column label="结果" width="110">
                <template #default="{ row }">
                  <span :class="{ danger: row.abnormal }">{{ row.value }}{{ row.unit ?? '' }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="ref" label="参考" width="90" />
              <el-table-column prop="trend" label="趋势" width="70" />
            </el-table>
          </div>

          <div class="result-panel">
            <div class="result-panel-header">
              <span class="rp-title">
                <span v-if="openedResult">📊 {{ openedResult.label }}</span>
                <span v-else>⚠ 阳性结果 ({{ positiveResults.length }})</span>
              </span>
              <el-button v-if="openedResult" link size="small" type="primary" @click="openedResult = null">
                ← 查看全部
              </el-button>
            </div>

            <!-- 展开某一条时列表让位给详情；再点同一条或「查看全部」回到列表 -->
            <div v-if="openedResult" class="result-detail">
              <div class="rd-type">{{ openedResult.type === 'exam' ? '🔬 检查结果' : '🧪 检验结果' }}</div>
              <div class="rd-content">{{ openedResult.detail }}</div>
              <div class="rd-extra" :class="openedAbnormal ? 'abnormal' : 'normal'">{{ openedResult.extra }}</div>
            </div>

            <div v-else class="result-list-wrap">
              <div v-if="!positiveResults.length" class="no-abnormal">暂无阳性结果</div>
              <div v-else class="result-list">
                <div
                  v-for="item in positiveResults"
                  :key="item.id"
                  class="result-list-item"
                  :class="item.type"
                  @click="toggleResult(item)"
                >
                  <span class="rli-badge">{{ item.type === 'lab' ? '检验' : '检查' }}</span>
                  <span class="rli-name">{{ item.label }}</span>
                  <span class="rli-extra">{{ item.extra }}</span>
                  <span class="rli-arrow">›</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <AiEmrFloat v-if="patient" />

    <el-dialog v-model="referralDialog" title="挂转诊号" width="460px">
      <el-form label-width="80px" size="small">
        <el-form-item label="转入科室">
          <el-select v-model="newReferral.target_dept" filterable placeholder="选择科室" style="width: 100%">
            <el-option v-for="d in DEPARTMENTS" :key="d" :label="d" :value="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="转诊理由">
          <el-input v-model="newReferral.reason" type="textarea" :rows="3" placeholder="病情摘要与转诊目的" />
        </el-form-item>
        <el-form-item label="加急"><el-switch v-model="newReferral.urgent" /></el-form-item>
      </el-form>
      <template #footer>
        <span class="dialog-hint">写入本地库并留审计，不触达真实 HIS</span>
        <el-button @click="referralDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitReferral">确认挂号</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="admissionDialog" title="住院申请" width="460px">
      <el-form label-width="80px" size="small">
        <el-form-item label="入院科室">
          <el-select v-model="newAdmission.target_dept" filterable placeholder="选择科室" style="width: 100%">
            <el-option v-for="d in DEPARTMENTS" :key="d" :label="d" :value="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="入院指征">
          <el-input v-model="newAdmission.indication" type="textarea" :rows="3" placeholder="需要住院的临床依据" />
        </el-form-item>
        <el-form-item label="加急"><el-switch v-model="newAdmission.urgent" /></el-form-item>
      </el-form>
      <template #footer>
        <span class="dialog-hint">
          {{ ws.writeBackBlocked ? `${ws.openRedAlerts.length} 条红色风险未处置，已阻断` : '写入本地库并留审计' }}
        </span>
        <el-button @click="admissionDialog = false">取消</el-button>
        <el-button type="primary" :disabled="ws.writeBackBlocked" :loading="submitting" @click="submitAdmission">
          提交住院申请
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="examDialog" title="开立检查/检验" width="460px">
      <el-form label-width="80px" size="small">
        <el-form-item label="类别">
          <el-radio-group v-model="newExam.type">
            <el-radio value="检查">🔬 检查</el-radio>
            <el-radio value="检验">🧪 检验</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="项目名称"><el-input v-model="newExam.name" placeholder="如 糖化血红蛋白" /></el-form-item>
        <el-form-item label="途径"><el-input v-model="newExam.route" /></el-form-item>
        <el-form-item label="频次"><el-input v-model="newExam.freq" /></el-form-item>
      </el-form>
      <template #footer>
        <span class="dialog-hint">写入本地库并留审计，不触达真实 HIS</span>
        <el-button @click="examDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitExam">确认开立</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="orderDialog" title="开立医嘱" width="480px">
      <el-form label-width="72px" size="small">
        <el-form-item label="药品">
          <el-select v-model="newOrder.drug" filterable placeholder="选择药品" style="width: 100%">
            <el-option v-for="drug in drugs" :key="drug.id" :label="`${drug.name}${drug.spec ? ` (${drug.spec})` : ''}`" :value="drug.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="剂量"><el-input v-model="newOrder.dose" placeholder="如 10mg" /></el-form-item>
        <el-form-item label="频次"><el-input v-model="newOrder.freq" placeholder="如 qd" /></el-form-item>
        <el-form-item label="用法"><el-input v-model="newOrder.route" placeholder="如 口服" /></el-form-item>
        <el-form-item label="天数"><el-input v-model="newOrder.days" placeholder="如 30" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="orderDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitOrder">开立</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped src="../styles/OutpatientWorkstation.scoped.css"></style>
