<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { api, type LabResult, type PatientOrder } from '../api'
import { useWorkstation } from '../stores/workstation'
import { RECORD_SEGMENTS, type RecordSegment } from './types'

/**
 * 记录页：病历 / 医嘱 / 检查检验 / 时间轴 / 健康档案，**一律只读**。
 *
 * 手机端不写 HIS/EMR —— 提交病历、回写诊断、开立医嘱都不在这里。
 * 顶部那条黄色横幅是刻意的：不说清楚，医生会一直找「提交」按钮在哪，
 * 以为是自己没找到。
 *
 * 病历字段用纯文本呈现，不做成输入框的样子。外观即承诺：
 * 长得像输入框就一定会有人去点，点了没反应比没有输入框更糟。
 */

const ws = useWorkstation()

const props = defineProps<{ segment?: RecordSegment | '' }>()

const SEGMENTS = RECORD_SEGMENTS
const seg = ref<RecordSegment>('病历')

watch(
  () => props.segment,
  (value) => {
    if (value) seg.value = value
  },
  { immediate: true },
)

const patient = computed(() => ws.patient)
const summary = computed(() => ws.summary)

/** 病历十段的中文名与取值来源，顺序与桌面端左栏一致 */
const FIELDS: { key: string; label: string }[] = [
  { key: 'chief_complaint', label: '主诉' },
  { key: 'present_illness', label: '现病史' },
  { key: 'past_history', label: '既往史' },
  { key: 'personal_history', label: '个人史' },
  { key: 'allergies', label: '过敏史' },
  { key: 'vitals_text', label: '体征' },
  { key: 'physical_exam', label: '体格检查' },
  { key: 'auxiliary_exam', label: '辅助检查' },
  { key: 'advice', label: '建议' },
]

/** 最近一次暂存/提交的病历。读不到就退回聚合结果里的基线。 */
const saved = ref<Record<string, string>>({})
const savedHint = ref('')

async function loadSaved() {
  savedHint.value = ''
  saved.value = {}
  if (!ws.patientId) return
  try {
    const result = await api.savedRecord(ws.patientId)
    if (result.submitted) {
      saved.value = result.submitted.fields
      savedHint.value = `已提交 · 第 ${result.submitted.version} 版`
    } else if (result.latest) {
      saved.value = result.latest.fields
      savedHint.value = `上次暂存 · 第 ${result.latest.version} 版`
    }
  } catch {
    // 没有保存记录是正常情况，按基线显示
  }
}

const allergyText = computed(() => {
  const value = patient.value?.allergies
  if (Array.isArray(value)) return value.join('、') || '无'
  return value || '无'
})

const vitalsText = computed(() => {
  const v = (patient.value?.vitals ?? {}) as Record<string, string | number>
  // 种子里的 bp 有的写「142/88」有的写「142/88 mmHg」，直接拼会变成 mmHgmmHg
  const bp = String(v.bp ?? '').replace(/\s*mmHg\s*$/i, '')
  return [
    v.height && `身高 ${v.height}cm`,
    v.weight && `体重 ${v.weight}kg`,
    v.bmi && `BMI ${v.bmi}`,
    v.temp && `体温 ${v.temp}℃`,
    bp && `血压 ${bp} mmHg`,
    v.hr && `心率 ${v.hr}次/分`,
  ]
    .filter(Boolean)
    .join(' · ')
})

const recordRows = computed(() =>
  FIELDS.map(({ key, label }) => {
    let value = saved.value[key] ?? ws.record[key] ?? ''
    if (!value && key === 'allergies') value = allergyText.value
    if (!value && key === 'vitals_text') value = vitalsText.value
    if (!value && key === 'chief_complaint') value = patient.value?.chief_complaint ?? ''
    if (!value && key === 'past_history') value = patient.value?.past_history ?? ''
    return { key, label, value }
  }).filter((row) => row.value),
)

const drugOrders = computed<PatientOrder[]>(() =>
  (patient.value?.orders ?? []).filter((o) => o.category !== 'exam'),
)

type ExamRow = { id: string; name: string; type: string; date: string; conclusion: string }

/** 与桌面端同源：已做的检查来自 examinations，本次新开的来自医嘱表 */
const examRows = computed<ExamRow[]>(() => {
  const done = (summary.value?.examinations ?? []).map((e, i) => {
    const row = e as Record<string, string>
    return {
      id: String(row.id ?? `exam-${i}`),
      name: row.name ?? '',
      type: row.type ?? '检查',
      date: row.date ?? '',
      conclusion: row.conclusion ?? '',
    }
  })
  const ordered = (patient.value?.orders ?? [])
    .filter((o) => o.category === 'exam' && o.exam_type !== '检验')
    .map((o) => ({ id: o.id, name: o.name ?? '', type: o.exam_type ?? '检查', date: '', conclusion: '待出结果' }))
  return [...done, ...ordered]
})

const labs = computed<LabResult[]>(() => patient.value?.lab_results ?? [])

const timeline = computed(() => summary.value?.timeline ?? [])

type VisitRecord = { visit_date?: string; visit_type?: string; dept?: string; doctor?: string; diagnosis?: string; summary?: string }
const visits = computed<VisitRecord[]>(() => (patient.value?.visit_history ?? []) as VisitRecord[])

onMounted(loadSaved)
watch(() => ws.patientId, loadSaved)
</script>

<template>
  <div class="m-records">
    <div class="m-banner">
      <span>👁</span>
      <span>只读视图。提交病历、回写诊断、开立医嘱请在门诊工作站完成。</span>
    </div>

    <div class="m-seg">
      <button
        v-for="item in SEGMENTS"
        :key="item"
        class="m-seg-item"
        :class="{ active: seg === item }"
        type="button"
        @click="seg = item"
      >
        {{ item }}
      </button>
    </div>

    <!-- 病历 -->
    <template v-if="seg === '病历'">
      <p v-if="savedHint" class="m-row-sub">{{ savedHint }}</p>
      <div v-for="row in recordRows" :key="row.key" class="m-field-card">
        <span class="m-field-label">{{ row.label }}</span>
        <span class="m-field-value">{{ row.value }}</span>
      </div>
      <p v-if="!recordRows.length" class="m-empty">本次就诊尚无病历内容</p>
    </template>

    <!-- 医嘱 -->
    <template v-else-if="seg === '医嘱'">
      <div v-for="order in drugOrders" :key="order.id" class="m-field-card">
        <span class="m-field-value m-row-strong">{{ order.drug ?? order.name }}</span>
        <span class="m-row-sub">
          {{ order.dose }} · {{ order.freq }} · {{ order.route }}
          <template v-if="order.days"> · {{ order.days }}天</template>
          <template v-if="order.status"> · {{ order.status }}</template>
        </span>
      </div>
      <p v-if="!drugOrders.length" class="m-empty">暂无药品医嘱</p>
    </template>

    <!-- 检查检验 -->
    <template v-else-if="seg === '检查检验'">
      <p class="m-row-sub">检查 {{ examRows.length }} 项</p>
      <div v-for="row in examRows" :key="row.id" class="m-field-card">
        <span class="m-field-value m-row-strong">{{ row.name }}</span>
        <span class="m-row-sub">
          {{ row.type }}<template v-if="row.date"> · {{ row.date }}</template>
        </span>
        <span class="m-field-value" :class="{ 'm-row-strong': row.conclusion.includes('异常') }">
          {{ row.conclusion || '—' }}
        </span>
      </div>

      <p class="m-row-sub">检验 {{ labs.length }} 项</p>
      <div v-for="lab in labs" :key="lab.name" class="m-field-card">
        <span class="m-field-value m-row-strong">{{ lab.name }}</span>
        <span class="m-row-sub">
          {{ lab.value }}{{ lab.unit ?? '' }} · 参考 {{ lab.ref ?? '—' }}
          <template v-if="lab.abnormal"> · 异常</template>
        </span>
        <span v-if="lab.diff_note" class="m-row-sub">{{ lab.diff_note }}</span>
      </div>
      <p v-if="!examRows.length && !labs.length" class="m-empty">暂无检查检验记录</p>
    </template>

    <!-- 时间轴 -->
    <template v-else-if="seg === '时间轴'">
      <div v-for="(item, i) in timeline" :key="`${item.time}-${i}`" class="m-field-card">
        <span class="m-field-label">{{ item.time }}<template v-if="item.category"> · {{ item.category }}</template></span>
        <span class="m-field-value m-row-strong">{{ item.action }}</span>
        <span v-if="item.detail" class="m-row-sub">{{ item.detail }}</span>
        <span v-if="item.result" class="m-row-sub">{{ item.result }}</span>
      </div>
      <p v-if="!timeline.length" class="m-empty">暂无时间轴记录</p>
    </template>

    <!-- 健康档案 -->
    <template v-else>
      <div class="m-field-card">
        <span class="m-field-label">基本信息</span>
        <span class="m-field-value">
          {{ patient?.name }} · {{ patient?.gender }} · {{ patient?.age }}岁 · {{ patient?.dept }}
        </span>
        <span class="m-row-sub">过敏史：{{ allergyText }}</span>
        <span v-if="vitalsText" class="m-row-sub">{{ vitalsText }}</span>
      </div>
      <p class="m-row-sub">既往就诊 {{ visits.length }} 次</p>
      <div v-for="(visit, i) in visits" :key="`${visit.visit_date}-${i}`" class="m-field-card">
        <span class="m-field-label">{{ visit.visit_date }}<template v-if="visit.visit_type"> · {{ visit.visit_type }}</template></span>
        <span class="m-field-value m-row-strong">{{ visit.diagnosis || '—' }}</span>
        <span class="m-row-sub">{{ visit.dept }}<template v-if="visit.doctor"> · {{ visit.doctor }}</template></span>
        <span v-if="visit.summary" class="m-row-sub">{{ visit.summary }}</span>
      </div>
      <p v-if="!visits.length" class="m-empty">暂无既往就诊记录</p>
    </template>
  </div>
</template>
