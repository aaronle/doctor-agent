<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useWorkspaceStore } from '../stores/workspace'
import type { Patient } from '../types'
import VoiceRecorderMock from './features/VoiceRecorderMock.vue'

const props = defineProps<{ patient: Patient | null; patients: Patient[] }>()
const emit = defineEmits<{ bind: [patient: Patient]; next: [] }>()
const store = useWorkspaceStore()
const voiceSessionActive = ref(false)
const voiceGenerationState = ref<'idle' | 'generating' | 'ready' | 'failed'>('idle')

const skills = computed(() => {
  const specialty = props.patient?.specialty || ''
  if (specialty.includes('骨科')) return ['疼痛与功能评估', '红旗征象筛查', '影像结果解读', '围手术期用药审核', '多病共存管理']
  if (specialty.includes('妇科')) return ['异常出血评估', '妊娠风险筛查', '贫血风险评估', '用药审核优化', '多病共存管理']
  return ['血糖控制评估', '高血压复诊套餐', '并发症风险筛查', '用药审核优化', '多病共存管理']
})

watch(() => props.patient?.patient_id, () => {
  voiceSessionActive.value = false
  voiceGenerationState.value = 'idle'
})

function openPanel(panel: 'analysis' | 'treatment') {
  store.workspacePanel = panel
}

function startVoiceInterview() {
  store.workspacePanel = 'analysis'
  voiceSessionActive.value = true
}

function handleVoiceStart() {
  voiceGenerationState.value = 'idle'
  store.setSupplementalObservations([])
  delete store.tasks.voice_interview
  delete store.tasks.record_generation
  delete store.taskErrors.voice_interview
  delete store.taskErrors.record_generation
}

function handleSupplementalObservation(text: string) {
  store.addSupplementalObservation(text)
}

async function handleVoiceComplete(observations: string[]) {
  voiceGenerationState.value = 'generating'
  store.setSupplementalObservations(observations)
  await store.runTask('voice_interview')
  await store.runTask('record_generation')
  voiceGenerationState.value = store.tasks.voice_interview?.result && store.tasks.record_generation?.result ? 'ready' : 'failed'
}

function handleVoiceReset() {
  voiceGenerationState.value = 'idle'
  delete store.tasks.voice_interview
  delete store.tasks.record_generation
  delete store.taskErrors.voice_interview
  delete store.taskErrors.record_generation
}
</script>

<template>
  <aside class="doctor-sidebar" :class="{ 'voice-session-active': voiceSessionActive }">
    <div class="panel-title"><span class="status-dot"></span> 医生智能体 <span class="panel-close">×　×</span></div>
    <div class="doctor-context">
      <strong>{{ patient ? `${patient.name} · ${patient.gender} · ${patient.age}岁` : '未选择患者' }}</strong>
    </div>
    <div class="assistant-body" :class="{ 'voice-session-body': voiceSessionActive }">
      <VoiceRecorderMock
        v-if="patient && voiceSessionActive"
        :key="patient.patient_id"
        :patient="patient"
        compact
        autostart
        :generation-state="voiceGenerationState"
        @start="handleVoiceStart"
        @observation="handleSupplementalObservation"
        @complete="handleVoiceComplete"
        @reset="handleVoiceReset"
      />
      <template v-else-if="patient">
        <div class="assistant-label">本科常用 Skill</div>
        <div class="skill-shortcuts">
          <button v-for="(skill, index) in skills" :key="skill"><b>{{ ['🩸', '💊', '🔍', '✅', '📋'][index] }}</b>{{ skill }}</button>
        </div>
      </template>
      <div v-else class="assistant-message">登录后已直接进入医生智能体。请从下方患者入口开始接诊。</div>
      <div v-if="!patient" class="patient-shortcuts">
        <button v-for="item in patients" :key="item.patient_id" @click="emit('bind', item)">
          <span>{{ item.name }}</span><small>{{ item.specialty }}</small>
        </button>
      </div>
    </div>
    <div class="assistant-composer">
      <button v-if="patient && !voiceSessionActive" class="voice-entry" @click="startVoiceInterview">● 语音问诊</button>
      <textarea :placeholder="patient ? '发消息或补充内容…' : '输入姓名或就诊号查找患者…'"></textarea>
      <div class="composer-footer"><button>＋</button><span><button>🎤</button><button class="send">↑</button></span></div>
      <div class="quick-actions">
        <button @click="emit('next')">接诊下一位</button>
        <button @click="openPanel('treatment')">报告解读</button>
        <button @click="openPanel('analysis')">鉴别诊断</button>
      </div>
    </div>
  </aside>
</template>
