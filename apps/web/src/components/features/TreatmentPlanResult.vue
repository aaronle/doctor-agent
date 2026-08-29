<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{ content?: Record<string, any> }>()
const selectedMedicationIds = ref<string[]>([])
const receipt = ref('')

const plan = computed(() => props.content?.treatment_plan)

watch(
  () => props.content,
  () => {
    selectedMedicationIds.value = []
    receipt.value = ''
  },
)

function medicationId(item: Record<string, string>, index: string | number) {
  return `${index}-${item.name}`
}

function toggleMedication(item: Record<string, string>, index: string | number) {
  const id = medicationId(item, index)
  selectedMedicationIds.value = selectedMedicationIds.value.includes(id)
    ? selectedMedicationIds.value.filter((value) => value !== id)
    : [...selectedMedicationIds.value, id]
}

function confirmWriteBack() {
  receipt.value = '已生成医嘱回写确认单，等待医生在 HIS 中最终确认。'
}
</script>

<template>
  <div v-if="!plan" class="state-card loading-state">
    <span class="spinner"></span><strong>正在准备推荐治疗方案</strong>
  </div>
  <div v-else class="treatment-plan">
    <section class="treatment-section">
      <header class="section-title-row">
        <strong>推荐药物</strong>
        <button class="text-button">＋ 新增医嘱</button>
      </header>
      <div class="treatment-confirm-bar">
        <button class="confirm-writeback" :disabled="!selectedMedicationIds.length" @click="confirmWriteBack">✔ 确认并回写到医嘱</button>
        <span>回写后 HIS 将打开开嘱确认面板</span>
      </div>
      <article v-for="(item, index) in plan.medications" :key="item.name" class="medication-card">
        <div>
          <strong>{{ item.name }}</strong>
          <span>{{ item.dose }} · {{ item.frequency }} · {{ item.route }}</span>
          <small>{{ item.basis }}</small>
        </div>
        <button @click="toggleMedication(item, index)">
          {{ selectedMedicationIds.includes(medicationId(item, index)) ? '已加入医嘱草稿' : '添加到医嘱单' }}
        </button>
      </article>
      <p v-if="receipt" class="treatment-receipt">{{ receipt }}</p>
    </section>

    <section class="treatment-section exam-section">
      <header class="section-title-row"><strong>推荐检查与检验</strong><span>{{ plan.examinations.length }} 项</span></header>
      <article v-for="item in plan.examinations" :key="item.name" class="exam-order-card">
        <div><strong>{{ item.name }}</strong><em>{{ item.type }}</em></div>
        <span>{{ item.timing }}</span>
        <small>{{ item.basis }}</small>
      </article>
    </section>
    <p class="clinical-notice">{{ plan.notice }}</p>
  </div>
</template>
