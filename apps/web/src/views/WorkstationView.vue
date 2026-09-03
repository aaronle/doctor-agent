<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import AiEmrFloat from '../components/AiEmrFloat.vue'
import HisBackdrop from '../components/HisBackdrop.vue'
import MobileWorkstation from '../mobile/MobileWorkstation.vue'
import { api, type LabResult, type PatientOrder } from '../api'
import { useIsMobile } from '../composables/useMediaQuery'
import { useSession } from '../stores/session'
import { useWorkstation } from '../stores/workstation'

const route = useRoute()
const router = useRouter()
const session = useSession()
const ws = useWorkstation()
const isMobile = useIsMobile()

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
/**
 * 「检查」子页：患者**已做的检查** + 本次**新开的检查**。
 *
 * 早先这一页只过滤「category === 'exam' 的医嘱」，而种子医嘱一条都没有 category ——
 * 于是患者明明做过心电图、眼底照相、颈动脉超声，这一页却永远是空的（角标 0，
 * 原件是 3）。检查记录的正主是 examinations，医嘱表里只有本次新开的那些。
 *
 * 列按原件：检查项目 / 类型 / 日期 / 结论。新开的还没有结果，结论写「待出结果」。
 */
type ExamRow = { id: string; name: string; type: string; date: string; conclusion: string }

const labResults = computed<LabResult[]>(() => patient.value?.lab_results ?? [])

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

const examDialog = ref(false)

const newExam = ref({ name: '', type: '检查', route: '门诊', freq: '一次' })

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
    // 提交即出队，刷新队列让「今日候诊 N 人」跟着变 ——
    // 不刷新的话医生看完全部患者，计数纹丝不动，看着像没生效
    if (result.dequeued) await ws.loadQueue()
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

/** 跳到预警评估去处置。红线的处置入口只有一个，不在这里另开一套。 */
function goHandleAlerts() {
  window.dispatchEvent(new CustomEvent('da:open-tab', { detail: '预警评估' }))
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
  <!--
    移动端是另一套信息架构：落地即对话，底部三档切换，且**不写 HIS/EMR**
    （提交病历、回写诊断、开立医嘱都不在移动端提供）。桌面端三层固定宽度的
    面板在 390px 里一次只能显示一个，响应式重排救不了，只能换掉整块。
  -->
  <MobileWorkstation v-if="isMobile" />

  <div v-else class="workstation-page">
    <!--
      极简页头。**HIS 门面已整块撤掉**（2026-09-02）：这套界面复刻的是 V4.3 演示件，
      不是北大国际医院的真实 HIS，而链接是会被转发出去的 —— 一个长得像 HIS 的
      页面很容易让人以为「已经和院内系统打通了」。

      所以留下的只有：回列表、患者身份、以及一条**常驻的**「未接入院内 HIS」标识。
      转诊 / 住院 / 医嘱 / 阳性结果这些模拟 HIS 的功能一并撤掉。
    -->
    <div class="his-header">
      <div class="his-header-left">
        <el-button text class="back-btn" :icon="ArrowLeft" @click="router.push('/outpatient/list')">候诊列表</el-button>
        <span class="his-divider">|</span>
        <span class="his-title">AI 门诊工作站</span>
        <span class="demo-badge">演示环境 · 未接入任何院内 HIS</span>
      </div>
      <div class="his-header-right">
        <el-tag v-if="ws.isDegraded" size="small" type="warning" effect="light">
          {{ ws.degradedAgents.length }} 个智能体已降级
        </el-tag>
        <el-button text size="small" @click="router.push('/admin')">Agent 控制台</el-button>
        <el-button text size="small" @click="router.push('/outpatient/manage')">患者管理</el-button>
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

    <!--
      硬规则红线横幅。**任何状态都在场** —— 它是纯代码判定，不依赖模型也不依赖问诊。
      让医生在不知道血钾 6.8 的情况下问完一整轮，是不能接受的，
      所以它不跟 AI 分析一起锁在问诊门禁后面。
    -->
    <div v-if="ws.openRedAlerts.length" class="redline-banner">
      <span class="rb-icon">⛔</span>
      <span class="rb-title">硬规则红色风险 {{ ws.openRedAlerts.length }} 条</span>
      <span class="rb-names">{{ ws.openRedAlerts.map((a) => a.name).join(' · ') }}</span>
      <span class="rb-spacer" />
      <span class="rb-note">纯代码规则判定，不依赖模型与问诊</span>
      <el-button type="danger" size="small" @click="goHandleAlerts">逐条处置</el-button>
    </div>

    <!--
      院内 HIS 门面 —— **纯演示道具，不实现任何功能**。

      「医生智能体」是浮窗，它真实的使用场景是浮在医生本来就在用的 HIS 上。
      底下空着的话，演示时看到的是「一个孤立的 AI 工具」；有了这层，
      看到的才是「AI 长在医生现有的工作流里」—— 那才是产品要讲的事。

      > 这块 2026-09-02 曾被**整块撤掉**，理由是「一个长得像 HIS 的页面很容易
      > 让人以为已经和院内系统打通了」。09-03 按需求做回来，**那个顾虑一个字没变**，
      > 所以它带着两道标识回来：页头常驻的「演示环境 · 未接入任何院内 HIS」，
      > 以及门面自己右下角的「界面仿真 · 不可操作」。**两条都不能删。**
      >
      > 与当年那版的区别：这一版不再是「仿真的 HIS 数据展示」冒充功能，
      > 而是明确的**背景道具** —— 照北大国际医院现行 HIS 的外观仿的，
      > 只有切页签、勾选、折叠这类纯前端反馈，不发任何请求、不写任何数据。

      AI 真正产出的病历在 AI 助手里（「病历 AI 生成」那一栏），
      那里才是草稿的落点与「确认后写回」的发生地 —— 和这层门面不是一回事。
    -->
    <HisBackdrop :patient="patient" />

    <AiEmrFloat v-if="patient" />

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
