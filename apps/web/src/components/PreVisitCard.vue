<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { api } from '../api'

/**
 * 医生端看到的「患者候诊时填的」。桌面端与移动端共用。
 *
 * 这张卡要同时说清三件事：**填了什么**、**什么时候填的**、
 * **哪一项还需要医生确认**。第三件最容易被省掉，而省掉它，
 * 患者那次采集就等于白做 —— 因为按设计它不会自动改档案
 * （患者自报 ≠ 医生问过，见 `routers/previsit.py` 文件头）。
 *
 * 还有一层翻译：患者端问的是「上一次月经是哪天开始的」，
 * 医生端显示「末次月经」。同一件事两边各说各的行话，中间由这张卡换过来 ——
 * 让医生去读患者的措辞，和让患者去读术语，是同一个错误的两个方向。
 */

const props = defineProps<{ patientId: string }>()

type Answer = { choice?: string; choices?: string[]; text?: string; date?: string; pair?: [string, string] }

/** 患者的问法 → 医生的说法。**闭集写在一处**，散在模板里加一题就会漏改 */
const DOCTOR_LABEL: Record<string, string> = {
  chief_complaint: '不舒服',
  duration: '持续',
  allergy: '药物过敏',
  current_meds: '在用药物',
  lmp: '末次月经',
  cycle_regular: '月经',
  obstetric: '生育史',
  pregnancy_possible: '妊娠可能',
  last_glucose: '近期血糖',
  hypoglycemia: '低血糖发作',
  med_adherence: '用药依从',
  foot_check: '足部',
  onset_context: '诱因',
  episode_duration: '发作时长',
  night_symptoms: '夜间症状',
  site: '疼痛部位',
  pain_timing: '疼痛时段',
  walk_distance: '无痛行走',
  falls: '跌倒史',
  weakness: '肢体无力',
  speech: '言语',
  onset_pattern: '起病',
  syncope: '晕厥',
}

const loading = ref(true)
const data = ref<{ answers: Record<string, Answer>; submitted_at: string; needs_confirmation: boolean } | null>(null)

async function load() {
  loading.value = true
  try {
    data.value = await api.preVisitAnswers(props.patientId)
  } catch {
    data.value = null
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.patientId, load)

/** 一条答案压成一行字。**空的直接跳过** —— 列一堆「—」会让人以为患者敷衍了事 */
function render(a: Answer): string {
  const parts: string[] = []
  if (a.choices?.length) parts.push(a.choices.join('、'))
  if (a.choice) parts.push(a.choice)
  if (a.date) parts.push(a.date)
  if (a.pair?.some(Boolean)) parts.push(`孕 ${a.pair[0] || '?'} 产 ${a.pair[1] || '?'}`)
  if (a.text) parts.push(a.text)
  return parts.join(' · ')
}

const rows = computed(() =>
  Object.entries(data.value?.answers ?? {})
    .map(([key, a]) => ({ key, label: DOCTOR_LABEL[key] ?? key, value: render(a) }))
    .filter((r) => r.value))

const has = computed(() => rows.value.length > 0)
const when = computed(() => {
  const raw = data.value?.submitted_at
  if (!raw) return ''
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})
</script>

<template>
  <p v-if="loading" class="pvc-loading">读取中…</p>
  <section v-else-if="has" class="pvc">
    <header class="pvc-head">
      <span class="pvc-tag">患者自填</span>
      <span class="pvc-title">候诊时填的</span>
      <span class="pvc-time">{{ when }}</span>
    </header>
    <div
      v-for="r in rows"
      :key="r.key"
      class="pvc-row"
      :class="{ 'needs-confirm': r.key === 'allergy' && data?.needs_confirmation }"
    >
      <span class="pvc-k">{{ r.label }}</span>
      <span class="pvc-v">
        {{ r.value }}
        <em v-if="r.key === 'allergy' && data?.needs_confirmation" class="pvc-flag">待确认</em>
      </span>
    </div>
    <p v-if="data?.needs_confirmation" class="pvc-note">
      ⓘ 患者自报不改过敏状态。你问过并确认后，档案才从「未采集」变成「已确认」。
    </p>
  </section>
</template>

<style scoped src="../styles/PreVisitCard.scoped.css"></style>
