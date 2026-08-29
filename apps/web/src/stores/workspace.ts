import { defineStore } from 'pinia'

import { createAgentTask, listPatients, submitAction, submitMockWriteBack, waitForTask } from '../api'
import type { AgentTask, MockScenario, Patient, TaskType, WorkspacePanel } from '../types'

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    patients: [] as Patient[],
    patient: null as Patient | null,
    tasks: {} as Partial<Record<TaskType, AgentTask>>,
    taskErrors: {} as Partial<Record<TaskType, string>>,
    loadingPatients: false,
    contextVersion: 1,
    workspacePanel: 'analysis' as WorkspacePanel,
    writeBackReceipts: {} as Partial<Record<TaskType, string>>,
    supplementalObservations: [] as string[],
  }),
  actions: {
    async loadPatients() {
      this.loadingPatients = true
      try {
        this.patients = await listPatients()
      } finally {
        this.loadingPatients = false
      }
    },
    bindPatient(patient: Patient) {
      this.patient = patient
      this.tasks = {}
      this.taskErrors = {}
      this.writeBackReceipts = {}
      this.supplementalObservations = []
      this.contextVersion += 1
      this.workspacePanel = 'analysis'
    },
    clearPatient() {
      this.patient = null
      this.tasks = {}
      this.taskErrors = {}
      this.writeBackReceipts = {}
      this.supplementalObservations = []
      this.contextVersion += 1
    },
    async runTask(taskType: TaskType, scenario: MockScenario = 'success') {
      if (!this.patient) {
        this.taskErrors[taskType] = '请先绑定患者与本次就诊'
        return
      }
      const patientAtStart = this.patient
      this.contextVersion += 1
      this.taskErrors[taskType] = ''
      try {
        const created = await createAgentTask(
          patientAtStart,
          taskType,
          this.contextVersion,
          scenario,
          this.supplementalObservations,
        )
        this.tasks[taskType] = created
        const finished = await waitForTask(created.task_id, patientAtStart.patient_id)
        if (this.patient?.patient_id !== patientAtStart.patient_id) return
        this.tasks[taskType] = finished
      } catch (error) {
        if (this.patient?.patient_id !== patientAtStart.patient_id) return
        this.taskErrors[taskType] = error instanceof Error ? error.message : '任务执行失败'
      }
    },
    setSupplementalObservations(items: string[]) {
      this.supplementalObservations = [...new Set(items)]
      this.contextVersion += 1
    },
    addSupplementalObservation(item: string) {
      if (this.supplementalObservations.includes(item)) return
      this.supplementalObservations.push(item)
      this.contextVersion += 1
    },
    async action(taskType: TaskType, action: string, note?: string) {
      const task = this.tasks[taskType]
      if (!task) return
      const receipt = await submitAction(task, action, note)
      task.result_version = receipt.result_version
      if (taskType === 'risk_management' || action === 'resolve' || action === 'acknowledge') {
        await this.refreshTask(taskType)
      }
    },
    async refreshTask(taskType: TaskType) {
      const current = this.tasks[taskType]
      if (!current || !this.patient) return
      const finished = await waitForTask(current.task_id, this.patient.patient_id)
      this.tasks[taskType] = finished
    },
    async writeBack(taskType: 'record_generation' | 'diagnosis_management') {
      const task = this.tasks[taskType]
      if (!task) return
      try {
        const receipt = await submitMockWriteBack(
          task,
          taskType === 'record_generation' ? 'record' : 'diagnosis',
        )
        this.writeBackReceipts[taskType] = `已生成确认单 · ${receipt.receipt_id}`
      } catch (error) {
        this.taskErrors[taskType] = error instanceof Error ? error.message : '写回确认单生成失败'
      }
    },
  },
})
