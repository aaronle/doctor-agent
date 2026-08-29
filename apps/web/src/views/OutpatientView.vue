<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

import AgentWorkspace from '../components/AgentWorkspace.vue'
import DoctorSidebar from '../components/DoctorSidebar.vue'
import PatientRecord from '../components/PatientRecord.vue'
import { useWorkspaceStore } from '../stores/workspace'
import type { Patient } from '../types'

const router = useRouter()
const store = useWorkspaceStore()
const doctor = computed(() => JSON.parse(sessionStorage.getItem('doctor_agent_doctor') || '{"name":"张医生"}'))

onMounted(() => {
  // Pinia state belongs to the current browser tab. A copied/direct workstation
  // URL therefore cannot safely assume that a patient has already been bound.
  if (!store.patient) {
    router.replace('/outpatient/list')
    return
  }
  if (!store.patients.length) store.loadPatients()
})

function bind(patient: Patient) {
  store.bindPatient(patient)
}

function nextPatient() {
  if (!store.patients.length) return
  const current = store.patient ? store.patients.findIndex((item) => item.patient_id === store.patient?.patient_id) : -1
  store.bindPatient(store.patients[(current + 1) % store.patients.length])
}

function switchPatient() {
  store.clearPatient()
  router.replace('/outpatient/list')
}

</script>

<template>
  <div class="outpatient-page">
    <header class="app-header">
      <div><span class="back-link" @click="router.replace('/outpatient/list')">‹ 候诊列表</span><b class="app-icon">✚</b><strong>门诊工作站</strong></div>
      <span class="doctor-name">{{ doctor.name }}</span>
    </header>
    <div class="patient-safety-bar">
      <template v-if="store.patient">
        <strong>{{ store.patient.name }}</strong><span>{{ store.patient.gender }}</span><span>{{ store.patient.age }}岁</span><span>科室 {{ store.patient.specialty }}</span><span>主治 {{ doctor.name }}</span><span>就诊 2026-08-28</span><span>过敏 {{ store.patient.allergy }}</span>
        <button @click="switchPatient">切换患者</button>
      </template>
      <template v-else><strong>未选择患者</strong><span>临床智能体调用已禁用，请在医生智能体中绑定患者</span></template>
    </div>
    <div class="workstation-grid">
      <PatientRecord :patient="store.patient" />
      <AgentWorkspace />
      <DoctorSidebar :patient="store.patient" :patients="store.patients" @bind="bind" @next="nextPatient" />
    </div>
  </div>
</template>
