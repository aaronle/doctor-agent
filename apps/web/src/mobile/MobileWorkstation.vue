<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import MobileAnalysis from './MobileAnalysis.vue'
import MobileMenu from './MobileMenu.vue'
import MobileRecords from './MobileRecords.vue'
import MobileInterviewSheet from './MobileInterviewSheet.vue'
import type { MenuAction, RecordSegment } from './types'
import MobileBoardSheet from './MobileBoardSheet.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import { useCopilotChat } from '../composables/useCopilotChat'
import { FONT_LEVELS } from '../composables/useFontScale'
import { usePreferences } from '../composables/usePreferences'
import { useTelemetry } from '../composables/useTelemetry'
import { useInterview } from '../composables/useInterview'
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

type Pane = '医生智能体' | 'AI 助手' | '记录'
const pane = ref<Pane>('医生智能体')

const menuOpen = ref(false)
const voiceOpen = ref(false)
const promptsOpen = ref(false)

/** 跳转到分析页某一块 / 记录页某一段时带过去的目标 */
const analysisFocus = ref('')
const recordSegment = ref<RecordSegment | ''>('')

const patient = computed(() => ws.patient)
const summary = computed(() => ws.summary)

const voice = useInterview(() => ws.patientId)

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
    pane.value = '医生智能体'
  },
)

/** 未读角标：红色风险未处置的条数，落在「分析」上 */
const analysisBadge = computed(() => ws.openRedAlerts.length)

const unlocking = ref(false)

const { track } = useTelemetry()
const prefs = usePreferences()

/* ------------------------------------------------------------------ 安全条
 *
 * 过敏与未处置红线是**永远该在场**的信息。移动端此前连过敏标记都没有 ——
 * 而医生同样会看着这一屏开药。
 *
 * 钉在顶栏之下、内容之上：随内容滚走的安全提示，等于在最需要的时候不在。
 * 两样都没有时整条不渲染 —— 留一条空壳会让它退化成背景。
 */
const allergyText = computed(() => {
  const p = patient.value as { allergies?: unknown; allergy_status?: string } | null
  const list = Array.isArray(p?.allergies) ? p!.allergies.filter(Boolean).map(String) : []
  if (list.length) return list.join('、')
  // 「问过、没有」与「没问过」是两件事，后者要提醒补采
  return p?.allergy_status === 'unknown' ? '过敏史未采集' : ''
})
const openRedCount = computed(() => ws.openRedAlerts.length)
const showSafeBar = computed(() => !!allergyText.value || openRedCount.value > 0)
const safeDetail = computed(() =>
  ws.openRedAlerts.slice(0, 2).map((a) => a.name).join(' · '),
)

/* ------------------------------------------------------------------ 字号
 *
 * 常驻在顶栏，不藏进「⋯」。看不清是**当场**的障碍，
 * 多一次点击就会有人放弃，然后一直眯着眼用。
 *
 * 走 `usePreferences` 而不是自己写 localStorage —— 与桌面端同一份偏好，
 * 各存各的必然会漂。
 */
const fontOpen = ref(false)
const fontLevels = FONT_LEVELS
const fontLevel = computed(() => prefs.prefs.value.font_level)
function pickFont(key: string) {
  void prefs.update({ font_level: key })
  track('font_change', key, { surface: 'mobile' })
  fontOpen.value = false
}

/* --------------------------------------------------------------- 回程条
 *
 * 生成完自动切到分析页，此前**没有任何交代** —— 医生只看到界面自己变了。
 * 给一条能点回去的路标。
 *
 * **只在自动切换后出现。** 手动点标签是医生自己的选择，
 * 再弹一条「回到对话」就成了常驻噪声。
 */
const backBarOpen = ref(false)
let backBarTimer: ReturnType<typeof setTimeout> | null = null
function showBackBar() {
  backBarOpen.value = true
  if (backBarTimer) clearTimeout(backBarTimer)
  // 3 秒后淡出：底部标签栏一直在，路标本身不必常驻
  backBarTimer = setTimeout(() => { backBarOpen.value = false }, 3000)
}
function backToChat() {
  backBarOpen.value = false
  if (backBarTimer) { clearTimeout(backBarTimer); backBarTimer = null }
  switchPane('医生智能体')
}

const boardOpen = ref(false)
const settingsOpen = ref(false)

/** 切档统一走这里 —— 埋点只写一处，免得新加的入口漏记 */
function switchPane(next: Pane) {
  if (pane.value !== next) track('pane_switch', next)
  pane.value = next
  backBarOpen.value = false
}

/** 打开问诊面板并起播。多处入口共用一份，避免各写各的起播条件。 */
function openVoice() {
  voiceOpen.value = true
  if (voice.state.value === 'idle') void voice.start()
}

/**
 * 跳过问诊。与桌面端同一条路径、同一套后果说明。
 *
 * 移动端一度漏了整个门禁 —— 结果是对话页 0 张开场卡（空白屏）、
 * 分析页八块全 0 且没有任何解释，医生只会以为「跑失败了」。
 */
async function skipInterview() {
  try {
    await ElMessageBox.confirm(
      '将只用 HIS 已有资料生成分析，不含本次问诊内容。结果会标注「未含问诊」，' +
        '病历草稿里无出处的段落一律写「未采集」。随后仍可开始问诊，问完重算一次。',
      '跳过问诊，直接生成分析？',
      { confirmButtonText: '跳过并生成', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  unlocking.value = true
  try {
    await ws.unlockAndAnalyse('skipped')
  } catch (error) {
    ElMessage.error(`生成失败：${(error as Error).message}`)
  } finally {
    unlocking.value = false
  }
}

// ------------------------------------------------------------------ 开场卡片

/**
 * 开场卡片：打开患者时系统已经算好的病情概要与风险，直接推进对话流。
 *
 * 这些不是伪造的聊天记录 —— 它们是 report-summary 的真实产出，只是换了
 * 呈现位置。桌面端它们在标签页里等医生去点；手机上医生一进来就该看到。
 */
/** 摘要截断长度。开场卡的作用是「有几件事」，不是读全文 —— 细节在「逐条查看」里 */
const BRIEF_MAX = 22
/** 问题清单先摊几条。三条是「一眼扫完」与「有信息量」的折中 */
const PROBLEM_HEAD = 3
/** 结论一句话的上限。超过就截断 —— 手机上一屏读不完的「一句话」不叫结论 */
const LEAD_MAX = 42

/**
 * 取第一句当结论。
 *
 * 模型给的 `overall_conclusion.summary` 是**整段**（P009 实测 300+ 字）。
 * 第一版把它整段放进 lead 还加了粗，实测在 390px 下铺满整屏 ——
 * 加粗放大的是「已经太长」这件事。全文并没有丢，在「查看完整分析」里。
 */
function firstSentence(text = '') {
  const t = String(text).replace(/\s+/g, ' ').trim()
  const cut = t.indexOf('。')
  if (cut > 0 && cut + 1 <= LEAD_MAX) return t.slice(0, cut + 1)
  return t.length > LEAD_MAX ? `${t.slice(0, LEAD_MAX)}…` : t
}

function brief(text = '') {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > BRIEF_MAX ? `${t.slice(0, BRIEF_MAX)}…` : t
}

/**
 * 开场卡。
 *
 * **2026-09-07 重排**：原来两张卡都是纯文本行 —— 概要是一整段 300 字，
 * 风险只有孤零零几个名字。前者在手机上没法读，后者看不出哪条更急、为什么急。
 *
 * 改法遵守原来那条取舍（卡片不能变长文）：
 * 概要摊成「一句结论 + 前三条要点」，风险给**色点 + 一行截断摘要**。
 * 色点用后端给的 `color`，不在前端另排一套映射。
 */
const openingCards = computed(() => {
  type Item = { text: string; sub?: string; color?: string }
  const cards: {
    key: string; title: string; tone: string; lead?: string;
    bullets: Item[]; rest: number; actions: { text: string; focus: string }[]
  }[] = []
  const s = summary.value
  if (!s) return cards

  const conclusion = s.overall_conclusion ?? {}
  const problems = (conclusion.problems ?? []) as string[]
  const conflicts = (conclusion.conflicts ?? []) as string[]
  const lead = firstSentence(conclusion.summary ?? '')
  // 信息冲突单独成条并标红：它是**矛盾**，不是概要的一部分，
  // 混进那段话里会被当成叙述读过去
  const conflictItems = conflicts.map((c) => ({ text: `信息冲突：${brief(c)}`, color: 'danger' }))
  if (lead || problems.length || conflictItems.length) {
    cards.push({
      key: 'summary',
      title: '病情概要',
      tone: conclusion.risk_level ?? '',
      lead: lead || undefined,
      bullets: [...conflictItems, ...problems.slice(0, PROBLEM_HEAD).map((t) => ({ text: brief(t) }))],
      rest: problems.length + conflictItems.length,
      actions: [{ text: '查看完整分析', focus: '病情概要' }],
    })
  }

  const alerts = s.risk_alerts ?? []
  if (alerts.length) {
    cards.push({
      key: 'risk',
      title: '风险提示',
      tone: alerts[0]?.level ?? '高风险',
      bullets: alerts.map((a) => ({
        text: a.name ?? '',
        sub: brief(a.summary ?? ''),
        color: a.color || (String(a.level).includes('高') ? 'danger' : 'warning'),
      })),
      rest: 0,
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

function goAnalysis(focus = '') {
  analysisFocus.value = focus
  const auto = focus === 'auto'
  track('go_analysis', auto ? 'auto' : focus || 'card')
  pane.value = 'AI 助手'
  // 自动切走才给路标；手动切是医生自己的选择
  if (auto) showBackBar()
  else backBarOpen.value = false
}

function goRecords(segment: RecordSegment) {
  recordSegment.value = segment
  switchPane('记录')
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
  { icon: '💬', label: '问诊记录', run: openVoice },
  { icon: '🔍', label: '鉴别诊断', run: () => goAnalysis('鉴别诊断') },
  { icon: '➡️', label: '接诊下一位', run: nextPatient },
]

/** 看板里点某位患者：切过去并关掉弹层 —— 看板讲的是「这一屏」，选完就该退回「这一位」 */
function onBoardPick(patientId: string) {
  boardOpen.value = false
  track('board_pick', patientId)
  if (patientId !== ws.patientId) router.push(`/outpatient/${patientId}`)
}

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
      openVoice()
      break
    case 'prompts':
      promptsOpen.value = true
      break
    case 'route':
      router.push(action.to)
      break
    case 'send':
      pane.value = '医生智能体'
      void sendChat(action.text)
      break
    case 'board':
      track('board_open', 'mobile')
      boardOpen.value = true
      break
    case 'settings':
      track('settings_open', 'mobile_menu')
      settingsOpen.value = true
      break
  }
}

function pickPrompt(text: string) {
  chatInput.value = text
  promptsOpen.value = false
  pane.value = '医生智能体'
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
      <!--
        字号。常驻在顶栏，**不藏进「⋯」** —— 看不清是当场的障碍，
        多一次点击就会有人放弃，然后一直眯着眼用。
      -->
      <button class="m-font-btn" type="button" aria-label="调整字号" @click="fontOpen = true">Aa</button>
      <button class="m-more m-more-btn" type="button" aria-label="更多功能" @click="menuOpen = true">⋯</button>
    </div>

    <!--
      安全条：过敏 + 未处置红线。钉在顶栏之下、内容之上，**不随内容滚走** ——
      随内容滚走的安全提示，等于在最需要的时候不在。
      两样都没有时整条不渲染：留一条空壳会让它退化成背景。
    -->
    <div v-if="showSafeBar" class="m-safebar" @click="goAnalysis('预警评估')">
      <i class="m-safebar-bar" />
      <div class="m-safebar-text">
        <span class="m-safebar-title">
          <template v-if="allergyText">⚠ {{ allergyText }}</template>
          <template v-if="allergyText && openRedCount"> · </template>
          <template v-if="openRedCount">{{ openRedCount }} 条红线未处置</template>
        </span>
        <span v-if="safeDetail" class="m-safebar-sub">{{ safeDetail }}</span>
      </div>
      <span class="m-safebar-go">›</span>
    </div>

    <!-- 回程条：只在**自动**切到分析后出现，3 秒淡出 -->
    <button v-if="backBarOpen && pane === 'AI 助手'" class="m-backbar" type="button" @click="backToChat">
      <span class="m-backbar-ok">✓</span>
      <span class="m-backbar-text">
        <b>已根据本次问诊生成分析</b>
        <i>对话 {{ ws.interviewTurns || 0 }} 轮 · 六个岗位并发</i>
      </span>
      <span class="m-backbar-btn">回到对话</span>
    </button>

    <!-- 对话 -->
    <template v-if="pane === '医生智能体'">
      <div ref="chatScrollEl" class="m-body">
        <div class="m-chat">
          <div v-for="card in openingCards" :key="card.key" class="m-msg ai">
            <span class="m-role">AI</span>
            <div class="m-card" :data-card="card.key">
              <div class="m-card-head">
                <span class="m-card-title">{{ card.title }}</span>
                <span v-if="card.tone" class="m-tone" :class="toneClass(card.tone)">{{ card.tone }}</span>
              </div>
              <p v-if="card.lead" class="m-card-lead">{{ card.lead }}</p>
              <div v-for="(b, i) in card.bullets" :key="i" class="m-card-bullet">
                <i v-if="b.color" class="m-card-dot" :class="b.color" />
                <i v-else class="m-card-tick">·</i>
                <span class="m-card-btext">
                  <b>{{ b.text }}</b>
                  <span v-if="b.sub" class="m-card-sub">{{ b.sub }}</span>
                </span>
              </div>
              <button
                v-if="card.rest > card.bullets.length"
                class="m-card-more"
                type="button"
                @click="goAnalysis('病情概要')"
              >展开全部 {{ card.rest }} 项 ⌄</button>
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

          <!--
            未解锁时的开场。不给空白屏 —— 医生进来第一眼必须知道
            「现在该做什么」，而不是对着一片空白猜。
          -->
          <div v-if="!ws.analysisUnlocked" class="m-msg ai">
            <span class="m-role">AI</span>
            <div class="m-card">
              <div class="m-card-head">
                <span class="m-card-title">🔒 先问诊，再出分析</span>
              </div>
              <p class="m-card-line">
                病情概要、鉴别诊断、共病、病历草稿是模型基于本次问诊推断的。
                问诊前给出结论会让医生先看到答案再去找证据 —— 那是锚定，不是辅助。
              </p>
              <p class="m-card-line">
                检查检验、健康档案、时间轴与硬规则红线不受影响，「记录」页现在就能看。
              </p>
              <div class="m-card-actions">
                <button class="m-cbtn" type="button" @click="openVoice">● 开始问诊</button>
                <button class="m-cbtn" type="button" :disabled="unlocking" @click="skipInterview">
                  {{ unlocking ? '生成中…' : '跳过问诊，直接分析' }}
                </button>
              </div>
            </div>
          </div>

          <!-- 解锁但跳过的，如实标出来 -->
          <div v-else-if="!ws.interviewIncluded" class="m-msg ai">
            <span class="m-role">AI</span>
            <div class="m-card">
              <div class="m-card-head">
                <span class="m-card-title">未含问诊</span>
                <span class="m-tone mid">仅基于 HIS 资料</span>
              </div>
              <p class="m-card-line">这份分析没有听过患者本次陈述。可随时开始问诊，问完重算一次。</p>
              <div class="m-card-actions">
                <button class="m-cbtn" type="button" @click="openVoice">● 开始问诊</button>
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
    <div v-else-if="pane === 'AI 助手'" class="m-body">
      <MobileAnalysis :focus="analysisFocus" />
    </div>

    <!-- 记录 -->
    <div v-else class="m-body">
      <MobileRecords :segment="recordSegment" />
    </div>

    <div class="m-tabbar">
      <button class="m-tab" :class="{ active: pane === '医生智能体' }" type="button" @click="switchPane('医生智能体')">
        <span class="m-tab-icon">💬</span><span class="m-tab-label">医生智能体</span>
      </button>
      <button class="m-tab" :class="{ active: pane === 'AI 助手' }" type="button" @click="switchPane('AI 助手')">
        <span class="m-tab-icon">📊</span><span class="m-tab-label">AI 助手</span>
        <span v-if="analysisBadge" class="m-tab-badge">{{ analysisBadge }}</span>
      </button>
      <button class="m-tab" :class="{ active: pane === '记录' }" type="button" @click="switchPane('记录')">
        <span class="m-tab-icon">📁</span><span class="m-tab-label">记录</span>
      </button>
    </div>

    <MobileMenu :open="menuOpen" @close="menuOpen = false" @pick="onMenuPick" />
    <MobileInterviewSheet :open="voiceOpen" :voice="voice" @close="voiceOpen = false" />

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

    <!-- 字号弹层。选项本身就用对应字号显示 —— 选之前先看见效果，与桌面端一致 -->
    <template v-if="fontOpen">
      <div class="m-scrim" @click="fontOpen = false" />
      <div class="m-sheet m-font-sheet">
        <div class="m-grab" />
        <div class="m-sheet-head"><span class="m-sheet-title">界面字号</span></div>
        <div class="m-sheet-body">
          <button
            v-for="lv in fontLevels"
            :key="lv.key"
            class="m-font-opt"
            :class="{ on: lv.key === fontLevel }"
            type="button"
            :style="{ fontSize: `${14 * lv.scale}px` }"
            @click="pickFont(lv.key)"
          >
            <i class="m-font-ring" />
            <span class="m-font-name">{{ lv.label }}</span>
            <span class="m-font-pct">{{ Math.round(lv.scale * 100) }}%</span>
          </button>
          <!--
            预览里**必须有一条红的**：它当场证明状态色不随字号或主题变。
            与桌面端配置页放风险条是同一条理由。
          -->
          <div class="m-font-preview">
            <b>异常子宫出血致重度贫血</b>
            <span class="m-font-risk">● 危急值在任何字号下都保持红色</span>
          </div>
        </div>
      </div>
    </template>

    <MobileBoardSheet :open="boardOpen" @close="boardOpen = false" @pick="onBoardPick" />

    <!-- 个人配置。与桌面端复用同一个正文组件，两处各写一份必然会漂 -->
    <el-dialog v-model="settingsOpen" title="个人配置" width="94%" top="4vh" destroy-on-close>
      <SettingsPanel />
    </el-dialog>

    <el-dialog v-model="kbDialogOpen" :title="kbEntry?.title ?? '知识库'" width="92%">
      <div v-loading="kbLoading" class="m-kb-body">
        <!-- 正文是本仓库静态提供的结构化 HTML，无用户输入参与拼接 -->
        <div v-if="kbEntry" v-html="kbEntry.content" />
      </div>
    </el-dialog>
  </div>
</template>
