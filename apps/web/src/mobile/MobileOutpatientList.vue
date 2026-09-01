<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import type { PatientListItem } from '../api'

/**
 * 候诊列表（移动端）。
 *
 * 桌面版的卡片本来就是单列排布，收窄后大体成立；真正要改的是页头 ——
 * 标题、AI 徽标、医生名、日期挤一行在 390px 里会折成三行，把首屏吃掉一半。
 * 这里压成一行，筛选收进按钮，点开是底部抽屉。
 *
 * 卡片按钮从「进入工作站 →」改为「接诊」：手机上点进去是只读对话页，
 * 叫「工作站」名不副实。
 */

const props = defineProps<{
  patients: PatientListItem[]
  loading: boolean
  doctorName: string
  today: string
}>()

const emit = defineEmits<{ refresh: [] }>()

const router = useRouter()

const keyword = ref('')
const deptFilter = ref('')
const riskFilter = ref('')
const filterOpen = ref(false)

const depts = computed(() => [...new Set(props.patients.map((p) => p.dept))].filter(Boolean))
const risks = computed(() => [...new Set(props.patients.map((p) => p.risk_level))].filter(Boolean))

const visible = computed(() =>
  props.patients.filter((p) => {
    const text = `${p.name}${p.id}${p.chief_complaint}${p.primary_diagnosis}`
    return (
      (!keyword.value || text.includes(keyword.value)) &&
      (!deptFilter.value || p.dept === deptFilter.value) &&
      (!riskFilter.value || p.risk_level === riskFilter.value)
    )
  }),
)

const activeFilters = computed(() => [deptFilter.value, riskFilter.value].filter(Boolean).length)

function riskClass(level = '') {
  if (level.includes('高')) return 'danger'
  if (level.includes('中')) return 'warn'
  return 'ok'
}

function reset() {
  deptFilter.value = ''
  riskFilter.value = ''
}
</script>

<template>
  <div class="m-page">
    <div class="m-topbar">
      <div class="m-who">
        <span class="m-who-name">🏥 AI 门诊工作站</span>
        <span class="m-who-meta">{{ doctorName }} · {{ today }}</span>
      </div>
      <span class="m-spacer" />
      <span class="m-tag ok">AI 已就绪</span>
    </div>

    <div class="m-toolbar">
      <input v-model="keyword" class="m-search" placeholder="搜索患者姓名 / ID / 诊断" />
      <button class="m-btn" type="button" @click="filterOpen = true">
        筛选<template v-if="activeFilters"> ({{ activeFilters }})</template>
      </button>
    </div>

    <div class="m-body">
      <div class="m-section-label">今日候诊 {{ visible.length }} 人</div>
      <div class="m-cards">
        <div v-for="patient in visible" :key="patient.id" class="m-pcard">
          <div class="m-pcard-head">
            <div class="m-avatar">{{ (patient.name ?? '?').charAt(0) }}</div>
            <div class="m-who">
              <span class="m-pcard-name">{{ patient.name }}</span>
              <span class="m-pcard-meta">{{ patient.gender }} · {{ patient.age }}岁 · {{ patient.dept }}</span>
            </div>
            <span class="m-spacer" />
            <span v-if="patient.risk_level" class="m-tag" :class="riskClass(patient.risk_level)">
              {{ patient.risk_level }}
            </span>
          </div>

          <div class="m-pcard-line">主诉：{{ patient.chief_complaint }}</div>

          <div class="m-tags">
            <span v-if="patient.primary_diagnosis" class="m-tag">{{ patient.primary_diagnosis }}</span>
            <span class="m-tag">{{ patient.visit_type }}</span>
            <span class="m-spacer" />
            <!-- 手机上点进去是只读对话页，所以不叫「进入工作站」 -->
            <button class="m-btn primary" type="button" @click="router.push(`/outpatient/${patient.id}`)">接诊</button>
          </div>
        </div>
      </div>
      <p v-if="!loading && !visible.length" class="m-empty">暂无候诊患者</p>
      <p v-if="loading" class="m-empty">加载中…</p>
    </div>

    <div class="m-tabbar">
      <button class="m-tab active" type="button">
        <span class="m-tab-icon">📋</span><span class="m-tab-label">候诊</span>
      </button>
      <button class="m-tab" type="button" @click="router.push('/outpatient/manage')">
        <span class="m-tab-icon">👥</span><span class="m-tab-label">患者管理</span>
      </button>
      <button class="m-tab" type="button" @click="emit('refresh')">
        <span class="m-tab-icon">🔄</span><span class="m-tab-label">刷新</span>
      </button>
    </div>

    <template v-if="filterOpen">
      <div class="m-scrim" @click="filterOpen = false" />
      <div class="m-sheet">
        <div class="m-grab" />
        <div class="m-sheet-head">
          <span class="m-sheet-title">筛选</span>
          <span class="m-spacer" />
          <button class="m-btn link" type="button" @click="reset">重置</button>
        </div>
        <div class="m-sheet-body">
          <div class="m-group">
            <span class="m-group-title">科室</span>
            <div class="m-tags">
              <button
                v-for="dept in depts"
                :key="dept"
                class="m-qa-chip"
                type="button"
                :style="deptFilter === dept ? 'border-color:var(--blue);color:var(--blue)' : ''"
                @click="deptFilter = deptFilter === dept ? '' : dept"
              >
                {{ dept }}
              </button>
            </div>
          </div>
          <div class="m-group">
            <span class="m-group-title">风险</span>
            <div class="m-tags">
              <button
                v-for="risk in risks"
                :key="risk"
                class="m-qa-chip"
                type="button"
                :style="riskFilter === risk ? 'border-color:var(--blue);color:var(--blue)' : ''"
                @click="riskFilter = riskFilter === risk ? '' : risk"
              >
                {{ risk }}
              </button>
            </div>
          </div>
          <button class="m-btn primary" type="button" @click="filterOpen = false">
            查看 {{ visible.length }} 位患者
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
