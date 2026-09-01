<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { api, type LabResult, type RecordQuality } from '../api'
import { useWorkstation } from '../stores/workstation'

/**
 * 分析页：桌面端 AI 助手八个标签页的全部内容，在手机上折叠成手风琴。
 *
 * 为什么不照搬标签页 —— 八个标签在 390px 宽里只能横向滚动，医生看不到
 * 后面还有什么，等于把一半功能藏起来。折叠段把八块同时摆在一屏内，
 * 带角标显示各自条数，要看哪块点哪块。
 *
 * 这一页**只读**：手机端不写 HIS/EMR，所以没有「确认回写」「开嘱」这类按钮。
 */

const ws = useWorkstation()

const props = defineProps<{ focus?: string }>()

const summary = computed(() => ws.summary)
const patient = computed(() => ws.patient)

/**
 * 默认只展开病情概要。
 *
 * 一开始默认展开两块，实测第一屏被概要和鉴别诊断吃满 —— 概要的问题清单有
 * 十条、鉴别诊断五条各带支持/反对/缺失，后面六块要滚三屏才看得见。
 * 那样折叠就白做了。现在这一页首屏是一张带条数的目录，点哪块看哪块。
 */
const open = ref<Set<string>>(new Set(['病情概要']))

/** 概要里的问题清单与疗效评估都单独收着，理由同上 */
const problemsOpen = ref(false)
const effectOpen = ref(false)

function toggle(key: string) {
  const next = new Set(open.value)
  next.has(key) ? next.delete(key) : next.add(key)
  open.value = next
}

/** ＋ 菜单与对话卡片跳过来时，把目标块展开并滚到位 */
watch(
  () => props.focus,
  (key) => {
    if (!key) return
    open.value = new Set([...open.value, key])
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-sec="${key}"]`)
      // jsdom 里没有 scrollIntoView，缺了这层判断整个测试会挂在未处理拒绝上
      if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }
    })
  },
  { immediate: true },
)

// ------------------------------------------------------------------ 各块数据

const conclusion = computed(() => summary.value?.overall_conclusion ?? {})
const diagnoses = computed(() => summary.value?.suspected_diagnoses ?? [])
const risks = computed(() => summary.value?.risk_assessments ?? [])
const comorbidity = computed(() => summary.value?.comorbidity)
const todos = computed(() => summary.value?.todos ?? [])

const labs = computed<LabResult[]>(() => patient.value?.lab_results ?? [])

/** 阳性结果：异常检查在前、异常检验在后，与桌面端同一套判定 */
const positives = computed(() => {
  const exams = (summary.value?.examinations ?? [])
    .filter((e) => {
      const row = e as Record<string, unknown>
      return row.abnormal === true || String(row.conclusion ?? '').includes('异常')
    })
    .map((e, i) => {
      const row = e as Record<string, string>
      return { id: String(row.id ?? `e${i}`), kind: '检查', name: row.name, detail: row.result ?? row.conclusion ?? '' }
    })
  const abnormalLabs = labs.value
    .filter((l) => l.abnormal)
    .map((l) => ({
      id: `l-${l.name}`,
      kind: '检验',
      name: l.name,
      detail: `${l.value}${l.unit ?? ''}（参考 ${l.ref ?? '—'}）`,
    }))
  return [...exams, ...abnormalLabs]
})

/** 33 项专项评估目录。与桌面端同一个接口，前端不写死。 */
const catalog = ref<{ name: string; count: number; items: { name: string; level: string; desc: string }[] }[]>([])

/**
 * 病历质控。四项指标由后端确定性规则算 —— 不让模型给自己打分。
 * 手机上只看结果，不提供「标记已审阅」（那是留痕动作，留在工作站）。
 */
const quality = ref<RecordQuality | null>(null)

async function loadExtras() {
  if (!ws.patientId) return
  try {
    catalog.value = (await api.assessmentCatalog()).categories
  } catch {
    // 目录拉不到不影响其余七块
  }
  try {
    const saved = await api.savedRecord(ws.patientId)
    const fields = saved.submitted?.fields ?? saved.latest?.fields ?? ws.record
    quality.value = await api.recordQuality(ws.patientId, fields)
  } catch {
    // 质控算不出来就不显示这一块的明细，不编一个分数出来
  }
}

onMounted(loadExtras)
watch(() => ws.patientId, loadExtras)

function riskTone(level = '') {
  if (level.includes('高') || level.includes('红')) return 'high'
  if (level.includes('中') || level.includes('黄')) return 'mid'
  return 'low'
}
</script>

<template>
  <div class="m-sections">
    <!-- 病情概要 -->
    <section class="m-sec" data-sec="病情概要">
      <button class="m-sec-head" type="button" @click="toggle('病情概要')">
        <span class="m-sec-title">病情概要</span>
        <span v-if="conclusion.risk_level" class="m-tone" :class="riskTone(conclusion.risk_level)">
          {{ conclusion.risk_level }}
        </span>
        <span class="m-spacer" />
        <span class="m-chev">{{ open.has('病情概要') ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open.has('病情概要')" class="m-sec-body">
        <p v-if="conclusion.summary" class="m-row">{{ conclusion.summary }}</p>
        <!-- 矛盾信息并列显示，不合并成一句 —— 合并等于替医生做了判断 -->
        <p v-for="item in conclusion.conflicts ?? []" :key="item" class="m-row m-row-strong">⚠ {{ item }}</p>
        <!--
          问题清单常有八九条，每条两行。默认铺开的话第一屏全被它占满，
          后面七块连标题都看不见 —— 折叠的意义就没了。
        -->
        <template v-if="conclusion.problems?.length">
          <button class="m-cbtn" type="button" @click="problemsOpen = !problemsOpen">
            {{ problemsOpen ? '收起问题清单' : `问题清单 ${conclusion.problems.length} 项` }}
          </button>
          <p v-for="item in problemsOpen ? conclusion.problems : []" :key="item" class="m-row">· {{ item }}</p>
        </template>
        <template v-if="summary?.treatment_effectiveness?.ai_summary">
          <button class="m-cbtn" type="button" @click="effectOpen = !effectOpen">
            {{ effectOpen ? '收起疗效评估' : '疗效评估' }}
          </button>
          <p v-if="effectOpen" class="m-row m-row-sub">{{ summary.treatment_effectiveness.ai_summary }}</p>
        </template>
        <p v-if="!conclusion.summary && !ws.loadingSummary" class="m-row m-row-sub">暂无概要</p>
        <p v-if="ws.loadingSummary" class="m-row m-row-sub">智能体分析中…</p>
      </div>
    </section>

    <!-- 鉴别诊断 -->
    <section class="m-sec" data-sec="鉴别诊断">
      <button class="m-sec-head" type="button" @click="toggle('鉴别诊断')">
        <span class="m-sec-title">鉴别诊断</span>
        <span class="m-sec-badge">{{ diagnoses.length }}</span>
        <span class="m-spacer" />
        <span class="m-chev">{{ open.has('鉴别诊断') ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open.has('鉴别诊断')" class="m-sec-body">
        <div v-for="(item, i) in diagnoses" :key="item.name" class="m-item">
          <div class="m-row m-row-strong">{{ item.rank_label ?? `${i + 1}` }} {{ item.name }}</div>
          <!-- ICD 与置信度另起一行：跟诊断名挤一行会把长诊断名压折 -->
          <div class="m-row-sub">
            <span v-if="item.icd">{{ item.icd }} · </span>{{ item.confidence }}%
            <span v-if="item.likelihood"> · {{ item.likelihood }}</span>
          </div>
          <div v-if="item.supporting?.length" class="m-row-sub">支持：{{ item.supporting.join('；') }}</div>
          <div v-if="item.opposing?.length" class="m-row-sub">反对：{{ item.opposing.join('；') }}</div>
          <div v-if="item.missing?.length" class="m-row-sub">缺失：{{ item.missing.join('；') }}</div>
        </div>
        <p v-if="!diagnoses.length" class="m-row m-row-sub">
          {{ ws.loadingSummary ? '智能体分析中…' : '暂无疑似诊断' }}
        </p>
      </div>
    </section>

    <!-- 预警评估 -->
    <section class="m-sec" data-sec="预警评估">
      <button class="m-sec-head" type="button" @click="toggle('预警评估')">
        <span class="m-sec-title">预警评估</span>
        <span class="m-sec-badge" :class="{ danger: ws.openRedAlerts.length }">{{ risks.length }}</span>
        <span class="m-spacer" />
        <span class="m-chev">{{ open.has('预警评估') ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open.has('预警评估')" class="m-sec-body">
        <div v-for="item in risks" :key="item.id" class="m-item">
          <div class="m-row m-row-strong">
            <!-- 色点靠内联色：等级颜色由后端给，不在前端重排一套映射 -->
            <span class="m-dot" :style="{ background: item.color }" />{{ item.name }}
            <span class="m-row-sub">· {{ item.level }}</span>
          </div>
          <div v-if="item.summary" class="m-row">{{ item.summary }}</div>
          <div v-if="item.evidence" class="m-row-sub">依据：{{ item.evidence }}</div>
          <div v-if="item.suggestion" class="m-row-sub">建议：{{ item.suggestion }}</div>
        </div>
        <p v-if="ws.openRedAlerts.length" class="m-row m-row-sub">
          {{ ws.openRedAlerts.length }} 条红色风险待处置。处置需留痕，请在门诊工作站完成。
        </p>
        <p v-if="!risks.length" class="m-row m-row-sub">暂无风险项</p>
      </div>
    </section>

    <!-- 共病管理 -->
    <section class="m-sec" data-sec="共病管理">
      <button class="m-sec-head" type="button" @click="toggle('共病管理')">
        <span class="m-sec-title">共病管理</span>
        <span class="m-sec-badge">{{ comorbidity?.conditions?.length ?? 0 }}</span>
        <span class="m-spacer" />
        <span class="m-chev">{{ open.has('共病管理') ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open.has('共病管理')" class="m-sec-body">
        <p v-if="comorbidity?.summary" class="m-row">{{ comorbidity.summary }}</p>
        <div v-for="item in comorbidity?.conditions ?? []" :key="item.name" class="m-item">
          <div class="m-row m-row-strong">{{ item.name }}<span v-if="item.icd" class="m-row-sub"> · {{ item.icd }}</span></div>
          <div class="m-row-sub">{{ item.risk_level }}<span v-if="item.duration"> · {{ item.duration }}</span></div>
          <div class="m-row">{{ item.analysis }}</div>
          <div class="m-row-sub">建议会诊科室：{{ item.recommended_dept }}</div>
        </div>
        <p v-if="comorbidity?.nutrition?.triggered" class="m-row m-row-strong">
          🍽 {{ comorbidity.nutrition.message }}
        </p>
        <p v-if="!comorbidity?.detected" class="m-row m-row-sub">未检出需要处理的共病</p>
      </div>
    </section>

    <!-- 专项评估 -->
    <section class="m-sec" data-sec="专项评估">
      <button class="m-sec-head" type="button" @click="toggle('专项评估')">
        <span class="m-sec-title">专项评估</span>
        <span class="m-sec-badge">{{ catalog.length }}</span>
        <span class="m-spacer" />
        <span class="m-chev">{{ open.has('专项评估') ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open.has('专项评估')" class="m-sec-body">
        <div v-for="cat in catalog" :key="cat.name" class="m-item">
          <div class="m-row m-row-strong">{{ cat.name }} · {{ cat.count }} 项</div>
          <div class="m-row-sub">{{ cat.items.map((i) => i.name).join('、') }}</div>
        </div>
        <p v-if="!catalog.length" class="m-row m-row-sub">评估目录加载中…</p>
      </div>
    </section>

    <!-- 阳性结果 -->
    <section class="m-sec" data-sec="阳性结果">
      <button class="m-sec-head" type="button" @click="toggle('阳性结果')">
        <span class="m-sec-title">阳性结果</span>
        <span class="m-sec-badge" :class="{ danger: positives.length }">{{ positives.length }}</span>
        <span class="m-spacer" />
        <span class="m-chev">{{ open.has('阳性结果') ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open.has('阳性结果')" class="m-sec-body">
        <div v-for="item in positives" :key="item.id" class="m-item">
          <div class="m-row m-row-strong">
            <span class="m-tag">{{ item.kind }}</span> {{ item.name }}
          </div>
          <div class="m-row">{{ item.detail }}</div>
        </div>
        <p v-if="!positives.length" class="m-row m-row-sub">暂无阳性结果</p>
      </div>
    </section>

    <!-- 处置建议 -->
    <section class="m-sec" data-sec="处置建议">
      <button class="m-sec-head" type="button" @click="toggle('处置建议')">
        <span class="m-sec-title">处置建议</span>
        <span class="m-sec-badge">{{ todos.length }}</span>
        <span class="m-spacer" />
        <span class="m-chev">{{ open.has('处置建议') ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open.has('处置建议')" class="m-sec-body">
        <div v-for="item in todos" :key="item.id" class="m-item">
          <div class="m-row">{{ item.text }}</div>
          <div class="m-row-sub">{{ item.category }} · {{ item.priority }} · 依据 {{ item.source }}</div>
        </div>
        <div v-for="item in summary?.recommended_exams ?? []" :key="item.id" class="m-item">
          <div class="m-row m-row-strong">推荐复查 · {{ item.name }}</div>
          <div class="m-row-sub">{{ item.type }} · {{ item.basis }}</div>
        </div>
        <div v-for="item in summary?.recommended_orders ?? []" :key="item.drug" class="m-item">
          <div class="m-row m-row-strong">推荐用药 · {{ item.drug }}</div>
          <div class="m-row-sub">{{ item.dose }} {{ item.freq }} {{ item.route }} · {{ item.basis }}</div>
        </div>
        <p class="m-row m-row-sub">以上为建议。开立医嘱与检查请在门诊工作站完成。</p>
      </div>
    </section>

    <!-- 病历质控 -->
    <section class="m-sec" data-sec="病历质控">
      <button class="m-sec-head" type="button" @click="toggle('病历质控')">
        <span class="m-sec-title">病历质控</span>
        <span class="m-sec-badge" :class="{ danger: (quality?.gaps?.length ?? 0) > 0 }">
          {{ quality?.gaps?.length ?? 0 }}
        </span>
        <span class="m-spacer" />
        <span class="m-chev">{{ open.has('病历质控') ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open.has('病历质控')" class="m-sec-body">
        <div v-for="metric in quality?.metrics ?? []" :key="metric.name" class="m-row">
          {{ metric.name }} <span class="m-row-strong">{{ metric.value }}</span>
          <span class="m-row-sub"> · {{ metric.basis }}</span>
        </div>
        <div v-for="gap in quality?.gaps ?? []" :key="gap.field_key + gap.issue" class="m-item">
          <div class="m-row m-row-strong">
            {{ gap.type === 'error' ? '❌' : gap.type === 'warning' ? '⚠️' : 'ℹ️' }} 【{{ gap.field }}】{{ gap.issue }}
          </div>
          <div class="m-row-sub">{{ gap.text }}</div>
        </div>
        <p v-if="!quality" class="m-row m-row-sub">质控计算中…</p>
        <p v-else-if="!quality.gaps?.length" class="m-row m-row-sub">未检出遗漏项</p>
      </div>
    </section>
  </div>
</template>
