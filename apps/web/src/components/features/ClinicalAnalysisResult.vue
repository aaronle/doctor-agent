<script setup lang="ts">
import { computed } from 'vue'

import type { AgentTask } from '../../types'
import DifferentialResult from './DifferentialResult.vue'
import SpecialtyAssessmentPanel from './SpecialtyAssessmentPanel.vue'

const props = defineProps<{
  summaryTask?: AgentTask
  differentialTask?: AgentTask
  recordTask?: AgentTask
  summaryError?: string
  differentialError?: string
  recordError?: string
}>()
const emit = defineEmits<{ 'risk-alert': [riskLinks: string[]] }>()

const summary = computed(() => props.summaryTask?.result?.content)
const differential = computed(() => props.differentialTask?.result?.content)
const record = computed(() => props.recordTask?.result?.content)
const isBusy = computed(() => {
  const statuses = [props.summaryTask?.status, props.differentialTask?.status].filter(Boolean)
  return statuses.some((status) => !['ready', 'degraded', 'needs_clarification', 'failed', 'cancelled'].includes(status!))
})
</script>

<template>
  <div v-if="summaryError || differentialError || recordError" class="state-card error-state">
    <strong>分析暂未完成</strong>
    <span>{{ summaryError || differentialError || recordError }}</span>
  </div>
  <div v-else-if="isBusy || !summary || !differential" class="state-card loading-state">
    <span class="spinner"></span>
    <strong>正在生成智慧诊疗建议</strong>
    <span>病情概况与鉴别诊断正在同步分析。</span>
  </div>
  <div v-else class="clinical-analysis">
    <div class="analysis-left-stack">
      <section class="condition-overview-card">
        <header>AI病情概要</header>
        <p>{{ summary.summary }}</p>
      </section>
      <section class="differential-section">
        <DifferentialResult
          :key="differentialTask?.task_id"
          :content="differential"
          @risk-alert="emit('risk-alert', $event)"
        />
      </section>
    </div>
    <div class="analysis-right-stack">
      <section class="smart-note-panel">
        <header><strong>病历</strong><span>智能笔记</span></header>
        <div class="note-search"><input placeholder="输入关键词，检索语音就诊内容" /><button>检</button></div>
        <template v-if="record">
          <label v-for="section in record.sections" :key="section.section_id">
            <span>{{ section.title }}</span>
            <textarea :value="section.ai_text" :placeholder="`自动生成${section.title}`"></textarea>
            <button title="回写到左侧病历">回</button>
          </label>
        </template>
        <div v-else class="smart-note-waiting">
          <span>🎙</span>
          <strong>等待语音问诊</strong>
          <p>结束语音接诊后，病历草稿将自动生成。</p>
        </div>
      </section>
      <SpecialtyAssessmentPanel />
    </div>
  </div>
</template>
