export type TaskType =
  | 'voice_interview'
  | 'condition_summary'
  | 'record_generation'
  | 'differential_diagnosis'
  | 'diagnosis_management'
  | 'risk_management'
  | 'comorbidity_management'

export type WorkspacePanel =
  | 'analysis'
  | 'risk'
  | 'record'
  | 'diagnosis'
  | 'treatment'
  | 'comorbidity'
  | 'archive'
  | 'timeline'
  | 'voice'

export type MockScenario =
  | 'success'
  | 'clarification_required'
  | 'data_conflict'
  | 'degraded_result'
  | 'runtime_failure'
  | 'invalid_schema'

export interface Patient {
  fixture_id: string
  specialty: string
  scenario: string
  patient_id: string
  encounter_id: string
  name: string
  gender: string
  age: number
  chief_complaint: string
  allergy: string
  facts: Record<string, unknown>
}

export interface TaskEvent {
  sequence: number
  status: 'ready' | 'degraded' | 'needs_clarification'
  code: string
  message: string
}

export interface SemanticResult {
  task_id: string
  task_type: TaskType
  result_type: string
  status: string
  subject: { patient_id: string; encounter_id: string }
  generated_at: string
  data_cutoff_at: string
  runtime: { mode: string; agent_id: string; agent_version: string }
  content: Record<string, any>
  evidence_refs: Array<Record<string, any>>
  missing_data: string[]
  conflicts: string[]
  safety: { severity: string; requires_acknowledgement: boolean; blocking: boolean }
  allowed_actions: string[]
  trace_id: string
}

export interface CardViewModel {
  card_id: string
  task_id: string
  component: string
  title: string
  status: string
  badges: Array<{ type: string; label: string; level?: string }>
  meta: Record<string, string>
  sections: Array<{ key: string; title: string; kind: string; value: any }>
  evidence_actions: Array<Record<string, any>>
  primary_actions: string[]
  secondary_actions: string[]
}

export interface AgentTask {
  task_id: string
  status: string
  event_url: string
  result_version: number
  result: SemanticResult | null
  card: CardViewModel | null
  events?: TaskEvent[]
}
