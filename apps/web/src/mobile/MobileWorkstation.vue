<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import MobileAnalysis from './MobileAnalysis.vue'
import MobileMenu from './MobileMenu.vue'
import MobileRecords from './MobileRecords.vue'
import MobileVoiceSheet from './MobileVoiceSheet.vue'
import type { MenuAction, RecordSegment } from './types'
import { useCopilotChat } from '../composables/useCopilotChat'
import { useVoiceInterview } from '../composables/useVoiceInterview'
import { useWorkstation } from '../stores/workstation'

/**
 * 移动端工作站。
 *
 * 桌面端是三层固定宽度的面板叠在一起；390px 宽里一次只能显示一个，
 * 所以改成底部三档切换：对话 / 分析 / 记录。
 *
 * **落地即对话**：进到患者第一屏是对话，不是表单。AI 的分析不藏在标签页里，
 * 开场就以卡片推进对话流，医生往下读、随手追问。桌面端把 Copilot 放在
 * 右侧固定栏，那条栏在手机上放不下，而对话恰恰是手机上最顺手的交互。
 *
 * **手机端不写 HIS/EMR**：提交病历、回写诊断、开立医嘱一律不提供，
 * 在 ＋ 菜单里灰显标注「工作站专属」。误触写进病历的代价太大，
 * 而「看 + 问 + 分析」正是手机擅长的部分。
 */

const ws = useWorkstation()
const router = useRouter()

type Pane = '对话' | '分析' | '记录'
const pane = ref<Pane>('对话')

const menuOpen = ref(false)
const voiceOpen = ref(false)
const promptsOpen = ref(false)

/** 跳转到分析页某一块 / 记录页某一段时带过去的目标 */
const analysisFocus = ref('')
const recordSegment = ref<RecordSegment | ''>('')

const patient = computed(() => ws.patient)
const summary = computed(() => ws.summary)

const voice = useVoiceInterview(() => ws.patientId)

const {
  chatInput,
  chatMessages,
  chatting,
  chatScrollEl,
  kbHits,
  kbDialogOpen,
  kbEntry,
  kbLoading,
  scrollToBottom,
  openKnowledge,
  sendChat,
} = useCopilotChat({ patientId: () => ws.patientId })

watch(() => chatMessages.value.length, scrollToBottom)

// 换患者时清空会话上下文：把上一位的对话留着，追问会带错上下文
watch(
  () => ws.patientId,
  () => {
    chatMessages.value = []
    chatInput.value = ''
    pane.value = '对话'
  },
)

/** 未读角标：红色风险未处置的条数，落在「分析」上 */
const analysisBadge = computed(() => ws.openRedAlerts.length)

// ------------------------------------------------------------------ 开场卡片

/**
 * 开场卡片：打开患者时系统已经算好的病情概要与风险，直接推进对话流。
 *
 * 这些不是伪造的聊天记录 —— 它们是 report-summary 的真实产出，只是换了
 * 呈现位置。桌面端它们在标签页里等医生去点；手机上医生一进来就该看到。
 */
const openingCards = computed(() => {
  const cards: { key: string; title: string; tone: string; lines: string[]; actions: { text: string; focus: string }[] }[] = []
  const s = summary.value
  if (!s) return cards

  const conclusion = s.overall_conclusion ?? {}
  const lines = [conclusion.summary, ...(conclusion.conflicts ?? []).map((c) => `信息冲突：${c}`)].filter(
    Boolean,
  ) as string[]
  if (lines.length) {
    cards.push({
      key: 'summary',
      title: '病情概要',
      tone: conclusion.risk_level ?? '',
      lines,
      actions: [{ text: '查看完整分析', focus: '病情概要' }],
    })
  }

  const alerts = s.risk_alerts ?? []
  if (alerts.length) {
    cards.push({
      key: 'risk',
      title: '风险提示',
      tone: alerts[0]?.level ?? '高风险',
      // 只列条目名。模型给的 summary 常有两三行，几条铺下来开场卡片就变成长文，
      // 而开场卡片的作用是让医生一眼看到「有几件事」，细节点「逐条查看」。
      lines: alerts.map((a) => `· ${a.name}`),
      actions: [{ text: '逐条查看', focus: '预警评估' }],
    })
  }
  return cards
})

function toneClass(level = '') {
  if (level.includes('高') || level.includes('红')) return 'high'
  if (level.includes('中') || level.includes('黄')) return 'mid'
  return 'low'
}

// ------------------------------------------------------------------ 导航

function goAnalysis(focus: string) {
  // 同一个目标连点两次也要能重新滚过去，所以先清空再赋值
  analysisFocus.value = ''
  pane.value = '分析'
  requestAnimationFrame(() => {
    analysisFocus.value = focus
  })
}

function goRecords(segment: RecordSegment) {
  recordSegment.value = segment
  pane.value = '记录'
}

/** 接诊下一位：按候诊队列顺序切，走到队尾回候诊列表 */
function nextPatient() {
  const list = ws.queue
  const index = list.findIndex((p) => p.id === ws.patientId)
  const next = index >= 0 ? list[index + 1] : list[0]
  if (next) router.push(`/outpatient/${next.id}`)
  else router.push('/outpatient/list')
}

const PROMPT_PRESETS = [
  '请根据检查结果给出初步诊断',
  '请分析患者的用药风险',
  '请评估该患者的并发症风险',
  '请生成门诊随访计划',
  '请解读最近一次血糖报告',
]

const QUICK_ACTIONS: { icon: string; label: string; run: () => void }[] = [
  { icon: '🎙', label: '语音问诊', run: () => { voiceOpen.value = true; if (voice.state.value === 'idle') void voice.start() } },
  { icon: '📄', label: '报告解读', run: () => void sendChat('请解读这位患者最近一次检查与检验报告，指出异常项及其临床意义。') },
  { icon: '🔍', label: '鉴别诊断', run: () => goAnalysis('鉴别诊断') },
  { icon: '➡️', label: '接诊下一位', run: nextPatient },
]

function onMenuPick(action: MenuAction) {
  menuOpen.value = false
  switch (action.kind) {
    case 'analysis':
      goAnalysis(action.focus)
      break
    case 'records':
      goRecords(action.segment)
      break
    case 'voice':
      voiceOpen.value = true
      if (voice.state.value === 'idle') void voice.start()
      break
    case 'prompts':
      promptsOpen.value = true
      break
    case 'route':
      router.push(action.to)
      break
    case 'send':
      pane.value = '对话'
      void sendChat(action.text)
      break
  }
}

function pickPrompt(text: string) {
  chatInput.value = text
  promptsOpen.value = false
  pane.value = '对话'
}

function showDegraded() {
  if (!ws.isDegraded) return
  ElMessage.warning(`${ws.degradedAgents.length} 个智能体已降级：${ws.degradedAgents.join('、')}`)
}
</script>

<template>
  <div class="m-page">
    <div class="m-topbar">
      <button class="m-back" type="button" aria-label="返回候诊列表" @click="router.push('/outpatient/list')">‹</button>
      <div class="m-who">
        <span class="m-who-name">{{ patient?.name ?? '—' }}</span>
        <span class="m-who-meta">
          {{ patient?.gender }} · {{ patient?.age }}岁 · {{ patient?.dept }}
          <template v-if="patient?.risk_level"> · {{ patient.risk_level }}</template>
        </span>
      </div>
      <span class="m-spacer" />
      <span v-if="ws.isDegraded" class="m-tag warn" @click="showDegraded">降级 {{ ws.degradedAgents.length }}</span>
      <!-- 只读徽标常驻：不说清楚，医生会一直找「提交病历」在哪 -->
      <span class="m-ro">👁 只读</span>
      <button class="m-more" type="button" aria-label="更多功能" @click="menuOpen = true">⋯</button>
    </div>

    <!-- 对话 -->
    <template v-if="pane === '对话'">
      <div ref="chatScrollEl" class="m-body">
        <div class="m-chat">
          <div v-for="card in openingCards" :key="card.key" class="m-msg ai">
            <span class="m-role">AI</span>
            <div class="m-card">
              <div class="m-card-head">
                <span class="m-card-title">{{ card.title }}</span>
                <span v-if="card.tone" class="m-tone" :class="toneClass(card.tone)">{{ card.tone }}</span>
              </div>
              <p v-for="(line, i) in card.lines" :key="i" class="m-card-line">{{ line }}</p>
              <div class="m-card-actions">
                <button
                  v-for="act in card.actions"
                  :key="act.text"
                  class="m-cbtn"
                  type="button"
                  @click="goAnalysis(act.focus)"
                >
                  {{ act.text }}
                </button>
              </div>
            </div>
          </div>

          <p v-if="ws.loadingSummary && !openingCards.length" class="m-empty">智能体分析中…</p>

          <div
            v-for="(message, index) in chatMessages"
            :key="index"
            class="m-msg"
            :class="message.role === 'user' ? 'user' : 'ai'"
          >
            <span class="m-role">{{ message.role === 'user' ? '医生' : 'AI' }}</span>
            <div class="m-bubble">
              <span v-if="message.content">{{ message.content }}</span>
              <span v-else class="m-typing">思考中…</span>
            </div>
            <div v-if="kbHits.get(index)?.length" class="m-kb">
              <button
                v-for="hit in kbHits.get(index)"
                :key="hit.key"
                class="m-kb-link"
                type="button"
                @click="openKnowledge(hit.key)"
              >
                {{ hit.title }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="m-qa">
        <button v-for="qa in QUICK_ACTIONS" :key="qa.label" class="m-qa-chip" type="button" @click="qa.run()">
          <span>{{ qa.icon }}</span><span>{{ qa.label }}</span>
        </button>
      </div>

      <div class="m-input-bar">
        <button class="m-round" type="button" aria-label="更多功能" @click="menuOpen = true">＋</button>
        <input
          v-model="chatInput"
          class="m-field"
          placeholder="向医生智能体提问…"
          @keyup.enter="sendChat()"
        />
        <button
          class="m-round primary"
          type="button"
          aria-label="发送"
          :disabled="chatting || !chatInput.trim()"
          @click="sendChat()"
        >
          ↑
        </button>
      </div>
    </template>

    <!-- 分析 -->
    <div v-else-if="pane === '分析'" class="m-body">
      <MobileAnalysis :focus="analysisFocus" />
    </div>

    <!-- 记录 -->
    <div v-else class="m-body">
      <MobileRecords :segment="recordSegment" />
    </div>

    <div class="m-tabbar">
      <button class="m-tab" :class="{ active: pane === '对话' }" type="button" @click="pane = '对话'">
        <span class="m-tab-icon">💬</span><span class="m-tab-label">对话</span>
      </button>
      <button class="m-tab" :class="{ active: pane === '分析' }" type="button" @click="pane = '分析'">
        <span class="m-tab-icon">📊</span><span class="m-tab-label">分析</span>
        <span v-if="analysisBadge" class="m-tab-badge">{{ analysisBadge }}</span>
      </button>
      <button class="m-tab" :class="{ active: pane === '记录' }" type="button" @click="pane = '记录'">
        <span class="m-tab-icon">📁</span><span class="m-tab-label">记录</span>
      </button>
    </div>

    <MobileMenu :open="menuOpen" @close="menuOpen = false" @pick="onMenuPick" />
    <MobileVoiceSheet :open="voiceOpen" :voice="voice" @close="voiceOpen = false" />

    <template v-if="promptsOpen">
      <div class="m-scrim" @click="promptsOpen = false" />
      <div class="m-sheet">
        <div class="m-grab" />
        <div class="m-sheet-head"><span class="m-sheet-title">常用提示词</span></div>
        <div class="m-sheet-body">
          <!-- 选中只填进输入框，不直接发出去 —— 与桌面端一致 -->
          <button v-for="text in PROMPT_PRESETS" :key="text" class="m-check" type="button" @click="pickPrompt(text)">
            <span>›</span><span>{{ text }}</span>
          </button>
        </div>
      </div>
    </template>

    <el-dialog v-model="kbDialogOpen" :title="kbEntry?.title ?? '知识库'" width="92%">
      <div v-loading="kbLoading" class="m-kb-body">
        <!-- 正文是本仓库静态提供的结构化 HTML，无用户输入参与拼接 -->
        <div v-if="kbEntry" v-html="kbEntry.content" />
      </div>
    </el-dialog>
  </div>
</template>
