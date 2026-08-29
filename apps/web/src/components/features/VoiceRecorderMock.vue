<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type { Patient } from '../../types'

type InterviewState = 'idle' | 'recording' | 'paused' | 'finished'
type Speaker = 'doctor' | 'patient'

interface DialogueTurn {
  speaker: Speaker
  text: string
  source?: 'transcript' | 'supplemental_observation'
}

interface FollowupHint {
  text: string
  suggestion: string
  completeAfter: number
}

const props = withDefaults(defineProps<{
  patient?: Patient
  compact?: boolean
  autostart?: boolean
  generationState?: 'idle' | 'generating' | 'ready' | 'failed'
}>(), {
  compact: false,
  autostart: false,
  generationState: 'idle',
})
const emit = defineEmits<{
  start: []
  complete: [observations: string[]]
  reset: []
  observation: [text: string]
}>()

const state = ref<InterviewState>('idle')
const seconds = ref(0)
const visibleTurns = ref<DialogueTurn[]>([])
const scriptedTurnsShown = ref(0)
const observationPanelOpen = ref(false)
const selectedObservations = ref<string[]>([])
let clockTimer: number | undefined
let turnTimer: number | undefined
let completed = false

function firstFact(keys: string[], fallback: string) {
  const facts = props.patient?.facts || {}
  for (const key of keys) {
    const value = facts[key]
    if (Array.isArray(value) && value.length) return value.slice(0, 2).join('；')
    if (value && typeof value === 'string') return value
  }
  return fallback
}

const dialogue = computed<DialogueTurn[]>(() => {
  const patient = props.patient
  const complaint = patient?.chief_complaint || '最近身体不舒服'
  const allergy = patient?.allergy || '目前还不清楚'
  const specialty = patient?.specialty || ''

  if (specialty.includes('骨科')) {
    return [
      { speaker: 'doctor', text: `您好，${patient?.name || ''}。请说一下这次最不舒服的地方。` },
      { speaker: 'patient', text: complaint },
      { speaker: 'doctor', text: '疼痛是怎么开始的？活动、休息或体位变化时有什么不同？' },
      { speaker: 'patient', text: firstFact(['symptoms'], '活动后更明显，休息后会稍微缓解。') },
      { speaker: 'doctor', text: '有没有下肢无力、麻木加重、大小便异常或会阴区感觉异常？' },
      { speaker: 'patient', text: firstFact(['red_flags'], '没有大小便异常，腿也没有明显无力。') },
      { speaker: 'doctor', text: '近期用过哪些药？是否服用抗凝药？药物过敏史再确认一下。' },
      { speaker: 'patient', text: `${firstFact(['medications'], '近期没有规律服用止痛药')}。过敏史：${allergy}。` },
    ]
  }

  if (specialty.includes('妇科')) {
    return [
      { speaker: 'doctor', text: `您好，${patient?.name || ''}。请描述一下这次腹痛或出血的情况。` },
      { speaker: 'patient', text: complaint },
      { speaker: 'doctor', text: '末次月经是什么时候？目前有没有怀孕可能，近期是否做过妊娠检测？' },
      { speaker: 'patient', text: firstFact(['conflicts'], '月经周期最近有变化，妊娠情况还需要确认。') },
      { speaker: 'doctor', text: '出血量大概多少？有没有单侧腹痛、头晕晕厥或肩部疼痛？' },
      { speaker: 'patient', text: firstFact(['red_flags', 'missing'], '有些头晕，没有晕倒，腹痛需要继续观察。') },
      { speaker: 'doctor', text: '我再确认一下既往妇科病史、目前用药和药物过敏史。' },
      { speaker: 'patient', text: `目前能确认的过敏史是：${allergy}。` },
    ]
  }

  return [
    { speaker: 'doctor', text: `您好，${patient?.name || ''}。请描述一下这次最主要的不舒服。` },
    { speaker: 'patient', text: complaint },
    { speaker: 'doctor', text: '这种情况从什么时候开始？最近用药是否规律，有没有自行调整剂量？' },
    { speaker: 'patient', text: firstFact(['medications', 'conflicts'], '大约两周前开始，药物基本按原来的处方服用。') },
    { speaker: 'doctor', text: '最近有没有出汗心慌、胸闷、视物模糊，或者饮水和尿量明显变化？' },
    { speaker: 'patient', text: firstFact(['red_flags', 'exams'], '最近口渴比较明显，没有胸痛，也没有晕厥。') },
    { speaker: 'doctor', text: '还有哪些检查结果需要补充？药物过敏史再确认一下。' },
    { speaker: 'patient', text: `${firstFact(['missing'], '近期检查资料已经带来')}。过敏史：${allergy}。` },
  ]
})

const followupHints = computed<FollowupHint[]>(() => {
  const specialty = props.patient?.specialty || ''
  if (specialty.includes('骨科')) {
    return [
      { text: '疼痛起因、部位和活动关系', suggestion: '疼痛是突然出现还是逐渐加重？活动和休息时分别怎样？', completeAfter: 4 },
      { text: '神经受压红旗征象', suggestion: '有没有下肢无力、大小便异常或鞍区麻木？', completeAfter: 6 },
      { text: '抗凝用药及操作风险', suggestion: '是否正在服用抗凝药？最近一次服药是什么时候？', completeAfter: 8 },
    ]
  }
  if (specialty.includes('妇科')) {
    return [
      { text: '末次月经及妊娠可能', suggestion: '末次月经是什么时候？是否做过妊娠检测？', completeAfter: 4 },
      { text: '出血量与失血症状', suggestion: '出血量大约多少？有没有心悸、头晕或晕厥？', completeAfter: 6 },
      { text: '异位妊娠危险症状', suggestion: '是否有单侧腹痛、肩痛或突然加重？', completeAfter: 8 },
    ]
  }
  return [
    { text: '起病时间与症状变化', suggestion: '这些症状从什么时候开始？是持续还是间断出现？', completeAfter: 4 },
    { text: '用药依从性及剂量变化', suggestion: '近期有没有漏服或自行调整药物剂量？', completeAfter: 6 },
    { text: '低血糖及并发症症状', suggestion: '有没有出汗心慌、视物模糊或尿量变化？', completeAfter: 8 },
  ]
})

const supplementalObservationOptions = computed(() => {
  const specialty = props.patient?.specialty || ''
  if (specialty.includes('骨科')) {
    return [
      '患者步态缓慢，负重时疼痛加重',
      '患侧关节活动范围受限',
      '近期下肢偶有麻木感',
      '双下肢肌力基本对称',
      '未观察到明显肢体肿胀',
      '患者目前使用助行器',
      '疼痛影响夜间睡眠',
    ]
  }
  if (specialty.includes('妇科')) {
    return [
      '患者面色稍苍白',
      '下腹部压痛情况待查',
      '当前无晕厥表现',
      '出血量仍需进一步量化',
      '患者步入诊室时生命体征平稳',
      '近期乏力较前明显',
      '患者对妊娠可能表述不确定',
    ]
  }
  return [
    '血糖控制欠佳，主食偏多',
    '近1周偶有漏服降糖药',
    '近期足部偶有轻微麻木感',
    '自述视力无明显变化',
    '患者治疗依从性良好',
    '近期睡眠质量尚可，无失眠',
    '饮食规律，二便正常',
  ]
})

const timeLabel = computed(() => `${String(Math.floor(seconds.value / 60)).padStart(2, '0')}:${String(seconds.value % 60).padStart(2, '0')}`)
const activeHint = computed(() => followupHints.value.find((hint) => scriptedTurnsShown.value < hint.completeAfter))

function clearTimers() {
  if (clockTimer) window.clearInterval(clockTimer)
  if (turnTimer) window.clearTimeout(turnTimer)
  clockTimer = undefined
  turnTimer = undefined
}

function scheduleNextTurn() {
  if (state.value !== 'recording') return
  turnTimer = window.setTimeout(() => {
    if (state.value !== 'recording') return
    if (scriptedTurnsShown.value < dialogue.value.length) {
      visibleTurns.value.push({ ...dialogue.value[scriptedTurnsShown.value], source: 'transcript' })
      scriptedTurnsShown.value += 1
      scheduleNextTurn()
      return
    }
    finish()
  }, 1050)
}

function startClock() {
  clockTimer = window.setInterval(() => (seconds.value += 1), 1000)
}

function start() {
  clearTimers()
  completed = false
  seconds.value = 0
  scriptedTurnsShown.value = 1
  visibleTurns.value = [{ ...dialogue.value[0], source: 'transcript' }]
  observationPanelOpen.value = false
  selectedObservations.value = []
  state.value = 'recording'
  emit('start')
  startClock()
  scheduleNextTurn()
}

function pause() {
  clearTimers()
  state.value = 'paused'
}

function resume() {
  state.value = 'recording'
  startClock()
  scheduleNextTurn()
}

function finish() {
  clearTimers()
  if (completed) return
  completed = true
  observationPanelOpen.value = false
  state.value = 'finished'
  emit('complete', [...selectedObservations.value])
}

function reset() {
  clearTimers()
  completed = false
  seconds.value = 0
  scriptedTurnsShown.value = 0
  visibleTurns.value = []
  observationPanelOpen.value = false
  selectedObservations.value = []
  state.value = 'idle'
  emit('reset')
}

function addSupplementalObservation(text: string) {
  if (selectedObservations.value.includes(text)) return
  selectedObservations.value.push(text)
  visibleTurns.value.push({ speaker: 'doctor', text: `【补充观察】${text}`, source: 'supplemental_observation' })
  emit('observation', text)
}

function restart() {
  reset()
  start()
}

onMounted(() => {
  if (props.autostart) start()
})
onBeforeUnmount(clearTimers)
</script>

<template>
  <section v-if="compact" class="sidebar-voice-session" :class="state">
    <aside v-if="state !== 'finished'" class="followup-coach sidebar-followup-coach" aria-live="polite">
      <header><span class="pending-dot"></span><strong>AI 追问提示</strong></header>
      <div class="followup-list">
        <div
          v-for="(hint, index) in followupHints"
          :key="hint.text"
          class="followup-item"
          :class="{ done: scriptedTurnsShown >= hint.completeAfter, active: activeHint === hint }"
        >
          <span>{{ scriptedTurnsShown >= hint.completeAfter ? '✓' : index + 1 }}</span>
          <p>{{ hint.text }}</p>
        </div>
      </div>
      <div v-if="activeHint" class="followup-suggestion"><small>建议追问</small>{{ activeHint.suggestion }}</div>
      <div v-else class="followup-suggestion complete"><small>问诊完整性</small>关键问题已覆盖，可以结束问诊并生成病历。</div>
    </aside>

    <aside v-if="observationPanelOpen && state !== 'finished'" class="supplemental-observation-panel" aria-label="补充观察">
      <header><strong>补充观察</strong><button aria-label="关闭补充观察" @click="observationPanelOpen = false">×</button></header>
      <button
        v-for="item in supplementalObservationOptions"
        :key="item"
        class="observation-option"
        :class="{ selected: selectedObservations.includes(item) }"
        :disabled="selectedObservations.includes(item)"
        @click="addSupplementalObservation(item)"
      >
        <span>{{ selectedObservations.includes(item) ? '✓' : '＋' }}</span>{{ item }}
      </button>
    </aside>

    <section class="sidebar-conversation" aria-live="polite">
      <div v-for="(turn, index) in visibleTurns" :key="`${turn.speaker}-${index}`" class="sidebar-conversation-turn" :class="[turn.speaker, { observation: turn.source === 'supplemental_observation' }]">
        <strong>{{ turn.speaker === 'doctor' ? '医生' : '患者' }}<span v-if="turn.source === 'supplemental_observation'">补充观察</span></strong>
        <div class="sidebar-conversation-bubble">{{ turn.text }}</div>
      </div>
      <div v-if="state === 'recording' && scriptedTurnsShown < dialogue.length" class="conversation-typing"><i></i><i></i><i></i><span>正在识别下一段语音…</span></div>
    </section>

    <footer class="sidebar-interview-footer">
      <template v-if="state === 'recording'">
        <button class="pause" @click="pause">Ⅱ 暂停问诊</button>
        <button class="observation-toggle" :class="{ active: observationPanelOpen }" @click="observationPanelOpen = !observationPanelOpen">▣ 补充观察</button>
        <button @click="finish">■ 结束问诊</button>
      </template>
      <template v-else-if="state === 'paused'">
        <button class="resume" @click="resume">▶ 继续问诊</button>
        <button class="observation-toggle" :class="{ active: observationPanelOpen }" @click="observationPanelOpen = !observationPanelOpen">▣ 补充观察</button>
        <button @click="finish">■ 结束问诊</button>
      </template>
      <template v-else-if="state === 'finished'">
        <span>{{ generationState === 'generating' ? '正在根据问诊对话自动生成病历…' : generationState === 'failed' ? '病历生成未完成，请重试' : '问诊对话已完成，病历已经自动生成' }}</span>
        <button class="restart" @click="restart">🔄 重新问诊</button>
      </template>
    </footer>
  </section>

  <section v-else class="voice-recorder voice-interview-stage" :class="state">
    <header class="voice-stage-header">
      <div class="recorder-status">
        <span class="record-dot"></span>
        <div>
          <strong>{{ state === 'idle' ? '语音问诊尚未开始' : state === 'recording' ? '录音中 · AI 自动识别对话' : state === 'paused' ? '问诊已暂停' : '问诊对话已完成' }}</strong>
          <small>当前患者已锁定 · 演示音频不保存 · {{ timeLabel }}</small>
        </div>
        <div v-if="state === 'recording'" class="waveform"><i v-for="n in 16" :key="n" :style="{ animationDelay: `${n * 45}ms` }"></i></div>
      </div>
      <div class="recorder-actions">
        <button v-if="state === 'idle'" class="primary" @click="start">● 开始语音问诊</button>
        <button v-if="state === 'recording'" @click="pause">Ⅱ 暂停</button>
        <button v-if="state === 'paused'" class="primary" @click="resume">▶ 继续</button>
        <button v-if="state === 'recording' || state === 'paused'" @click="finish">■ 结束问诊</button>
        <button v-if="state === 'finished'" @click="reset">重新问诊</button>
      </div>
    </header>

    <div class="voice-live-layout">
      <aside class="followup-coach" aria-live="polite">
        <header><span class="pending-dot"></span><strong>AI 追问提示</strong></header>
        <div class="followup-list">
          <div
            v-for="(hint, index) in followupHints"
            :key="hint.text"
            class="followup-item"
            :class="{ done: scriptedTurnsShown >= hint.completeAfter, active: activeHint === hint }"
          >
            <span>{{ scriptedTurnsShown >= hint.completeAfter ? '✓' : index + 1 }}</span>
            <p>{{ hint.text }}</p>
          </div>
        </div>
        <div v-if="state === 'idle'" class="followup-suggestion">开始问诊后，系统会根据患者回答动态提醒漏问项。</div>
        <div v-else-if="activeHint" class="followup-suggestion"><small>下一句建议</small>{{ activeHint.suggestion }}</div>
        <div v-else class="followup-suggestion complete"><small>问诊完整性</small>关键问题已覆盖，可以结束问诊并生成病历。</div>
      </aside>

      <section class="live-conversation" aria-live="polite">
        <header><strong>实时对话转写</strong><span>{{ scriptedTurnsShown }} / {{ dialogue.length }} 轮</span></header>
        <div v-if="!visibleTurns.length" class="conversation-empty">点击“开始语音问诊”，医生与患者对话将逐条出现。</div>
        <div v-for="(turn, index) in visibleTurns" :key="`${turn.speaker}-${index}`" class="conversation-turn" :class="turn.speaker">
          <span class="conversation-avatar">{{ turn.speaker === 'doctor' ? '医' : '患' }}</span>
          <div><strong>{{ turn.speaker === 'doctor' ? '医生' : '患者' }}</strong><p>{{ turn.text }}</p></div>
          <time>{{ String(index * 4).padStart(2, '0') }}s</time>
        </div>
        <div v-if="state === 'recording' && scriptedTurnsShown < dialogue.length" class="conversation-typing"><i></i><i></i><i></i><span>正在识别下一段语音…</span></div>
      </section>
    </div>

    <footer v-if="state === 'finished'" class="voice-complete-note">问诊对话已完成，正在自动生成电子病历。</footer>
  </section>
</template>
