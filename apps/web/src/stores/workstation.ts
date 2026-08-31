import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { api, type PatientDetail, type PatientListItem, type ReportSummary } from '../api'

/** 病历七段，顺序与后端 SECTION_KEYS 一致 */
export const RECORD_SECTIONS = [
  ['chief_complaint', '主诉'],
  ['present_illness', '现病史'],
  ['past_history', '既往史'],
  ['personal_history', '个人史'],
  ['physical_exam', '体格检查'],
  ['auxiliary_exam', '辅助检查'],
  ['preliminary_diagnosis', '初步诊断'],
] as const

export type RecordField = (typeof RECORD_SECTIONS)[number][0]

/**
 * 工作站共享状态。
 *
 * 门诊病历面板与浮层里的 AI 助手是两个组件，但看的是同一个患者、同一份
 * 聚合结果。放在 store 里，避免同一次就诊里对 report-summary 发两次请求。
 */
export const useWorkstation = defineStore('workstation', () => {
  const patientId = ref('')
  const patient = ref<PatientDetail | null>(null)
  const summary = ref<ReportSummary | null>(null)
  const queue = ref<PatientListItem[]>([])

  const loadingPatient = ref(false)
  const loadingSummary = ref(false)
  const summaryError = ref('')

  /** 医生在左侧 HIS 病历里编辑的正式病历。AI 结果必须经确认才写进来。 */
  const record = ref<Record<string, string>>({})
  /** 右侧 AI 生成的病历草稿，未确认前不进 record */
  const draft = ref<Record<string, string>>({})

  const degradedAgents = computed(() => summary.value?._meta.degraded_agents ?? [])
  const isDegraded = computed(() => degradedAgents.value.length > 0)

  /** 红色风险。未逐条处置前阻断病历提交与诊断回写。 */
  const redAlerts = computed(() => summary.value?.risk_alerts ?? [])
  const handledAlerts = ref<Set<string>>(new Set())
  const openRedAlerts = computed(() => redAlerts.value.filter((a) => !handledAlerts.value.has(a.id)))
  const writeBackBlocked = computed(() => openRedAlerts.value.length > 0)

  function markAlertHandled(id: string) {
    handledAlerts.value = new Set([...handledAlerts.value, id])
  }

  /** 从服务端带回的列表恢复已处置状态 —— 刷新不该让医生重新处置一遍红线 */
  function restoreHandledAlerts(ids: string[]) {
    handledAlerts.value = new Set([...handledAlerts.value, ...ids])
  }

  /** 已处置的红色风险 id，回写时随请求上送供服务端二次校验 */
  const handledAlertIds = computed(() => [...handledAlerts.value])

  async function loadQueue() {
    queue.value = await api.patients()
  }

  async function selectPatient(id: string) {
    if (!id || id === patientId.value) return
    patientId.value = id
    patient.value = null
    summary.value = null
    summaryError.value = ''
    record.value = {}
    draft.value = {}
    handledAlerts.value = new Set()

    loadingPatient.value = true
    try {
      patient.value = await api.patient(id)
    } finally {
      loadingPatient.value = false
    }

    await loadSummary()
  }

  async function loadSummary(refresh = false) {
    if (!patientId.value) return
    loadingSummary.value = true
    summaryError.value = ''
    try {
      const result = await api.reportSummary(patientId.value, refresh)
      summary.value = result
      // 服务端记着哪些红线已处置，刷新后据此恢复 —— 否则医生得重新处置一遍
      restoreHandledAlerts(result.handled_alerts ?? [])
      // 病历基线来自种子的 record_content；AI 生成的草稿另存在 draft
      if (!Object.keys(record.value).length) {
        record.value = { ...(result.record_content ?? {}) }
      }
    } catch (error) {
      summaryError.value = (error as Error).message
    } finally {
      loadingSummary.value = false
    }
  }

  /** 把 AI 草稿的某一段写进正式病历。这是「医生确认」这一步的落点。 */
  function acceptDraftField(field: string) {
    if (draft.value[field] === undefined) return
    record.value = { ...record.value, [field]: draft.value[field] }
  }

  function acceptAllDraft() {
    record.value = { ...record.value, ...draft.value }
  }

  return {
    patientId,
    patient,
    summary,
    queue,
    loadingPatient,
    loadingSummary,
    summaryError,
    record,
    draft,
    degradedAgents,
    isDegraded,
    redAlerts,
    openRedAlerts,
    writeBackBlocked,
    markAlertHandled,
    handledAlertIds,
    restoreHandledAlerts,
    loadQueue,
    selectPatient,
    loadSummary,
    acceptDraftField,
    acceptAllDraft,
  }
})
