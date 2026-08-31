<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

import { api, type PatientListItem } from '../api'
import { useSession } from '../stores/session'

type ManagedPatient = PatientListItem & { in_queue: boolean; reminded: boolean }

const router = useRouter()
const session = useSession()

const rows = ref<ManagedPatient[]>([])
const loading = ref(false)
const selected = ref<ManagedPatient[]>([])
const deptFilter = ref('')
const riskFilter = ref('')

const today = new Date().toLocaleDateString('zh-CN')
const depts = computed(() => [...new Set(rows.value.map((r) => r.dept))].filter(Boolean))

const visible = computed(() =>
  rows.value.filter(
    (r) => (!deptFilter.value || r.dept === deptFilter.value) && (!riskFilter.value || r.risk_level === riskFilter.value),
  ),
)

const highRisk = computed(() => rows.value.filter((r) => r.risk_level.includes('高')))
const waiting = computed(() => rows.value.filter((r) => r.in_queue))
const remindedCount = computed(() => rows.value.filter((r) => r.reminded).length)

function riskType(level: string) {
  if (level.includes('高')) return 'danger'
  if (level.includes('中')) return 'warning'
  return 'success'
}

async function requeue(row: ManagedPatient) {
  try {
    const result = await api.requeuePatient(row.id)
    ElMessage.success(result.message)
    await load()
  } catch (error) {
    ElMessage.error(`操作失败：${(error as Error).message}`)
  }
}

async function load() {
  loading.value = true
  try {
    rows.value = (await api.patientsManage()).patients
  } catch (error) {
    ElMessage.error(`患者管理加载失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function remind(ids: string[]) {
  if (!ids.length) {
    ElMessage.warning('请先选择患者')
    return
  }
  try {
    const result = await api.remind(ids)
    ElMessage.success(result.message)
    await load()
  } catch (error) {
    ElMessage.error(`提醒失败：${(error as Error).message}`)
  }
}

function reset() {
  deptFilter.value = ''
  riskFilter.value = ''
}

function logout() {
  session.logout()
  router.push('/login')
}

onMounted(load)
</script>

<template>
  <div class="pm-page">
    <div class="his-header">
      <div class="his-header-left">
        <span class="his-logo">🏥</span>
        <span class="his-title">患者管理</span>
        <span class="his-subtitle">统计接诊 · 危急值与失访智能提醒</span>
      </div>
      <div class="his-header-right">
        <el-button text size="small" @click="router.push('/outpatient/list')">候诊列表</el-button>
        <span class="his-date">{{ session.doctorName }} · {{ today }}</span>
        <el-button text type="danger" size="small" @click="logout">退出</el-button>
      </div>
    </div>

    <div class="pm-main">
      <div class="pm-stats">
        <button class="stat-card" type="button">
          <div class="stat-label">在管患者</div>
          <div class="stat-value">{{ rows.length }}<span class="unit">人</span></div>
        </button>
        <button class="stat-card" type="button">
          <div class="stat-label">高风险</div>
          <div class="stat-value danger">{{ highRisk.length }}<span class="unit">人</span></div>
        </button>
        <button class="stat-card" type="button">
          <div class="stat-label">今日候诊</div>
          <div class="stat-value">{{ waiting.length }}<span class="unit">人</span></div>
        </button>
        <button class="stat-card" type="button">
          <div class="stat-label">已提醒</div>
          <div class="stat-value warn">{{ remindedCount }}<span class="unit">人</span></div>
        </button>
        <button class="stat-card highlight" type="button">
          <div class="stat-label">高风险待提醒</div>
          <div class="stat-value danger">{{ highRisk.filter((r) => !r.reminded).length }}<span class="unit">人</span></div>
          <div class="stat-foot">优先智能提醒</div>
        </button>
        <button class="stat-card" type="button">
          <div class="stat-label">已选</div>
          <div class="stat-value">{{ selected.length }}<span class="unit">人</span></div>
        </button>
      </div>

      <div v-if="highRisk.length" class="pm-alert">
        <div class="pm-alert-text">
          <strong>智能提醒</strong>
          检出高风险患者 {{ highRisk.length }} 人，其中 {{ highRisk.filter((r) => !r.reminded).length }} 人尚未提醒，建议主动召回随访。
        </div>
        <el-button type="danger" size="small" @click="remind(highRisk.filter((r) => !r.reminded).map((r) => r.id))">
          一键提醒高风险
        </el-button>
      </div>

      <div class="pm-toolbar">
        <div class="pm-filters">
          <el-select v-model="deptFilter" placeholder="科室" clearable style="width: 140px">
            <el-option v-for="dept in depts" :key="dept" :label="dept" :value="dept" />
          </el-select>
          <el-select v-model="riskFilter" placeholder="风险" clearable style="width: 120px">
            <el-option label="高风险" value="高风险" />
            <el-option label="中风险" value="中风险" />
            <el-option label="低风险" value="低风险" />
          </el-select>
          <el-button size="small" @click="reset">重置</el-button>
        </div>
        <div class="pm-actions">
          <span class="pm-count">筛选结果 <strong>{{ visible.length }}</strong> 人</span>
          <el-button type="primary" size="small" @click="remind(selected.map((r) => r.id))">
            提醒已选({{ selected.length }})
          </el-button>
          <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        </div>
      </div>

      <div class="pm-table-wrap">
        <el-table
          v-loading="loading"
          :data="visible"
          height="100%"
          size="small"
          stripe
          @selection-change="(rows_: ManagedPatient[]) => (selected = rows_)"
        >
          <el-table-column type="selection" width="42" />
          <el-table-column label="患者" min-width="150">
            <template #default="{ row }">
              <div class="pm-name">{{ row.name }}</div>
              <div class="pm-meta">{{ row.gender }} · {{ row.age }}岁 · {{ row.id }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="dept" label="科室" width="110" />
          <el-table-column prop="doctor" label="主治" width="90" />
          <el-table-column label="风险" width="90">
            <template #default="{ row }">
              <el-tag size="small" round effect="light" :type="riskType(row.risk_level)">{{ row.risk_level }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="主诉" min-width="220">
            <template #default="{ row }">
              <div class="pm-sub">{{ row.chief_complaint }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="primary_diagnosis" label="主要诊断" min-width="160" />
          <el-table-column label="候诊" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.in_queue ? 'success' : 'info'" effect="plain">
                {{ row.in_queue ? '候诊中' : '已完成' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="提醒" width="150">
            <template #default="{ row }">
              <div class="pm-reminders">
                <el-button type="primary" size="small" link @click="remind([row.id])">提醒</el-button>
                <span v-if="row.reminded" class="pm-reminded">✓ 已提醒</span>
                <!-- 提交病历会让患者出队，这是不可逆的单向操作；给一条明确的退路 -->
                <el-button v-if="!row.in_queue" size="small" link type="primary" @click="requeue(row)">
                  重新接诊
                </el-button>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button type="primary" size="small" link @click="router.push(`/outpatient/${row.id}`)">
                进入工作站
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<style scoped src="../styles/PatientManage.scoped.css"></style>
