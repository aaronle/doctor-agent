<script setup lang="ts">
import { computed, watch } from 'vue'

import { useWorkspaceStore } from '../stores/workspace'
import type { TaskType, WorkspacePanel } from '../types'
import TaskResult from './TaskResult.vue'
import ClinicalAnalysisResult from './features/ClinicalAnalysisResult.vue'
import RiskManagementResult from './features/RiskManagementResult.vue'
import TreatmentPlanResult from './features/TreatmentPlanResult.vue'

const store = useWorkspaceStore()
const pendingTasks = new Set<TaskType>()

const tabs: Array<{ id: WorkspacePanel; label: string }> = [
  { id: 'analysis', label: '智慧诊疗' },
  { id: 'risk', label: '风险预警' },
  { id: 'record', label: '病历管理' },
  { id: 'diagnosis', label: '诊断管理' },
  { id: 'treatment', label: '医嘱管理' },
  { id: 'comorbidity', label: '共病管理' },
  { id: 'archive', label: '健康档案' },
  { id: 'timeline', label: '时间轴' },
]

const panelTaskMap: Partial<Record<WorkspacePanel, TaskType>> = {
  risk: 'risk_management',
  record: 'record_generation',
  diagnosis: 'diagnosis_management',
  comorbidity: 'comorbidity_management',
}

const activeTask = computed(() => panelTaskMap[store.workspacePanel])

async function ensureTask(taskType: TaskType, force = false) {
  if (!store.patient || pendingTasks.has(taskType)) return
  if (!force && store.tasks[taskType]) return
  pendingTasks.add(taskType)
  try {
    await store.runTask(taskType)
  } finally {
    pendingTasks.delete(taskType)
  }
}

async function runPanel(panel: WorkspacePanel, force = false) {
  if (!store.patient) return
  if (panel === 'analysis') {
    await Promise.all([
      ensureTask('condition_summary', force),
      ensureTask('differential_diagnosis', force),
    ])
    return
  }
  if (panel === 'treatment') {
    const hasTreatmentPlan = Boolean(store.tasks.condition_summary?.result?.content?.treatment_plan)
    await ensureTask('condition_summary', force || !hasTreatmentPlan)
    return
  }
  const taskType = panelTaskMap[panel]
  if (taskType) {
    if (panel === 'record' && !store.tasks.voice_interview?.result) return
    await ensureTask(taskType, force)
  }
}

function selectPanel(panel: WorkspacePanel) {
  store.workspacePanel = panel
}

function openRiskAlert() {
  selectPanel('risk')
}

async function rerun() {
  await runPanel(store.workspacePanel, true)
}

async function handleAction(taskType: TaskType, action: string) {
  if (action === 'retry') return ensureTask(taskType, true)
  await store.action(taskType, action, '医生已完成结果复核')
}

function handleWriteBack() {
  if (activeTask.value === 'record_generation' || activeTask.value === 'diagnosis_management') {
    return store.writeBack(activeTask.value)
  }
}

watch(
  () => store.patient?.patient_id,
  (patientId) => {
    if (patientId) void runPanel('analysis')
  },
  { immediate: true },
)

watch(
  () => store.workspacePanel,
  (panel) => void runPanel(panel),
)
</script>

<template>
  <main class="agent-workspace">
    <div class="panel-title"><span class="status-dot"></span> AI 助手 <span class="panel-close">×</span></div>
    <nav class="feature-tabs" aria-label="一期功能">
      <button v-for="item in tabs" :key="item.id" :class="{ active: store.workspacePanel === item.id }" @click="selectPanel(item.id)">
        {{ item.label }}
        <span v-if="item.id === 'diagnosis'">3</span>
        <i v-if="item.id === 'comorbidity'">营</i>
      </button>
    </nav>

    <section v-if="!store.patient" class="empty-workspace">
      <div class="welcome-card">
        <h2>欢迎使用医生智能体</h2>
        <p>通过语音或文字交互完成门诊辅助工作。绑定当前患者后，系统将自动准备病情概况与鉴别诊断。</p>
        <div class="welcome-grid">
          <div><b>🗣</b><strong>语音指令接诊</strong><span>说“接诊下一位”或输入患者姓名</span></div>
          <div><b>🖊</b><strong>语音问诊</strong><span>绑定患者后开始可复核问诊</span></div>
          <div><b>💬</b><strong>文字交互</strong><span>在右侧输入姓名或就诊号</span></div>
          <div><b>📊</b><strong>AI 分析</strong><span>病情概况、诊断、风险与共病</span></div>
        </div>
      </div>
    </section>

    <section v-else class="feature-content">
      <button v-if="!['archive', 'timeline'].includes(store.workspacePanel)" class="refresh-link" @click="rerun">↻ 重新生成</button>

      <ClinicalAnalysisResult
        v-if="store.workspacePanel === 'analysis'"
        :summary-task="store.tasks.condition_summary"
        :differential-task="store.tasks.differential_diagnosis"
        :record-task="store.tasks.record_generation"
        :summary-error="store.taskErrors.condition_summary"
        :differential-error="store.taskErrors.differential_diagnosis"
        :record-error="store.taskErrors.record_generation"
        @risk-alert="openRiskAlert"
      />

      <RiskManagementResult
        v-else-if="store.workspacePanel === 'risk'"
        :task="store.tasks.risk_management"
        :error="store.taskErrors.risk_management"
        @action="handleAction('risk_management', $event)"
      />

      <TreatmentPlanResult
        v-else-if="store.workspacePanel === 'treatment'"
        :content="store.tasks.condition_summary?.result?.content"
      />

      <section v-else-if="store.workspacePanel === 'record' && !store.tasks.voice_interview?.result" class="state-card record-waiting-state">
        <strong>尚未完成语音问诊</strong>
        <span>请从右侧“医生智能体”开始语音问诊。医患对话完成后，系统才会自动生成电子病历草稿。</span>
      </section>

      <section v-else-if="store.workspacePanel === 'archive'" class="reference-panel">
        <h3>健康档案</h3>
        <dl>
          <dt>本次主诉</dt><dd>{{ store.patient.chief_complaint }}</dd>
          <dt>既往诊断</dt><dd>{{ (store.patient.facts.diagnoses as string[])?.join('；') || '暂无可用资料' }}</dd>
          <dt>当前用药</dt><dd>{{ (store.patient.facts.medications as string[])?.join('；') || '待医生补充' }}</dd>
          <dt>过敏史</dt><dd>{{ store.patient.allergy }}</dd>
        </dl>
      </section>

      <section v-else-if="store.workspacePanel === 'timeline'" class="reference-panel timeline-panel">
        <h3>本次诊疗时间轴</h3>
        <p><time>08:30</time><span>医生进入本次接诊</span></p>
        <p><time>08:31</time><span>系统完成患者与就诊上下文校验</span></p>
        <p><time>08:32</time><span>生成 AI 病情概要与鉴别诊断</span></p>
      </section>

      <TaskResult
        v-else-if="activeTask"
        :task-type="activeTask"
        :task="store.tasks[activeTask]"
        :error="store.taskErrors[activeTask]"
        :receipt="store.writeBackReceipts?.[activeTask]"
        @action="handleAction(activeTask, $event)"
        @writeback="handleWriteBack"
      />
    </section>
  </main>
</template>
