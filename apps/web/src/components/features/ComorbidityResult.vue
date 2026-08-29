<script setup lang="ts">
import { reactive } from 'vue'

const props = defineProps<{ content: Record<string, any> }>()
const conditions = reactive(props.content.conditions.map((item: any) => ({ ...item, action_state: '' })))

function groupLabel(group: string) {
  return ({ current_relevant: '与本次相关', needs_verification: '待核实', stable_history: '稳定/历史' } as Record<string, string>)[group] || '与本次相关'
}
</script>

<template>
  <div class="comorbidity-grid">
    <article v-for="item in conditions" :key="item.problem_id" class="comorbidity-card">
      <header><span>{{ groupLabel(item.group) }}</span><strong>{{ item.name }}</strong><em>{{ item.control_status }}</em></header>
      <p><b>为什么现在相关：</b>{{ item.relevance }}</p>
      <p><b>管理缺口：</b>{{ item.care_gaps.join('；') }}</p>
      <p v-if="item.interactions.length"><b>相互影响：</b>{{ item.interactions.join('；') }}</p>
      <div v-if="item.risk_links.length" class="risk-link">关联风险：{{ item.risk_links.join('；') }}（处置以风险管理为准）</div>
      <footer><button @click="item.action_state = '已复制到处理意见草稿'">复制到处理意见</button><button class="primary" @click="item.action_state = '已创建随访草稿'">创建随访</button><button @click="item.action_state = '暂不处理，已留痕'">暂不处理</button></footer>
      <div v-if="item.action_state" class="action-receipt">{{ item.action_state }} · 待医生确认</div>
    </article>
    <div v-if="!conditions.length" class="idle-card">可用资料不足，未生成共病结论。请由医生人工维护问题清单。</div>
  </div>
</template>
