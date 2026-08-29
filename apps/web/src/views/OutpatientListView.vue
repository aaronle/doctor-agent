<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

import { api, type PatientListItem } from '../api'
import { useSession } from '../stores/session'

const router = useRouter()
const session = useSession()

const patients = ref<PatientListItem[]>([])
const loading = ref(false)
const keyword = ref('')
const deptFilter = ref('')
const riskFilter = ref('')

const today = new Date().toLocaleDateString('zh-CN')

const depts = computed(() => [...new Set(patients.value.map((p) => p.dept))].filter(Boolean))
const risks = computed(() => [...new Set(patients.value.map((p) => p.risk_level))].filter(Boolean))

const visible = computed(() =>
  patients.value.filter((p) => {
    const text = `${p.name}${p.id}${p.chief_complaint}${p.primary_diagnosis}`
    return (
      (!keyword.value || text.includes(keyword.value)) &&
      (!deptFilter.value || p.dept === deptFilter.value) &&
      (!riskFilter.value || p.risk_level === riskFilter.value)
    )
  }),
)

/** 风险等级 → Element Plus 标签类型。高风险用 danger，与界面红黄绿一致。 */
function riskType(level: string) {
  if (level.includes('高')) return 'danger'
  if (level.includes('中')) return 'warning'
  return 'success'
}

async function load() {
  loading.value = true
  try {
    patients.value = await api.patients()
  } catch (error) {
    ElMessage.error(`候诊列表加载失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

function enter(patient: PatientListItem) {
  router.push(`/outpatient/${patient.id}`)
}

function logout() {
  session.logout()
  router.push('/login')
}

onMounted(load)
</script>

<template>
  <div class="his-list-page">
    <div class="his-header">
      <div class="his-header-left">
        <span class="his-logo">🏥</span>
        <span class="his-title">惠每门诊工作站</span>
        <span class="his-subtitle">HIS · 门诊管理系统</span>
      </div>
      <div class="his-header-right">
        <div class="ai-badge"><span class="ai-dot" />AI 已就绪</div>
        <span class="his-date">{{ session.doctorName }} · {{ today }}</span>
        <el-button text type="danger" size="small" @click="logout">退出</el-button>
      </div>
    </div>

    <div class="his-toolbar">
      <div class="toolbar-left">
        <el-input v-model="keyword" :prefix-icon="Search" placeholder="搜索患者姓名/ID/诊断" clearable style="width: 220px" />
        <el-select v-model="deptFilter" placeholder="全部科室" clearable style="width: 130px">
          <el-option v-for="dept in depts" :key="dept" :label="dept" :value="dept" />
        </el-select>
        <el-select v-model="riskFilter" placeholder="全部风险" clearable style="width: 120px">
          <el-option v-for="risk in risks" :key="risk" :label="risk" :value="risk" />
        </el-select>
      </div>
      <div class="toolbar-right">
        <span class="patient-count">今日候诊：<strong>{{ visible.length }}</strong> 人</span>
        <el-button type="primary" size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button size="small" @click="router.push('/outpatient/manage')">患者管理</el-button>
      </div>
    </div>

    <div v-loading="loading" class="his-main">
      <el-empty v-if="!loading && !visible.length" class="his-empty" description="暂无候诊患者" />
      <div v-else class="patient-grid">
        <div v-for="patient in visible" :key="patient.id" class="patient-card" @click="enter(patient)">
          <div class="card-header">
            <div class="patient-avatar">{{ patient.name.charAt(0) }}</div>
            <div class="patient-basic">
              <div class="patient-name">{{ patient.name }}</div>
              <div class="patient-meta">{{ patient.gender }} · {{ patient.age }}岁 · {{ patient.dept }}</div>
            </div>
            <div class="card-badges">
              <el-tag size="small" type="success" round effect="light">{{ patient.visit_type }}</el-tag>
              <el-tag v-if="patient.risk_level" class="risk-tag" size="small" round effect="light" :type="riskType(patient.risk_level)">
                {{ patient.risk_level }}
              </el-tag>
            </div>
          </div>

          <div class="card-complaint">
            <span class="label">主诉：</span><span class="text">{{ patient.chief_complaint }}</span>
          </div>

          <div class="card-diagnosis">
            <el-tag v-if="patient.primary_diagnosis" size="small" type="info" effect="plain">
              {{ patient.primary_diagnosis }}
            </el-tag>
          </div>

          <div class="card-footer">
            <span class="visit-date">{{ patient.visit_date }}</span>
            <span class="doctor">主治：{{ patient.doctor }}</span>
            <el-button class="enter-btn" type="primary" size="small">进入工作站 →</el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="../styles/OutpatientList.scoped.css"></style>
