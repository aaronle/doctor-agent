<script setup lang="ts">
import { reactive } from 'vue'

const props = defineProps<{ content: Record<string, any>; receipt?: string }>()
const emit = defineEmits<{ writeback: [] }>()
const diagnoses = reactive(props.content.diagnoses.map((item: any) => ({ ...item })))

function setPrimary(id: string) {
  diagnoses.forEach((item: any) => (item.is_primary = item.diagnosis_id === id))
}
</script>

<template>
  <div class="diagnosis-management">
    <div class="diagnosis-table-head"><span>诊断名称</span><span>状态</span><span>编码</span><span>主次</span><span>操作</span></div>
    <div v-for="item in diagnoses" :key="item.diagnosis_id" class="diagnosis-row">
      <div><strong>{{ item.name }}</strong><small>{{ item.source }} · {{ item.consistency }}</small></div>
      <select v-model="item.status"><option value="provisional">初步诊断</option><option value="confirmed">已确认</option><option value="rule_out">待排</option><option value="excluded">已排除</option></select>
      <span>{{ item.icd_code }}</span>
      <button :class="{ primary: item.is_primary }" @click="setPrimary(item.diagnosis_id)">{{ item.is_primary ? '主要诊断' : '设为主要' }}</button>
      <button @click="item.status = 'excluded'">排除</button>
    </div>
    <div class="validation-issues"><strong>一致性检查</strong><span v-for="item in content.validation.issues" :key="item">{{ item }}</span></div>
    <div class="writeback-bar"><button class="primary" @click="emit('writeback')">确认并回写诊断</button><span v-if="receipt">演示回执：{{ receipt }}</span><span v-else>写回前请核对主诊断与编码</span></div>
  </div>
</template>
