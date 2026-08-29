import { createPinia, setActivePinia } from 'pinia'

import type { AgentTask, Patient } from '../types'
import { useWorkspaceStore } from './workspace'

const patient: Patient = {
  fixture_id: 'IM-001',
  specialty: '内科-内分泌代谢',
  scenario: '糖尿病复诊',
  patient_id: 'MOCK-IM-001',
  encounter_id: 'ENC-IM-001',
  name: '王某某',
  gender: '女',
  age: 58,
  chief_complaint: '血糖控制不佳',
  allergy: '无',
  facts: {},
}

describe('workspace patient isolation', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('clears visible AI results whenever patient context changes', () => {
    const store = useWorkspaceStore()
    store.bindPatient(patient)
    store.tasks.condition_summary = { task_id: 'old-task' } as AgentTask
    store.bindPatient({ ...patient, patient_id: 'MOCK-IM-002', encounter_id: 'ENC-IM-002' })
    expect(store.tasks).toEqual({})
    expect(store.patient?.patient_id).toBe('MOCK-IM-002')
  })

  it('does not retain results after returning to unbound state', () => {
    const store = useWorkspaceStore()
    store.bindPatient(patient)
    store.tasks.risk_management = { task_id: 'risk-task' } as AgentTask
    store.clearPatient()
    expect(store.patient).toBeNull()
    expect(store.tasks).toEqual({})
  })
})
