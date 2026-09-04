/**
 * 产品 API 客户端。
 *
 * 端点形状由 V4.3 打包产物定义，见 docs/product/08-V4.3界面基准与后端API契约.md。
 * 组件里禁止写死数据：任何界面上的临床内容都必须经由这里从后端取。
 */

const BASE = import.meta.env.VITE_API_BASE_URL ?? ''

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * 服务端原样的 `detail`。
     *
     * **不能只留 message。** 校验类接口把逐条错误放在
     * `detail.errors`（如 `cases[2].checks[0].kind = "…" 检查项不存在`），
     * 而 `Error(message)` 会把那个对象压成 `[object Object]` ——
     * 上传失败时用户只能看到一句「[object Object]」，
     * 手里却是一个几百行的 JSON。
     */
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    let raw: unknown = `HTTP ${response.status}`
    try {
      raw = (await response.json()).detail ?? raw
    } catch {
      // 后端异常时可能不是 JSON，保留状态码即可
    }
    // detail 可能是字符串（多数接口）也可能是对象（校验类接口的逐条错误）。
    // message 取可读的那一份，结构化的原样挂在 detail 上供调用方展开。
    const message = typeof raw === 'string' ? raw : `HTTP ${response.status}`
    throw new ApiError(message, response.status, raw)
  }
  return response.json() as Promise<T>
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) })
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })

// ------------------------------------------------------------------ 类型

/** 科室看板一行 */
export interface BoardRow {
  patient_id: string
  name: string
  age: number
  gender: string
  dept: string
  chief_complaint: string
  /** 闭集：未接诊 / 待报告 / 已问诊 / 已完成 */
  progress: 'not_started' | 'pending_report' | 'interviewed' | 'done'
  pending_exams: number
  in_queue: boolean
  /** 闭集。**「普通病人」是其中一档，不是「没标记」** */
  risk_tier: 'critical' | 'warning' | 'ordinary'
  open_red: number
  open_warn: number
  red_names: string[]
  allergy_status: string
  allergies: string[]
}

export interface BoardResponse {
  total: number
  done: number
  pending_report: number
  /** 今天还剩几个要处理 —— 医生第一眼看的就是这个数 */
  needs_attention: number
  rows: BoardRow[]
}

/** 数据看板：埋点使用概览 */
export interface UsageSummary {
  days: number
  total_events: number
  sessions: number
  /** 人均次数。只看总量会被一个人狂点刷上去 */
  per_session: number
  by_event: { event: string; count: number }[]
  by_target: { event: string; target: string; count: number }[]
}

/** 数据看板：微调语料概览 */
export interface TrainingSummary {
  total: number
  trainable_count: number
  by_verdict: { verdict: string; count: number }[]
  by_agent: { agent_key: string; count: number }[]
  recent: {
    id: number; patient_id: string; agent_key: string; task: string
    verdict: string; changed_fields: string[]; source: string
    trainable: boolean; created_at: string
  }[]
}

/** 数据看板：测试集一行 */
export interface DatasetRow {
  id: string
  name: string
  description: string
  enabled: boolean
  case_count: number
  agents: string[]
  error: string
  /** 内置的删不掉 —— 文件在只读镜像里，删了下次部署又回来 */
  builtin: boolean
}

/** 数据看板：知识库一行。**带长度不带正文** */
export interface KnowledgeRow {
  key: string
  title: string
  keywords: string[]
  content_length: number
  source: string
}


/**
 * 药物过敏史。**状态和过敏原绑在一个对象里，不拆成两个平级字段。**
 *
 * 拆开的话总有一处会只读 items 就下结论 —— 空列表既可能是「问过、没有」，
 * 也可能是「没人问过」，而这两者在门诊完全不同。绑在一起，
 * 拿到 items 时必然也拿到了 status。
 */
export interface Allergy {
  /** confirmed=有明确过敏原　denied=问过且否认　unknown=没人问过 */
  status: 'confirmed' | 'denied' | 'unknown'
  items: string[]
}

export interface PatientListItem {
  id: string
  name: string
  gender: string
  age: number
  /** `YYYY-MM-DD`，服务端由身份证号推导。界面只显示到月。 */
  birth_date: string
  allergy: Allergy
  visit_type: string
  dept: string
  doctor: string
  visit_date: string
  chief_complaint: string
  primary_diagnosis: string
  risk_level: string
}

export interface LabResult {
  name: string
  value: string
  unit?: string
  ref?: string
  abnormal?: boolean
  history?: string[]
  history_dates?: string[]
  trend?: string
  diff_note?: string
}

export interface PatientOrder {
  id: string
  drug?: string
  name?: string
  dose?: string
  freq?: string
  route?: string
  days?: string | number
  status?: string
  category?: string
  /** 检查与检验同为 category=exam，靠这个字段区分 */
  exam_type?: string
}

export interface PatientDetail extends PatientListItem {
  id_no: string
  phone: string
  is_return_visit: boolean
  pre_consultation_done: boolean
  nutrition_screening_score: number
  diagnoses?: unknown[]
  suspected_diagnoses?: SuspectedDiagnosis[]
  past_history?: string
  allergies?: string | string[]
  vitals?: Record<string, string | number>
  lab_results?: LabResult[]
  orders?: PatientOrder[]
  visit_history?: unknown[]
  health_archive?: Record<string, unknown>
}

/**
 * 风险等级的**严重程度次序**，数字越小越急。未知取值排最后。
 *
 * 与服务端 `agents/schemas.py` 的 `RISK_LEVEL_ORDER` 是同一套次序。
 * **两份实现是有意的，不是疏忽**：服务端排好的顺序，前端拼「硬规则 + 模型项」
 * 时会重新打乱（硬规则要在分析回来之前就显示，那时没有模型项可拼）。
 * 改动任一侧都要同时改另一侧，两边各有测试钉着。
 */
const RISK_LEVEL_ORDER = ['高风险', '中风险', '低风险']

export function riskLevelRank(level: unknown): number {
  const i = RISK_LEVEL_ORDER.indexOf(String(level))
  return i === -1 ? RISK_LEVEL_ORDER.length : i
}

/**
 * 按等级从高到低排。**稳定排序** —— 同一等级内保持传入次序，
 * 于是硬规则仍排在模型项前面（它有明确阈值，比模型判断更硬）。
 */
export function sortByRiskLevel<T extends { level?: unknown }>(items: T[]): T[] {
  return [...items].sort((a, b) => riskLevelRank(a.level) - riskLevelRank(b.level))
}

export interface RiskItem {
  id: string
  name: string
  level: string
  color: string
  summary: string
  evidence?: string
  assessment?: string
  suggestion?: string
  source?: string
  threshold?: string
  rule?: string
}

export interface DifferentialRef {
  name: string
  likelihood: string
  reason: string
}

export interface SuspectedDiagnosis {
  name: string
  confidence: number
  icd?: string
  desc?: string
  suggestion?: string
  supporting?: string[]
  opposing?: string[]
  missing?: string[]
  /** 以下四项由后端按置信度排序派生，界面直接用，不在前端重算 */
  rank?: number
  rank_label?: string
  /**
   * 漏诊后果。**排序的第一关键字**（F04 L51）——
   * 一个 30% 的急性冠脉综合征要排在 55% 的冠心病之上。
   */
  severity?: 'critical' | 'serious' | 'routine'
  rank_key?: string
  likelihood?: string
  differentials?: DifferentialRef[]
}

export interface ComorbidityCondition {
  name: string
  icd?: string
  duration?: string
  risk_level: string
  analysis: string
  recommended_dept: string
}

/** AI 处置单的一条。形状对齐 V4.3，由后端按确定性规则产出。 */
export interface TodoItem {
  id: string
  text: string
  priority: string
  source: string
  /** 一律为 false —— 系统不替医生判断某件事做完没有 */
  done: boolean
  /** 闭集，决定按钮文案、配色与跳转目标 */
  action_type: string
  category: string
}

export interface ReportSummary {
  overall_conclusion: { risk_level?: string; summary?: string; problems?: string[]; conflicts?: string[] }
  treatment_effectiveness: { ai_summary?: string }
  risk_assessments: RiskItem[]
  risk_alerts: RiskItem[]
  recommended_orders: { drug: string; dose: string; freq: string; route: string; basis: string }[]
  examinations: Record<string, unknown>[]
  /** 推荐复查项。与 todos 分开 —— 待办清单不兼职当推荐列表 */
  recommended_exams: { id: string; name: string; type: string; basis: string }[]
  todos: TodoItem[]
  dialog_script: { role: string; text: string }[]
  record_nodes: Record<string, string>
  record_content: Record<string, string>
  is_return_visit: boolean
  pre_consultation_done: boolean
  suspected_diagnoses: SuspectedDiagnosis[]
  differential_diagnosis: { items?: SuspectedDiagnosis[] }
  visit_history: unknown[]
  comorbidity: {
    detected: boolean
    risk_level?: string
    summary?: string
    recommendation?: string
    conditions: ComorbidityCondition[]
    nutrition?: { triggered: boolean; score: number; threshold: number; message: string }
  }
  /** 已处置的红色风险 id，刷新后据此恢复 */
  handled_alerts: string[]
  timeline: { time?: string; type?: string; category?: string; action?: string; detail?: string; result?: string; analysisHint?: string }[]
  _meta: { degraded_agents: string[]; hard_rule_alerts: number; model_conflicts: string[]; cached: boolean }
}

export interface AgentSummary {
  agent_key: string
  name: string
  tasks: string[]
  code_version: string
  running_version: string
  config_source: 'published' | 'code-default'
  model_tier: string
  model: string
  has_draft: boolean
  published_at: string | null
  runs_24h: number
  success_rate: number | null
  avg_elapsed_ms: number | null
  tokens_24h: number
}

export interface AgentVersionRow {
  id: number
  version: string
  status: 'draft' | 'published' | 'inactive'
  model_tier: string
  model: string
  prompt_hash: string
  note: string
  author: string
  created_at: string
  published_at: string | null
}

export interface AgentDetail {
  agent_key: string
  name: string
  tasks: string[]
  /** 平台安全层。只读展示 —— 它只能随代码发布，管理员不可编辑。 */
  safety_layer: string
  safety_layer_editable: false
  code_default_prompt: string
  output_schema: Record<string, unknown>
  context_fields: string[]
  running: { version: string; source: string; model_tier: string; model: string; role_prompt: string; params: Record<string, unknown> }
  draft: { id: number; model_tier: string; role_prompt: string; params: Record<string, unknown>; note: string } | null
  versions: AgentVersionRow[]
}

export interface AgentRunLog {
  id: number
  agent_key: string
  patient_id: string
  status: string
  provider: string
  model: string
  model_tier: string
  config_version: string
  config_source: string
  elapsed_ms: number
  total_tokens: number
  context_hash: string
  error: string
  created_at: string
}

export interface RuntimeConfig {
  api_key: string
  base_url: string
  model: string
  max_tokens: number
  mock_generation: boolean
}

export type QualityMetric = { name: string; value: number; basis: string }

export type QualityGap = {
  text: string
  level: string
  status: string
  /** 中文段名，用于「【既往史】」这样的展示 */
  field: string
  /** 段的键名，界面据此跳到对应那一段病历 */
  field_key: string
  issue: string
  /** 决定图标：error ❌ / warning ⚠️ / info ℹ️ */
  type: 'error' | 'warning' | 'info'
}

export type RecordQuality = {
  completeness: number
  metrics: QualityMetric[]
  gaps: QualityGap[]
}

// ------------------------------------------------------------------ 端点

export interface KnowledgeItem {
  key: string
  title: string
  keywords: string[]
}

export interface KnowledgeEntry extends KnowledgeItem {
  /** 结构化 HTML（h3/table/ul/p）。本仓库静态提供，无用户输入参与拼接。 */
  content: string
}

export interface DryRunResult {
  output: Record<string, unknown>
  provider: string
  degraded: boolean
  note: string
  model: string
  model_tier: string
  config_version: string
  config_source: string
  prompt_hash: string
  elapsed_ms: number
  total_tokens: number
}

export interface CompareResult {
  patient_id: string
  published: DryRunResult
  draft: DryRunResult
  /** 逐字段差异。输出几十个字段，给两坨 JSON 等于没给。 */
  diff: { field: string; kind: 'same' | 'changed' | 'added' | 'removed' }[]
}

export interface EvalCheck {
  name: string
  passed: boolean
  detail: string
}

export interface EvalCaseResult {
  case_id: string
  name: string
  patient_id: string
  /** 降级时输出来自本地规则，判定说明不了提示词好坏，界面要单独标 */
  degraded: boolean
  elapsed_ms: number
  passed: boolean
  checks: EvalCheck[]
}

/** 一个评测数据集。内容是 data/eval_datasets/*.json，开关落库。 */
/**
 * 这一场就诊走到哪了。
 *
 * `analysis_unlocked` 决定 AI 助手抽屉里那四块模型推断的内容给不给看；
 * `unlocked_by` 决定界面标「含本次问诊」还是「未含问诊」。
 */
export interface VisitState {
  patient_id: string
  interview_done: boolean
  analysis_unlocked: boolean
  unlocked_by: '' | 'interview' | 'skipped'
  unlocked_at: string
  /** 落库的问诊轮数。界面横幅用它，不用页面内存里的播放缓冲 */
  interview_turns: number
}

export interface EvalDataset {
  id: string
  name: string
  description: string
  /** 自建虚构 / 规范倒推 / 外部导入 —— 决定这一集的可信来源 */
  source: string
  /** 依据出处，如规范条文或需求文档 */
  reference: string
  enabled: boolean
  case_count: number
  agents: string[]
  /** 加载/编译失败的原因。非空时该集不参与运行，但仍然列出来 */
  error: string
}

export interface EvalResult {
  total: number
  passed: number
  failed: number
  config_version: string
  config_source: string
  cases: EvalCaseResult[]
  /** 本次实际跑到的数据集。没有它，「通过率」就没有分母 */
  datasets?: { id: string; name: string; case_count: number }[]
}

// ------------------------------------------------------------------ 交付平台

export type DeliveryLane = 'feature' | 'agent'
export type StageStatus = 'idle' | 'running' | 'passed' | 'failed' | 'skipped'

export interface DeliveryStage {
  name: string
  status: StageStatus
  detail: string
  elapsed_ms: number
  note?: string
}

/** 门禁逐项。粒度比 stage 细：一个 stage 下可以有多个门禁。 */
export interface DeliveryGate {
  key: string
  label: string
  stage: string
  ok: boolean
  detail: string
  elapsed_ms: number
}

export interface DeliveryRun {
  run_key: string
  lane: DeliveryLane
  title: string
  subtitle: string
  status: 'running' | 'passed' | 'failed' | 'deployed' | 'blocked'
  stages: DeliveryStage[]
  meta: {
    commit?: string
    branch?: string
    subject?: string
    dirty_files?: number
    diffstat?: string
    gates?: DeliveryGate[]
    /** 构建/部署日志尾部。[时刻, 内容, 语气] */
    log?: [string, string, 'dim' | 'ok' | 'err' | 'fix'][]
    /** 智能体线：回归集未过的条目及其原因 */
    regressions?: { case: string; reason: string }[]
    pass_rate?: { passed: number; total: number }
    [k: string]: unknown
  }
  started_at: string | null
  updated_at: string | null
}

export interface DeliveryPipelines {
  lanes: Record<DeliveryLane, DeliveryRun | null>
  deploy_executor: string
  deploy_note: string
}

export interface DeliveryReleaseItem {
  kind: DeliveryLane
  ref: string
  title: string
  detail: string
  status: 'current' | 'superseded' | 'rolled_back'
  at: string | null
  can_rollback: boolean
  meta: Record<string, string>
}

export interface DeliveryReleases {
  items: DeliveryReleaseItem[]
  rollback_semantics: { feature: string; agent: string }
}

export interface DeliveryProduction {
  from_image: {
    release: string
    commit: string
    image: string
    released_at: string | null
    runtime_mode: string
    write_back_mode: string
    model_fast: string
    model_smart: string
    model_orchestration: string
    ai: string
    timeout_ms: number
  }
  from_database: {
    agents: {
      agent_key: string
      label: string
      version: string
      model_tier: string
      published_at: string | null
      source: 'database' | 'code_default'
    }[]
    datasets_enabled: number
    datasets_disabled: number
  }
  note: string
  at: string
}

export const api = {
  config: () => get<RuntimeConfig>('/api/config'),

  /** 知识库目录。带 q 时按关键词匹配，返回该文本命中的条目。 */
  knowledgeMatch: (q: string) =>
    get<{ items: KnowledgeItem[] }>(`/api/emr/knowledge?q=${encodeURIComponent(q)}`),
  /** 单条正文。按需拉取 —— 正文最长 800 余字，列表阶段不该带上。 */
  knowledgeEntry: (key: string) => get<KnowledgeEntry>(`/api/emr/knowledge/${key}`),


  // ---------------------------------------------------------------- 控制台
  adminAgents: () =>
    get<{ agents: AgentSummary[]; model_tiers: { tier: string; label: string; model: string }[]; prompt_bundle_version: string }>(
      '/api/admin/agents',
    ),
  adminAgent: (key: string) => get<AgentDetail>(`/api/admin/agents/${key}`),

  /** 用草稿或线上配置跑一个演示病例。不写缓存、不落库、不计入运行统计。 */
  adminDryRun: (key: string, patientId: string, use: 'draft' | 'published') =>
    post<DryRunResult>(`/api/admin/agents/${key}/dry-run`, { patient_id: patientId, use }),
  /** 草稿与线上并排跑同一个病例，服务端并发发起。 */
  adminCompare: (key: string, patientId: string) =>
    post<CompareResult>(`/api/admin/agents/${key}/compare`, { patient_id: patientId }),
  adminEvalCases: (key: string) =>
    get<{
      cases: {
        id: string; name: string; agent_key: string; patient_id: string
        dataset_id: string; dataset_name: string; checks: string[]
      }[]
    }>(`/api/admin/eval-cases?agent_key=${key}`),

  /** 数据集清单与启停状态 */
  adminEvalDatasets: () => get<{ datasets: EvalDataset[] }>('/api/admin/eval-datasets'),
  /** 启用/停用一个数据集。服务端留审计。 */
  adminToggleEvalDataset: (id: string, enabled: boolean) =>
    request<{ ok: boolean; datasets: EvalDataset[] }>(`/api/admin/eval-datasets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  adminRunEval: (key: string, use: 'draft' | 'published') =>
    post<EvalResult>(`/api/admin/agents/${key}/eval`, { use }),

  adminSaveDraft: (key: string, body: { model_tier: string; role_prompt: string; note: string }) =>
    request<{ ok: boolean; draft_id: number; prompt_hash: string }>(`/api/admin/agents/${key}/draft`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  adminPublish: (key: string) => post<{ ok: boolean; version: string }>(`/api/admin/agents/${key}/publish`, {}),
  adminRollback: (key: string, versionId: number) =>
    post<{ ok: boolean; version: string }>(`/api/admin/agents/${key}/rollback/${versionId}`, {}),
  adminDiscardDraft: (key: string) =>
    request<{ ok: boolean }>(`/api/admin/agents/${key}/draft`, { method: 'DELETE' }),
  adminRuns: (key = '') => get<{ runs: AgentRunLog[] }>(`/api/admin/runs${key ? `?agent_key=${key}` : ''}`),
  health: () => get<Record<string, unknown>>('/api/health'),

  patients: () => get<PatientListItem[]>('/api/his/patients'),
  patientsManage: () =>
    get<{ ok: boolean; patients: (PatientListItem & { in_queue: boolean; reminded: boolean })[]; total: number; reminded_count: number }>(
      '/api/his/patients/manage',
    ),
  remind: (patientIds: string[]) =>
    post<{ ok: boolean; reminded_count: number; message: string }>('/api/his/patients/remind', {
      patient_ids: patientIds,
    }),
  patient: (id: string) => get<PatientDetail>(`/api/his/patient/${id}`),
  diagnoses: (id: string) => get<unknown[]>(`/api/his/patient/${id}/diagnoses`),
  drugs: () => get<Record<string, unknown>[]>('/api/his/drugs'),

  createOrder: (body: Record<string, unknown>) => post<{ ok: boolean; order: PatientOrder }>('/api/his/orders', body),
  createExam: (body: Record<string, unknown>) => post<{ ok: boolean; exam: PatientOrder }>('/api/his/exams', body),
  createReferral: (body: Record<string, unknown>) => post<{ ok: boolean; message: string }>('/api/his/referral', body),
  createAdmission: (body: Record<string, unknown>) =>
    post<{ ok: boolean; message: string }>('/api/his/admission', body),

  /** 科室看板：诊疗进度 × 风险两个维度 */
  departmentBoard: () => get<BoardResponse>('/api/his/board'),

  // ---------------------------------------------------------------- 数据看板
  usageSummary: (days = 7) => get<UsageSummary>(`/api/telemetry/usage?days=${days}`),
  trainingSummary: () => get<TrainingSummary>('/api/telemetry/training'),
  listDatasets: () => get<{ items: DatasetRow[] }>('/api/data/datasets'),
  uploadDataset: (payload: Record<string, unknown>) =>
    post<{ ok: boolean; dataset_id: string; case_count: number }>('/api/data/datasets', { payload }),
  deleteDataset: (id: string) => del<{ ok: boolean }>(`/api/data/datasets/${encodeURIComponent(id)}`),
  listKnowledge: () => get<{ items: KnowledgeRow[]; empty_count: number }>('/api/data/knowledge'),
  getKnowledge: (key: string) =>
    get<{ key: string; title: string; keywords: string[]; content: string; source: string }>(
      `/api/data/knowledge/${encodeURIComponent(key)}`),
  saveKnowledge: (key: string, body: Record<string, unknown>) =>
    put<{ ok: boolean; content_length: number; sanitized: boolean }>(
      `/api/data/knowledge/${encodeURIComponent(key)}`, body),
  deleteKnowledge: (key: string) =>
    del<{ ok: boolean }>(`/api/data/knowledge/${encodeURIComponent(key)}`),
  importKnowledge: (entries: Record<string, unknown>) =>
    post<{ ok: boolean; imported: number }>('/api/data/knowledge/import', { entries }),

  reportSummary: (id: string, refresh = false) =>
    get<ReportSummary>(`/api/emr/report-summary/${id}${refresh ? '?refresh=true' : ''}`),
  generateRecordAuto: (body: Record<string, unknown>) =>
    post<{ fields: Record<string, string>; provider: string; degraded: boolean }>('/api/emr/generate-record-auto', body),
  generateRecordField: (patientId: string, field: string, noteText: string) =>
    post<{ field: string; generated_text: string; provider: string; degraded: boolean }>(
      '/api/emr/generate-record-field',
      { patient_id: patientId, field, note_text: noteText },
    ),

  // 问诊开场包：一次返回播放一整场问诊所需的全部内容
  interviewInit: (id: string) =>
    get<{
      greeting: string
      patient_name: string
      chief_complaint: string
      diagnoses: unknown[]
      dialog: { role: string; text: string }[]
      questions: string[]
      observations: string[]
      provider: string
      degraded: boolean
    }>(`/api/emr/interview/init/${id}`),
  /** 重新接诊：把已完成的患者放回候诊队列（提交病历会让患者出队）。 */
  requeuePatient: (patientId: string) =>
    post<{ ok: boolean; message: string; changed: boolean }>('/api/his/patients/requeue', { patient_id: patientId }),

  /** 这一场就诊的状态。刷新后据此恢复，否则问完一轮刷新就锁回去了。 */
  visitState: (patientId: string) => get<VisitState>(`/api/emr/visit-state/${patientId}`),
  /** 解锁 AI 分析。reason=interview 由问诊结束自动触发，skipped 是医生显式跳过。 */
  unlockAnalysis: (patientId: string, reason: 'interview' | 'skipped') =>
    post<VisitState & { ok: boolean }>('/api/emr/analysis/unlock', { patient_id: patientId, reason }),
  /**
   * 硬规则红色风险。纯代码判定、毫秒级，**不等问诊也不等 report-summary**。
   * 让医生在不知道危急值的情况下问完一整轮，是不能接受的。
   */
  redAlerts: (patientId: string) =>
    get<{ patient_id: string; alerts: RiskItem[]; handled_alerts: string[]; open_count: number }>(
      `/api/emr/red-alerts/${patientId}`,
    ),

  /**
   * 客观资料：检查记录 + 时间轴。确定性、毫秒级、不调模型，**不受问诊门禁**。
   * 它们原本搭 report-summary 一起回来 —— 那个请求现在要等问诊，
   * 于是「客观数据一进来就给」就成了空话。
   */
  objective: (patientId: string) =>
    get<{ patient_id: string; examinations: Record<string, unknown>[]; timeline: ReportSummary['timeline'] }>(
      `/api/emr/objective/${patientId}`,
    ),

  /** 记录一次红色风险处置。落患者主档 + 审计 —— 刷新后要能恢复。 */
  handleAlert: (patientId: string, alertId: string, alertName: string) =>
    post<{ ok: boolean; handled_alerts: string[]; message: string }>('/api/emr/alerts/handle', {
      patient_id: patientId, alert_id: alertId, alert_name: alertName,
    }),
  /** 记录一次质控审阅。只留痕，不清除遗漏。 */
  qcReview: (patientId: string, gapCount: number) =>
    post<{ ok: boolean; message: string }>('/api/emr/record/qc-review', {
      patient_id: patientId, gap_count: gapCount,
    }),

  /** 暂存病历。不过红线门禁 —— 暂存的用途就是「还没弄完，先存着」。 */
  stashRecord: (patientId: string, fields: Record<string, string>) =>
    post<{ ok: boolean; version: number; message: string }>('/api/emr/record/stash', {
      patient_id: patientId, fields,
    }),
  /** 提交病历。服务端会再校验一次红色风险闭环，未闭环返回 409。 */
  submitRecord: (patientId: string, fields: Record<string, string>, handledAlerts: string[]) =>
    post<{ ok: boolean; version: number; message: string; dequeued: boolean }>('/api/emr/record/submit', {
      patient_id: patientId, fields, handled_alerts: handledAlerts,
    }),
  /** 读回最近一次暂存/提交的病历 —— 没有它，刷新就得从头再来。 */
  savedRecord: (patientId: string) =>
    get<{
      patient_id: string
      latest: { version: number; fields: Record<string, string>; provider: string; created_at: string } | null
      submitted: { version: number; fields: Record<string, string> } | null
    }>(`/api/emr/record/${patientId}`),

  /** 病历质控。四项指标由后端确定性规则算，不让模型给自己打分。 */
  recordQuality: (patientId: string, fields: Record<string, string>) =>
    post<RecordQuality>('/api/emr/record/quality', { patient_id: patientId, fields }),

  /** 问诊结束：出小结、解锁分析 */
  interviewComplete: (body: Record<string, unknown>) => post<Record<string, unknown>>('/api/emr/interview/complete', body),

  /**
   * AI 追问提示 · 清单。**一场问诊只调一次** —— 清单是档案里的缺口，
   * 对话推进不会改变它；每轮重算会让条目在医生眼皮底下换来换去。
   */
  followUpPlan: (id: string) =>
    get<{ questions: string[]; provider: string; degraded: boolean }>(
      `/api/emr/interview/followup/${id}`,
    ),

  /**
   * AI 追问提示 · 判定哪些已经问到了。
   *
   * `pending` 只发**还开着的**问题 —— 单调性靠这个保证：已划掉的不发上去，
   * 服务端也就没有机会把它取消划掉。
   */
  followUpCoverage: (id: string, pending: string[], messages: { role: string; text: string }[]) =>
    post<{ covered: { question: string; quote: string }[]; provider: string; degraded: boolean }>(
      '/api/emr/interview/followup/coverage',
      { patient_id: id, pending, messages },
    ),
  interviewHistory: (id: string) =>
    get<{ patient_id: string; sessions: { ended_at: string; summary: string; messages: unknown[] }[] }>(
      `/api/emr/interview/history/${id}`,
    ),

  /** 确认并回写诊断。服务端会再校验一次红色风险闭环，前端禁用只是体验。 */
  diagnosisWriteBack: (patientId: string, diagnoses: string[], primary: string, handledAlerts: string[]) =>
    post<{ ok: boolean; message: string }>('/api/emr/diagnosis/write-back', {
      patient_id: patientId,
      diagnoses,
      primary,
      handled_alerts: handledAlerts,
    }),

  // V4.3 把 33 项专项评估硬编码在打包产物里；改由后端提供以满足「前端零写死数据」
  assessmentCatalog: () =>
    get<{ note: string; categories: { name: string; count: number; items: { name: string; level: string; desc: string }[] }[] }>(
      '/api/emr/assessment-catalog',
    ),

  // ---------------------------------------------------------------- 交付平台
  //
  // 只读。写入（上报、发布记录、功能回滚）要 X-Delivery-Token，由脚本在开发机上带，
  // **不下发到浏览器** —— 前端拿得到的令牌等于没有令牌。
  // 智能体回滚是唯一的例外：它走控制台既有的 /api/admin 路径（见 adminRollback），
  // 不在这里另开一条。
  deliveryPipelines: () => get<DeliveryPipelines>('/api/delivery/pipelines'),
  deliveryRuns: (lane?: 'feature' | 'agent') =>
    get<{ items: DeliveryRun[] }>(`/api/delivery/runs${lane ? `?lane=${lane}` : ''}`),
  deliveryRun: (runKey: string) => get<DeliveryRun>(`/api/delivery/runs/${runKey}`),
  deliveryReleases: () => get<DeliveryReleases>('/api/delivery/releases'),
  deliveryProduction: () => get<DeliveryProduction>('/api/delivery/production'),

  comorbidityCheck: (id: string) =>
    post<{ ok: boolean; comorbidity: ReportSummary['comorbidity'] }>('/api/emr/comorbidity/check', { patient_id: id }),
  comorbidityConsultation: (id: string, focusNutrition: boolean) =>
    post<{ ok: boolean; message: string; referral: { id: string; target_dept: string; reason: string } }>(
      '/api/emr/comorbidity/consultation',
      { patient_id: id, focus_nutrition: focusNutrition },
    ),
}

// ------------------------------------------------------------------ SSE

export interface SseEvent {
  type: string
  [key: string]: unknown
}

/**
 * 读取 SSE 流。
 *
 * 不用 EventSource：它只支持 GET，而 V4.3 的两个流式端点都是 POST。
 */
export async function streamSse(
  path: string,
  body: unknown,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok || !response.body) {
    throw new ApiError(`流式请求失败：HTTP ${response.status}`, response.status)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE 以空行分隔事件；最后一段可能不完整，留在缓冲区等下一片
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          onEvent(JSON.parse(payload) as SseEvent)
        } catch {
          // 单条事件解析失败不应中断整个流
        }
      }
    }
  }
}
