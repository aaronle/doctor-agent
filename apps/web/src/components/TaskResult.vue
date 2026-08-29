<script setup lang="ts">
import { computed } from 'vue'

import type { AgentTask, TaskType } from '../types'
import ComorbidityResult from './features/ComorbidityResult.vue'
import DiagnosisManagementResult from './features/DiagnosisManagementResult.vue'
import DifferentialResult from './features/DifferentialResult.vue'
import RecordDraftResult from './features/RecordDraftResult.vue'
import VoiceInterviewResult from './features/VoiceInterviewResult.vue'

const props = defineProps<{ taskType: TaskType; task?: AgentTask; error?: string; receipt?: string }>()
const emit = defineEmits<{ action: [action: string]; writeback: [] }>()

const isBusy = computed(
  () => props.task && !['ready', 'degraded', 'needs_clarification', 'failed', 'cancelled'].includes(props.task.status),
)
const result = computed(() => props.task?.result)

function actionLabel(action: string) {
  return (
    {
      accept: '采纳到草稿',
      partial_accept: '部分采纳',
      edit: '编辑',
      reject: '拒绝',
      report_error: '报告问题',
      retry: '重新运行',
      acknowledge: '确认已阅',
      start_action: '记录处置',
      resolve: '标记已解决',
      false_positive: '标记误报',
      dismiss_with_reason: '有因忽略',
    } as Record<string, string>
  )[action] || action
}

function riskStatusLabel(status: string) {
  return (
    {
      new: '待处理',
      acknowledged: '已阅',
      action_in_progress: '处置中',
      resolved: '已解决',
      false_positive: '误报',
      dismissed_with_reason: '有因忽略',
    } as Record<string, string>
  )[status] || status
}
</script>

<template>
  <div v-if="error" class="state-card error-state"><strong>任务未完成</strong><span>{{ error }}</span></div>
  <div v-else-if="isBusy" class="state-card loading-state">
    <span class="spinner"></span><strong>智能体正在执行</strong><span>正在准备上下文并校验结果，医生可继续编辑左侧病历。</span>
  </div>
  <div v-else-if="task?.status === 'failed'" class="state-card error-state">
    <strong>智能体暂时不可用</strong><span>未展示任何未经校验的临床内容，请重试或继续人工处理。</span>
    <button class="primary" @click="emit('action', 'retry')">重新运行</button>
  </div>
  <article v-else-if="task?.status === 'needs_clarification' && result" class="result-card clarification-card">
    <header class="result-card-head"><div><strong>需要补充信息</strong><span class="badge yellow">阻断性澄清</span></div></header>
    <p>{{ result.content.reason }}</p>
    <label v-for="question in result.content.questions" :key="question.question_id"><span>{{ question.blocking ? '必答' : '建议' }}</span><strong>{{ question.text }}</strong><input placeholder="输入补充内容" /></label>
    <footer class="result-actions"><button class="primary" @click="emit('action', 'retry')">补充后重新运行</button></footer>
  </article>
  <article v-else-if="result && task?.card" class="result-card">
    <header class="result-card-head">
      <div><strong>{{ task.card.title }}</strong><span v-for="badge in task.card.badges" :key="badge.label" class="badge" :class="badge.level">{{ badge.label }}</span></div>
      <small>数据截至 {{ new Date(result.data_cutoff_at).toLocaleString('zh-CN') }}</small>
    </header>

    <template v-if="result.result_type === 'condition_summary'">
      <p class="summary-copy">{{ result.content.summary }}</p>
      <div class="content-block"><h4>主要问题</h4><ul><li v-for="item in result.content.problems" :key="item">{{ item }}</li></ul></div>
      <div v-if="result.content.timeline_changes?.length" class="content-block"><h4>变化与趋势</h4><ul><li v-for="item in result.content.timeline_changes" :key="item">{{ item }}</li></ul></div>
    </template>

    <template v-else-if="result.result_type === 'risk_alert'">
      <div v-for="risk in result.content.alerts" :key="risk.risk_id" class="risk-item" :class="risk.severity">
        <div class="risk-line"><strong>{{ risk.severity === 'critical' ? '● 红色风险' : risk.severity === 'warning' ? '● 黄色风险' : '● 信息提示' }}</strong><span>{{ riskStatusLabel(risk.status) }}</span></div>
        <h4>{{ risk.title }}</h4><p>依据：{{ risk.evidence.join('；') }}</p><p>建议：{{ risk.recommended_action }}</p>
      </div>
    </template>

    <VoiceInterviewResult v-else-if="result.result_type === 'interview_note'" :key="task?.task_id" :content="result.content" />
    <RecordDraftResult v-else-if="result.result_type === 'record_draft'" :key="task?.task_id" :content="result.content" :receipt="receipt" @writeback="emit('writeback')" />
    <DifferentialResult v-else-if="result.result_type === 'diagnosis_candidates'" :key="task?.task_id" :content="result.content" />
    <DiagnosisManagementResult v-else-if="result.result_type === 'diagnosis_management'" :key="task?.task_id" :content="result.content" :receipt="receipt" @writeback="emit('writeback')" />
    <ComorbidityResult v-else-if="result.result_type === 'comorbidity_plan'" :key="task?.task_id" :content="result.content" />

    <template v-else>
      <pre class="structured-result">{{ JSON.stringify(result.content, null, 2) }}</pre>
    </template>

    <div v-if="result.conflicts.length || result.missing_data.length" class="data-quality">
      <p v-if="result.conflicts.length"><strong>数据冲突：</strong>{{ result.conflicts.join('；') }}</p>
      <p v-if="result.missing_data.length"><strong>资料缺失：</strong>{{ result.missing_data.join('；') }}</p>
    </div>
    <footer v-if="['condition_summary', 'risk_alert'].includes(result.result_type)" class="result-actions">
      <button v-for="action in result.allowed_actions" :key="action" :class="{ primary: ['accept', 'acknowledge', 'resolve'].includes(action) }" @click="emit('action', action)">{{ actionLabel(action) }}</button>
    </footer>
    <div class="trace-line">AI 生成 · {{ result.runtime.agent_version }} · 结果仅供医生复核</div>
  </article>
</template>
