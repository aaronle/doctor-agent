import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { api, type PatientDetail, type PatientListItem, type ReportSummary, type RiskItem, type VisitState } from '../api'
import { log, time } from '../logging'

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

  /* ===================== 就诊状态机 ===================== */

  /**
   * 这一场就诊走到哪了。
   *
   * **为什么要有它**：改之前，八个 AI 标签页的结论是在医生跟患者说第一句话
   * **之前**就算好的——只基于种子档案，不含任何问诊内容。摆在那里会让医生
   * 先看到答案再去找证据，那是锚定，不是辅助。
   *
   * 现在：进入只加载客观数据与硬规则红线，问诊结束（或医生显式跳过）才算分析。
   */
  const visit = ref<VisitState | null>(null)
  const analysisUnlocked = computed(() => Boolean(visit.value?.analysis_unlocked))
  /** 分析里含不含本次问诊。跳过路径下界面要如实标「未含问诊」。 */
  const interviewIncluded = computed(() => visit.value?.unlocked_by === 'interview')

  /**
   * 落库的问诊轮数。
   *
   * **横幅上那个「对话 N 轮」必须用它，不能用页面内存里的播放缓冲。**
   * 缓冲刷新一次就空了 —— 实测：问完诊生成分析、刷新页面，横幅变成
   * 「✓ 已按本次问诊生成 · 对话 0 轮」，而库里有 4 条。
   * 医生看到这行的合理结论是「问诊内容没被用上」；第二个医生打开同一个
   * 患者看到的也是 0。真相在服务端，横幅就得读服务端。
   */
  const interviewTurns = computed(() => visit.value?.interview_turns ?? 0)

  /**
   * 硬规则红色风险。**不锁**——纯代码判定，毫秒级，一进来就给。
   * 让医生在不知道血钾 6.8 的情况下问完一整轮，是不能接受的。
   */
  const hardAlerts = ref<RiskItem[]>([])

  /**
   * 客观资料：检查记录 + 时间轴。
   *
   * 单拉一份而不是等 summary —— 这两样是确定性的，跟模型无关，只是当初
   * 图省事挂在了同一个出口上。不拆开的话，「客观数据一进来就给」是句空话：
   * 锁着时时间轴、检查子页、健康档案概览全是空的。
   */
  const objective = ref<{ examinations: Record<string, unknown>[]; timeline: ReportSummary['timeline'] }>({
    examinations: [],
    timeline: [],
  })

  /** 检查记录：优先用分析里的（可能更全），没有就用单拉的那份 */
  const examinations = computed(() => summary.value?.examinations ?? objective.value.examinations)
  const timeline = computed(() => summary.value?.timeline ?? objective.value.timeline)

  async function loadObjective() {
    if (!patientId.value) return
    try {
      const result = await api.objective(patientId.value)
      objective.value = {
        examinations: Array.isArray(result.examinations) ? result.examinations : [],
        timeline: Array.isArray(result.timeline) ? result.timeline : [],
      }
    } catch {
      objective.value = { examinations: [], timeline: [] }
    }
  }

  async function loadVisitState() {
    if (!patientId.value) return
    try {
      visit.value = await api.visitState(patientId.value)
    } catch {
      // 读不到就按「未解锁」处理：宁可多锁一次，也不要在问诊前把结论摆出来
      visit.value = null
    }
  }

  async function loadHardAlerts() {
    if (!patientId.value) return
    try {
      const result = await api.redAlerts(patientId.value)
      // `?? []` 不是防御性冗余：返回体缺 alerts 时，下游 redAlerts 的展开会抛
      // 「not iterable」，而 Vue 的渲染函数一抛就是整棵树不渲染 —— 白屏。
      hardAlerts.value = Array.isArray(result.alerts) ? result.alerts : []
      restoreHandledAlerts(result.handled_alerts ?? [])
      log('workstation', 'hard_alerts', { patient: patientId.value, open: result.open_count })
    } catch {
      hardAlerts.value = []
    }
  }

  /**
   * 解锁分析并算一次。
   *
   * 两条路径合成一个动作：问诊结束由 voice/complete 在服务端顺带解锁，
   * 这里只需重拉状态再算；跳过则先显式解锁再算。
   */
  async function unlockAndAnalyse(reason: 'interview' | 'skipped') {
    if (!patientId.value) return
    log('workstation', 'unlock_analysis', { patient: patientId.value, reason })
    if (reason === 'skipped') {
      visit.value = await api.unlockAnalysis(patientId.value, 'skipped')
    } else {
      await loadVisitState()
    }
    await time('workstation', 'load_summary', () => loadSummary(true), { patient: patientId.value, reason })
  }

  // 两个 `?.` 都要有。`summary.value` 是接口原样落下来的（loadSummary 里
  // `summary.value = result`），只要哪次 200 回来的 body 里没有 `_meta`，
  // 这里就是一次真抛错 —— 而它在 computed 里，抛出去是**整个工作站白屏**，
  // 不是某一块降级。服务端当前每条路径都带 `_meta`，但这个断言的代价是白屏，
  // 不值得省一个问号。
  const degradedAgents = computed(() => summary.value?._meta?.degraded_agents ?? [])
  const isDegraded = computed(() => degradedAgents.value.length > 0)

  /**
   * 红色风险。未逐条处置前阻断病历提交与诊断回写。
   *
   * 两个来源合并：**硬规则**（纯代码，一进来就有）+ 模型判定（分析生成后才有）。
   * 只取 summary 的话，分析没出来之前红线就是空的——而提交病历这条路
   * 在那时候本来就走得通，等于门禁在最需要它的阶段是敞开的。
   *
   * **判据只能是 level，不能是来源。**
   *
   * 这里原来不看 level，默认「硬规则出的都是红的」。那在当时成立
   *（硬规则只有过敏冲突、危急值、生命体征越界三条，全是高风险），
   * 但它把一个**巧合**当成了不变量。2026-09-03 加了「阳性检查结论」
   * 这条中风险硬规则之后，实测 P008（骨科，4 项影像异常）：
   *
   *   - 横幅写着「硬规则**红色**风险 5 条」，而其中 4 条是中风险
   *   - `writeBackBlocked` 跟着为真，**病历提交与诊断回写被中风险拦住**
   *
   * 服务端早就按 level 筛了（`routers/emr.py` 的 `is_red`），
   * 只有这里没筛 —— 于是界面禁着按钮，而服务端其实放行。
   * 零容忍门禁一旦拦错东西，医生下一步就是想办法绕过它，
   * 那时真正该拦的也拦不住了。
   *
   * 中风险的硬规则不会消失，它们照常出现在「预警评估」页 ——
   * 只是不进红色横幅、不阻断回写。
   */
  const redAlerts = computed(() => {
    const seen = new Set<string>()
    const merged: RiskItem[] = []
    const hard = Array.isArray(hardAlerts.value) ? hardAlerts.value : []
    const fromModel = summary.value?.risk_alerts
    for (const a of [...hard, ...(Array.isArray(fromModel) ? fromModel : [])]) {
      if (!a?.id) continue
      if (a.level !== '高风险') continue
      if (seen.has(a.id)) continue
      seen.add(a.id)
      merged.push(a)
    }
    return merged
  })
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
    doctorEdited.value = new Set()
    handledAlerts.value = new Set()

    visit.value = null
    hardAlerts.value = []
    objective.value = { examinations: [], timeline: [] }

    loadingPatient.value = true
    try {
      patient.value = await api.patient(id)
    } finally {
      loadingPatient.value = false
    }

    // 一进来只拉「不依赖问诊」的东西：硬规则红线 + 这场就诊的状态。
    // **刻意不调 report-summary** —— 那四个岗位的结论要等问诊，见 visit 的注释。
    await Promise.all([loadHardAlerts(), loadVisitState(), loadObjective()])

    // 已经解锁过的（问诊做完了、或之前跳过了），刷新后要把分析拿回来，
    // 否则医生问完一轮刷新一下，八页又锁回去了。
    if (analysisUnlocked.value) await loadSummary()
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

  /**
   * 医生亲手改过的那几段。
   *
   * **F02 SAFE-002：新概况不得覆盖医生正在编辑的病历。**
   *
   * `generateRecord()` 原本第一行是 `draft = {}`，把整份草稿清空再流式写入。
   * 医生改完现病史、又多问两句、再点一次「生成」，改的东西无声消失。
   *
   * 这条以前踩不到（七段是 readonly，没东西可丢），是 2026-09-04 把它们
   * 改成可编辑之后才变成可达路径 —— **放开一个只读约束，等于打开它
   * 原本挡住的所有下游风险**。
   */
  const doctorEdited = ref<Set<string>>(new Set())

  /** 医生手输时走这里，同时留下「这段归我了」的标记 */
  function setDraftByDoctor(field: string, value: string) {
    draft.value = { ...draft.value, [field]: value }
    doctorEdited.value = new Set([...doctorEdited.value, field])
  }

  /** 模型流式写入走这里。**医生改过的段一律跳过。** */
  function appendDraftFromModel(field: string, chunk: string) {
    if (doctorEdited.value.has(field)) return
    draft.value = { ...draft.value, [field]: (draft.value[field] ?? '') + chunk }
  }

  /**
   * 重新生成前清空草稿，**但保住医生改过的那几段**，并返回保住了哪几段。
   *
   * 返回值不是可选的：悄悄保留和悄悄覆盖一样糟 —— 医生得知道
   * 这次重算里有哪几段不是新的。
   */
  function resetDraftForRegenerate(): string[] {
    const kept = [...doctorEdited.value].filter((f) => draft.value[f] !== undefined)
    const next: Record<string, string> = {}
    for (const f of kept) next[f] = draft.value[f]
    draft.value = next
    return kept
  }

  /** 换患者 / 重来：草稿与编辑标记一起清，否则会挡住下一位患者的生成 */
  function clearDraft() {
    draft.value = {}
    doctorEdited.value = new Set()
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
    doctorEdited,
    setDraftByDoctor,
    appendDraftFromModel,
    resetDraftForRegenerate,
    clearDraft,
    visit,
    analysisUnlocked,
    interviewIncluded,
    interviewTurns,
    hardAlerts,
    objective,
    examinations,
    timeline,
    loadObjective,
    loadVisitState,
    loadHardAlerts,
    unlockAndAnalyse,
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
