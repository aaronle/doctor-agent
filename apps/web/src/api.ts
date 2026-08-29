import type { AgentTask, MockScenario, Patient, TaskType } from './types'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

function token() {
  return sessionStorage.getItem('doctor_agent_token') || ''
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  if (token()) headers.set('Authorization', `Bearer ${token()}`)
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: '服务暂时不可用' }))
    throw new Error(body.detail || '服务暂时不可用')
  }
  return response.json() as Promise<T>
}

export async function login(username: string, password: string) {
  return request<{ access_token: string; doctor: Record<string, string>; runtime_mode: string }>(
    '/api/v1/auth/login',
    { method: 'POST', body: JSON.stringify({ username, password }) },
  )
}

export async function listPatients() {
  const body = await request<{ patients: Patient[] }>('/api/v1/patients')
  return body.patients
}

const RESULT_TYPES: Record<TaskType, string> = {
  voice_interview: 'interview_note',
  condition_summary: 'condition_summary',
  record_generation: 'record_draft',
  differential_diagnosis: 'diagnosis_candidates',
  diagnosis_management: 'diagnosis_management',
  risk_management: 'risk_alert',
  comorbidity_management: 'comorbidity_plan',
}

export async function createAgentTask(
  patient: Patient,
  taskType: TaskType,
  contextVersion: number,
  scenario: MockScenario,
  supplementalObservations: string[] = [],
) {
  const nonce = crypto.randomUUID()
  const now = new Date().toISOString()
  return request<AgentTask>('/api/v1/agent-tasks', {
    method: 'POST',
    body: JSON.stringify({
      schema_version: 'task_request_v1',
      request_id: `req_${nonce}`,
      // Each explicit UI invocation is a new logical task. The nonce prevents a
      // prior local-demo result from being reused after code/data changes.
      idempotency_key: `${patient.encounter_id}:${taskType}:${scenario}:context_v${contextVersion}:${nonce}`,
      task_type: taskType,
      runtime_mode: 'mock',
      actor: {
        user_id: 'doctor_001',
        role: 'outpatient_doctor',
        organization_id: 'pkuih',
        department_id: patient.specialty,
      },
      subject: { patient_id: patient.patient_id, encounter_id: patient.encounter_id },
      trigger: { source: 'user_action', event: `run_${taskType}`, occurred_at: now },
      context_ref: { context_version: `context_v${contextVersion}`, data_cutoff_at: now },
      interaction_context: {
        supplemental_observations: supplementalObservations.map((text, index) => ({
          observation_id: `OBS-${index + 1}`,
          text,
          source: 'doctor_selected',
          occurred_at: now,
        })),
      },
      expected_result_type: RESULT_TYPES[taskType],
      locale: 'zh-CN',
      trace_id: `trace_${nonce}`,
    }),
    headers: { 'X-Mock-Scenario': scenario },
  })
}

export function getTask(taskId: string) {
  return request<AgentTask>(`/api/v1/agent-tasks/${taskId}`)
}

export async function waitForTask(taskId: string, currentPatientId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const task = await getTask(taskId)
    if (task.result && task.result.subject.patient_id !== currentPatientId) {
      throw new Error('任务结果患者身份不匹配，已拒绝展示')
    }
    if (['ready', 'degraded', 'needs_clarification', 'failed', 'cancelled'].includes(task.status)) return task
    await new Promise((resolve) => window.setTimeout(resolve, 150))
  }
  throw new Error('任务等待超时，请稍后重试')
}

export function submitAction(task: AgentTask, action: string, note?: string) {
  return request<{ status: string; audit_event_id: string; result_version: number }>(
    `/api/v1/agent-tasks/${task.task_id}/actions`,
    {
      method: 'POST',
      body: JSON.stringify({
        schema_version: 'agent_result_action_v1',
        result_version: task.result_version,
        action,
        note,
        reason_code: ['reject', 'report_error', 'false_positive', 'dismiss_with_reason'].includes(action)
          ? 'doctor_review'
          : null,
      }),
    },
  )
}

export function submitMockWriteBack(task: AgentTask, target: 'record' | 'diagnosis') {
  return request<{ receipt_id: string; mode: 'mock'; status: 'simulated'; occurred_at: string }>(
    '/api/v1/write-back-requests',
    {
      method: 'POST',
      body: JSON.stringify({
        task_id: task.task_id,
        result_version: task.result_version,
        idempotency_key: `writeback:${task.task_id}:v${task.result_version}`,
        target,
        confirmed_by_doctor: true,
      }),
    },
  )
}
