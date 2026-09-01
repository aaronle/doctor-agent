<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import type { PatientListItem } from '../api'

/**
 * 患者管理（移动端）。
 *
 * 桌面是一张九列表格。390px 里九列必然横向溢出，而 `html,body{overflow:hidden}`
 * 会把溢出的列裁掉 —— 不是「要横滑」，是**够不着**。所以表格改成卡片。
 *
 * 「提醒」与「重新接诊」保留：它们写的是本系统的状态，不落 HIS/EMR，
 * 不在手机端禁用的范围内。
 */

const props = defineProps<{
  rows: (PatientListItem & { in_queue: boolean; reminded: boolean })[]
  loading: boolean
}>()

const emit = defineEmits<{
  refresh: []
  remind: [string[]]
  requeue: [string]
  logout: []
}>()

const router = useRouter()

const deptFilter = ref('')
const riskFilter = ref('')
const filterOpen = ref(false)

const depts = computed(() => [...new Set(props.rows.map((r) => r.dept))].filter(Boolean))

const visible = computed(() =>
  props.rows.filter(
    (r) => (!deptFilter.value || r.dept === deptFilter.value) && (!riskFilter.value || r.risk_level === riskFilter.value),
  ),
)

const highRisk = computed(() => props.rows.filter((r) => r.risk_level.includes('高')))
const unreminded = computed(() => highRisk.value.filter((r) => !r.reminded))
const waiting = computed(() => props.rows.filter((r) => r.in_queue))
const remindedCount = computed(() => props.rows.filter((r) => r.reminded).length)

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
      <button class="m-back" type="button" aria-label="返回候诊列表" @click="router.push('/outpatient/list')">‹</button>
      <div class="m-who">
        <span class="m-who-name">患者管理</span>
        <span class="m-who-meta">危急值与失访智能提醒</span>
      </div>
      <span class="m-spacer" />
      <button class="m-btn link" type="button" @click="filterOpen = true">筛选</button>
      <button class="m-btn link" type="button" @click="emit('logout')">退出</button>
    </div>

    <div class="m-body">
      <div class="m-stats">
        <div class="m-stat">
          <div class="m-stat-label">在管患者</div>
          <div class="m-stat-value">{{ rows.length }}<span class="m-stat-unit">人</span></div>
        </div>
        <div class="m-stat">
          <div class="m-stat-label">今日候诊</div>
          <div class="m-stat-value">{{ waiting.length }}<span class="m-stat-unit">人</span></div>
        </div>
        <div class="m-stat">
          <div class="m-stat-label">高风险</div>
          <div class="m-stat-value danger">{{ highRisk.length }}<span class="m-stat-unit">人</span></div>
        </div>
        <div class="m-stat">
          <div class="m-stat-label">已提醒</div>
          <div class="m-stat-value warn">{{ remindedCount }}<span class="m-stat-unit">人</span></div>
        </div>
      </div>

      <div v-if="unreminded.length" class="m-alert">
        <span>
          <strong>智能提醒</strong>　高风险 {{ highRisk.length }} 人，其中 {{ unreminded.length }} 人尚未提醒，建议主动召回随访。
        </span>
        <button class="m-btn primary" type="button" @click="emit('remind', unreminded.map((r) => r.id))">
          一键提醒高风险
        </button>
      </div>

      <div class="m-section-label">筛选结果 {{ visible.length }} 人</div>

      <div class="m-cards">
        <div v-for="row in visible" :key="row.id" class="m-pcard">
          <div class="m-pcard-head">
            <div class="m-avatar">{{ (row.name ?? '?').charAt(0) }}</div>
            <div class="m-who">
              <span class="m-pcard-name">{{ row.name }}</span>
              <span class="m-pcard-meta">{{ row.gender }} · {{ row.age }}岁 · {{ row.id }}</span>
            </div>
            <span class="m-spacer" />
            <span class="m-tag" :class="riskClass(row.risk_level)">{{ row.risk_level }}</span>
          </div>

          <div class="m-pcard-line">{{ row.dept }} · 主治 {{ row.doctor }}</div>
          <div class="m-pcard-line">主诉：{{ row.chief_complaint }}</div>
          <div v-if="row.primary_diagnosis" class="m-pcard-line">诊断：{{ row.primary_diagnosis }}</div>

          <div class="m-tags">
            <span class="m-tag" :class="row.in_queue ? 'ok' : ''">{{ row.in_queue ? '候诊中' : '已完成' }}</span>
            <span v-if="row.reminded" class="m-tag ok">✓ 已提醒</span>
          </div>

          <div class="m-pcard-foot">
            <button class="m-btn link" type="button" @click="emit('remind', [row.id])">提醒</button>
            <!-- 提交病历会让患者出队，那是不可逆的单向操作；给一条明确的退路 -->
            <button v-if="!row.in_queue" class="m-btn link" type="button" @click="emit('requeue', row.id)">
              重新接诊
            </button>
            <span class="m-spacer" />
            <button class="m-btn primary" type="button" @click="router.push(`/outpatient/${row.id}`)">接诊</button>
          </div>
        </div>
      </div>
      <p v-if="!loading && !visible.length" class="m-empty">没有符合条件的患者</p>
      <p v-if="loading" class="m-empty">加载中…</p>
    </div>

    <div class="m-tabbar">
      <button class="m-tab" type="button" @click="router.push('/outpatient/list')">
        <span class="m-tab-icon">📋</span><span class="m-tab-label">候诊</span>
      </button>
      <button class="m-tab active" type="button">
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
                v-for="risk in ['高风险', '中风险', '低风险']"
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
            查看 {{ visible.length }} 人
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
