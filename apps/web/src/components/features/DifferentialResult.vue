<script setup lang="ts">
import { computed, reactive, watch } from 'vue'

const props = defineProps<{ content: Record<string, any> }>()
const emit = defineEmits<{ 'risk-alert': [riskLinks: string[]] }>()
const candidates = reactive<any[]>([])
const confirmed = computed(() => candidates.some((item) => item.confirmed))
const selectedCount = computed(() => candidates.filter((item) => item.selected).length)

watch(
  () => props.content,
  (content) => {
    candidates.splice(
      0,
      candidates.length,
      ...(content.candidates || []).map((item: any, index: number) => ({
        ...item,
        selected: index === 0,
        expanded: false,
        confirmed: false,
      })),
    )
  },
  { immediate: true, deep: true },
)

function rankLabel(candidate: any, index: number) {
  if (candidate.priority === 'must_not_miss') return '不能漏诊'
  return ['首选', '备选', '次选'][index] || '其他'
}

function diagnosisCode(candidate: any) {
  return candidate.icd_candidates?.[0]?.code || '待匹配'
}

function confidence(candidate: any, index: number) {
  return Math.round((candidate.confidence ?? Math.max(0.62, 0.92 - index * 0.09)) * 100)
}

function confirmSelection() {
  candidates.forEach((item) => (item.confirmed = item.selected))
}
</script>

<template>
  <div class="differential-list">
    <header class="differential-title-row">
      <input
        type="checkbox"
        :checked="selectedCount === candidates.length && candidates.length > 0"
        aria-label="全选诊断"
        @change="candidates.forEach((item) => (item.selected = ($event.target as HTMLInputElement).checked))"
      />
      <strong>鉴别诊断</strong>
      <button v-if="!confirmed" :disabled="!selectedCount" @click="confirmSelection">确认诊断</button>
      <span v-else class="confirmed-tag">已确认</span>
    </header>
    <article
      v-for="(candidate, index) in candidates"
      :key="candidate.candidate_id"
      class="diagnosis-candidate"
      :class="[{ selected: candidate.selected, confirmed: candidate.confirmed }, candidate.priority]"
    >
      <div class="diagnosis-card-main">
        <input v-model="candidate.selected" type="checkbox" :disabled="confirmed" :aria-label="`选择${candidate.name}`" />
        <div class="diagnosis-card-body">
          <header>
            <span :class="{ 'is-danger': candidate.priority === 'must_not_miss' }">{{ rankLabel(candidate, index) }}</span>
            <strong>{{ candidate.name }}</strong>
            <em>{{ diagnosisCode(candidate) }}</em>
            <b>{{ confidence(candidate, index) }}%</b>
          </header>
          <p>{{ candidate.supporting_evidence.map((item: any) => item.text).join('；') }}。{{ candidate.next_steps?.[0] || '' }}</p>
          <button class="differential-toggle" @click="candidate.expanded = !candidate.expanded">
            需鉴别（{{ candidate.opposing_evidence.length + candidate.missing_information.length }}）<span>{{ candidate.expanded ? '⌄' : '›' }}</span>
          </button>
          <div v-if="candidate.expanded" class="differential-details">
            <p><b>反对依据：</b>{{ candidate.opposing_evidence.join('；') }}</p>
            <p><b>还需补充：</b>{{ candidate.missing_information.join('；') || '暂无阻断性缺失' }}</p>
            <p>{{ candidate.uncertainty }}</p>
          </div>
          <button
            v-if="candidate.priority === 'must_not_miss' || candidate.risk_links?.length"
            class="differential-risk-link"
            type="button"
            @click="emit('risk-alert', candidate.risk_links || [])"
          >
            <i></i><span>风险预警</span><small>{{ candidate.risk_links?.length || 1 }} 项关联风险</small><b>查看详细 ›</b>
          </button>
        </div>
      </div>
    </article>
  </div>
</template>
