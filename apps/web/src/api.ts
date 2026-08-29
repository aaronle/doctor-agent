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
    let detail = `HTTP ${response.status}`
    try {
      detail = (await response.json()).detail ?? detail
    } catch {
      // 后端异常时可能不是 JSON，保留状态码即可
    }
    throw new ApiError(detail, response.status)
  }
  return response.json() as Promise<T>
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) })

// ------------------------------------------------------------------ 类型

export interface PatientListItem {
  id: string
  name: string
  gender: string
  age: number
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

export interface SuspectedDiagnosis {
  name: string
  confidence: number
  icd?: string
  desc?: string
  supporting?: string[]
  opposing?: string[]
  missing?: string[]
}

export interface ComorbidityCondition {
  name: string
  icd?: string
  duration?: string
  risk_level: string
  analysis: string
  recommended_dept: string
}

export interface ReportSummary {
  overall_conclusion: { risk_level?: string; summary?: string; problems?: string[]; conflicts?: string[] }
  treatment_effectiveness: { ai_summary?: string }
  risk_assessments: RiskItem[]
  risk_alerts: RiskItem[]
  recommended_orders: { drug: string; dose: string; freq: string; route: string; basis: string }[]
  examinations: Record<string, unknown>[]
  todos: { type: string; title: string; detail: string; level: string }[]
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
  timeline: { time?: string; action?: string; detail?: string; actor?: string }[]
  _meta: { degraded_agents: string[]; hard_rule_alerts: number; model_conflicts: string[]; cached: boolean }
}

export interface RuntimeConfig {
  api_key: string
  base_url: string
  model: string
  max_tokens: number
  mock_generation: boolean
  voice_mode: string
}

// ------------------------------------------------------------------ 端点

export const api = {
  config: () => get<RuntimeConfig>('/api/config'),
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

  reportSummary: (id: string, refresh = false) =>
    get<ReportSummary>(`/api/emr/report-summary/${id}${refresh ? '?refresh=true' : ''}`),
  generateRecordAuto: (body: Record<string, unknown>) =>
    post<{ fields: Record<string, string>; provider: string; degraded: boolean }>('/api/emr/generate-record-auto', body),
  generateRecordField: (patientId: string, field: string, noteText: string) =>
    post<{ field: string; generated_text: string; provider: string; degraded: boolean }>(
      '/api/emr/generate-record-field',
      { patient_id: patientId, field, note_text: noteText },
    ),

  voiceInit: (id: string) =>
    get<{ greeting: string; patient_name: string; chief_complaint: string; diagnoses: unknown[] }>(
      `/api/emr/voice/init/${id}`,
    ),
  voiceComplete: (body: Record<string, unknown>) => post<Record<string, unknown>>('/api/emr/voice/complete', body),
  voiceHistory: (id: string) =>
    get<{ patient_id: string; sessions: { ended_at: string; summary: string; messages: unknown[] }[] }>(
      `/api/emr/voice/history/${id}`,
    ),

  // V4.3 把 33 项专项评估硬编码在打包产物里；改由后端提供以满足「前端零写死数据」
  assessmentCatalog: () =>
    get<{ note: string; categories: { name: string; count: number; items: { name: string; level: string; desc: string }[] }[] }>(
      '/api/emr/assessment-catalog',
    ),

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
