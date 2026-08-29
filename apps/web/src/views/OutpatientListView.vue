<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useWorkspaceStore } from '../stores/workspace'

const router = useRouter()
const store = useWorkspaceStore()

const keyword = ref('')

onMounted(() => {
  if (!store.patients.length) store.loadPatients()
})

const doctor = computed(() => JSON.parse(sessionStorage.getItem('doctor_agent_doctor') || '{"name":"张医生"}'))

const filteredPatients = computed(() => {
  const word = keyword.value.trim()
  if (!word) return store.patients
  const lowered = word.toLowerCase()
  return store.patients.filter((item) => {
    return (
      item.name.toLowerCase().includes(lowered)
      || item.patient_id.toLowerCase().includes(lowered)
      || item.specialty.toLowerCase().includes(lowered)
      || item.encounter_id.toLowerCase().includes(lowered)
    )
  })
})

function openPatient() {
  if (!store.patient) return
  router.replace('/outpatient')
}

function open(patient: (typeof store.patients)[number]) {
  store.bindPatient(patient)
  openPatient()
}

</script>

<template>
  <section class="patient-list-page">
    <header class="app-header">
      <div><b class="app-icon">✚</b><strong>门诊工作站 · 候诊列表</strong></div>
      <span class="doctor-name">{{ doctor.name }}</span>
    </header>
    <div class="patient-list-toolbar">
      <label for="keyword">患者筛选</label>
      <input
        id="keyword"
        v-model.trim="keyword"
        placeholder="输入姓名 / 科室 / 就诊号"
      />
      <span>共 {{ filteredPatients.length }} 位患者</span>
      <button class="primary-action" @click="openPatient" :disabled="!store.patient">
        继续当前患者
      </button>
    </div>
    <div class="patient-list-body">
      <template v-if="filteredPatients.length">
        <article
          v-for="patient in filteredPatients"
          :key="patient.patient_id"
          class="patient-list-card"
          role="button"
          tabindex="0"
          @click="open(patient)"
          @keyup.enter="open(patient)"
        >
          <div class="patient-main">
            <h3>{{ patient.name }} <span>{{ patient.gender }} · {{ patient.age }}岁</span></h3>
            <p>就诊号：{{ patient.encounter_id }} ｜ 患者ID：{{ patient.patient_id }}</p>
            <p>科室：{{ patient.specialty }}</p>
            <p>主诉：{{ patient.chief_complaint }}</p>
          </div>
          <div class="patient-actions">
            <span class="patient-tag">病例类型：{{ patient.scenario }}</span>
            <button class="primary-action" @click.stop="open(patient)">进入医生智能体</button>
          </div>
        </article>
      </template>
      <div v-else class="patient-empty">未找到符合条件的患者</div>
    </div>
  </section>
</template>
