<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { AgentTask } from '../../types'

const props = defineProps<{ task?: AgentTask; error?: string }>()
const emit = defineEmits<{ action: [action: string] }>()
const result = computed(() => props.task?.result)
const expandedRiskId = ref('')
const isBusy = computed(
  () => props.task && !['ready', 'degraded', 'needs_clarification', 'failed', 'cancelled'].includes(props.task.status),
)

function severityLabel(severity: string) {
  return severity === 'critical' ? '红色·紧急' : severity === 'warning' ? '黄色·中度' : '蓝色·提示'
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    new: '待处理', acknowledged: '已阅', action_in_progress: '处置中', resolved: '已解决',
    dismissed_with_reason: '有因忽略', false_positive: '误报', expired: '已过期',
  }
  return labels[status] || status
}

watch(
  () => props.task?.task_id,
  () => { expandedRiskId.value = '' },
)

function toggleDetail(riskId: string) {
  expandedRiskId.value = expandedRiskId.value === riskId ? '' : riskId
}
</script>

<template>
  <div v-if="error" class="state-card error-state"><strong>风险预警暂未完成</strong><span>{{ error }}</span></div>
  <div v-else-if="isBusy || !result" class="state-card loading-state"><span class="spinner"></span><strong>正在生成风险预警</strong></div>
  <section v-else class="risk-reminder-panel">
    <header class="risk-reminder-heading">
      <strong>风险提示</strong>
      <span>红色必须处置并阻断；黄色需处理或留痕</span>
    </header>
    <article v-for="risk in result.content.alerts" :key="risk.risk_id" class="risk-reminder-item" :class="risk.severity">
      <header>
        <strong><i></i>{{ risk.title }}</strong>
        <span class="risk-level">{{ severityLabel(risk.severity) }}</span>
        <button
          class="risk-advice-link"
          type="button"
          :aria-expanded="expandedRiskId === risk.risk_id"
          @click="toggleDetail(risk.risk_id)"
        >{{ expandedRiskId === risk.risk_id ? '收起详细' : '查看详细' }} {{ expandedRiskId === risk.risk_id ? '⌃' : '›' }}</button>
      </header>
      <p>{{ risk.evidence.join('；') }}</p>
      <div class="risk-meta"><span>状态：{{ statusLabel(risk.status) }}</span><span>时限：{{ risk.due_label || (risk.severity === 'critical' ? '立即' : '本次就诊内') }}</span></div>
      <p class="risk-suggestion"><b>建议：</b>{{ risk.recommended_action }}</p>
      <section v-if="expandedRiskId === risk.risk_id" class="risk-detail-panel" aria-label="风险详细信息">
        <div><b>风险分类</b><span>{{ risk.category || '专病与诊疗安全' }}</span></div>
        <div><b>影响与门禁</b><span>{{ risk.impact || (risk.severity === 'critical' ? '未闭环前阻断病历与诊断关键提交' : '提交前须处理、确认已阅或有因留痕') }}</span></div>
        <div><b>关键证据</b><span>{{ risk.evidence.join('；') || '暂无可用证据，需医生人工核验' }}</span></div>
        <div><b>来源与时间</b><span>{{ risk.source || '风险管理智能体' }}；数据截止 {{ result?.data_cutoff_at || '待同步' }}</span></div>
        <div><b>阈值/判定</b><span>{{ risk.threshold || '组合风险判定，阈值规则待医院确认' }}</span></div>
        <div><b>反证与不确定性</b><span>{{ risk.uncertainty || '仍需结合原始病历、检验检查和专科查体复核' }}</span></div>
        <div><b>关联专项评估</b><span>{{ risk.assessment_refs?.join('；') || '专病风险评估' }}</span></div>
        <div><b>关联 Skills</b><span>{{ risk.skill_refs?.join('；') || '并发症风险筛查；用药审核优化' }}</span></div>
        <p class="risk-authority-note">专项评估可以发现或关联风险；确认、处置、解决和有因忽略只在“风险预警”中维护并审计。</p>
      </section>
      <footer>
        <button @click="emit('action', 'acknowledge')">确认已阅</button>
        <button class="primary" @click="emit('action', 'start_action')">记录处置</button>
      </footer>
    </article>
  </section>
</template>
