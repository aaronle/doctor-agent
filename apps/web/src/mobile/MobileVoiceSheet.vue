<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'

import { useWorkstation } from '../stores/workstation'
import type { useVoiceInterview } from '../composables/useVoiceInterview'

/**
 * 语音问诊底部面板。
 *
 * 复用桌面端同一个 useVoiceInterview —— 状态机、追问清单的语义覆盖判定、
 * 补充观察的去重，全都是同一份实现。手机上只是换了呈现：
 * 桌面把「追问提示」和「补充观察」做成两个悬浮层，手机没有那个空间，
 * 改为面板内两段。
 *
 * 「结束问诊」会把问诊记录落库并重算分析 —— 写的是本系统的库，
 * 不触达 HIS/EMR，所以手机上允许。病历草稿的重新生成留在工作站。
 */

const props = defineProps<{ open: boolean; voice: ReturnType<typeof useVoiceInterview> }>()
const emit = defineEmits<{ close: [] }>()

const ws = useWorkstation()
const manualText = ref('')
const finishing = ref(false)

async function submitManual() {
  const text = manualText.value.trim()
  if (!text) return
  manualText.value = ''
  await props.voice.askManual(text)
}

/** 落库 + 重算分析。不在手机上重新起草病历 —— 那是要写进病历的动作。 */
async function finish() {
  if (finishing.value) return
  finishing.value = true
  try {
    await props.voice.finish()
    await ws.loadSummary(true)
    ElMessage.success('问诊已结束，分析已按本次内容更新')
  } catch (error) {
    ElMessage.error(`结束失败：${(error as Error).message}`)
  } finally {
    finishing.value = false
  }
}
</script>

<template>
  <template v-if="open">
    <div class="m-scrim" @click="emit('close')" />
    <div class="m-sheet">
      <div class="m-grab" />
      <div class="m-sheet-head">
        <span class="m-sheet-title">🎙 语音问诊</span>
        <span class="m-row-sub">{{ voice.state.value }}</span>
        <span class="m-spacer" />
        <button class="m-btn link" type="button" @click="emit('close')">收起</button>
      </div>

      <div class="m-sheet-body">
        <p v-if="voice.error.value" class="m-row m-row-sub">{{ voice.error.value }}</p>

        <div v-if="voice.state.value === 'idle'" class="m-group">
          <button class="m-btn primary" type="button" @click="voice.start()">开始问诊</button>
        </div>

        <div v-if="voice.messages.value.length" class="m-group">
          <span class="m-group-title">对话</span>
          <div
            v-for="(turn, i) in voice.messages.value"
            :key="i"
            class="m-voice-turn"
            :class="turn.role"
          >
            <span class="m-role">{{ turn.role === 'doctor' ? '医生' : '患者' }}</span>
            <span class="m-bubble">{{ turn.text || '…' }}</span>
          </div>
        </div>

        <div v-if="voice.pendingQuestions.value.length" class="m-group">
          <span class="m-group-title">AI 追问提示（点一条可手动勾销）</span>
          <!-- 覆盖判定由模型做，但医生随时能改 —— 最便宜的正确性兜底 -->
          <button
            v-for="q in voice.pendingQuestions.value"
            :key="q.index"
            class="m-check"
            :class="{ done: q.done }"
            type="button"
            @click="voice.toggleQuestionDone(q.index)"
          >
            <span>{{ q.done ? '☑' : '☐' }}</span>
            <span>{{ q.text }}<em v-if="q.evidence" class="m-row-sub"> · {{ q.evidence }}</em></span>
          </button>
          <p v-if="voice.coverageDegraded.value" class="m-row-sub">
            覆盖判定不可用，清单未自动勾销 —— 宁可冗余，也不错标「已问」。
          </p>
        </div>

        <div v-if="voice.observations.value.length" class="m-group">
          <span class="m-group-title">补充观察（勾选后计入问诊小结）</span>
          <button
            v-for="item in voice.observations.value"
            :key="item"
            class="m-check"
            :class="{ done: voice.pickedObservations.value.has(item) }"
            type="button"
            @click="voice.toggleObservation(item)"
          >
            <span>{{ voice.pickedObservations.value.has(item) ? '☑' : '☐' }}</span>
            <span>{{ item }}</span>
          </button>
        </div>

        <div class="m-group">
          <span class="m-group-title">手动补录患者所述</span>
          <input
            v-model="manualText"
            class="m-search"
            placeholder="输入患者所述，取下一句追问建议"
            @keyup.enter="submitManual"
          />
          <div class="m-pcard-foot">
            <button class="m-btn" type="button" :disabled="voice.manualThinking.value" @click="submitManual">
              {{ voice.manualThinking.value ? '生成中…' : '补问' }}
            </button>
            <button class="m-btn" type="button" @click="voice.resumeCapture()">继续问诊</button>
            <button class="m-btn primary" type="button" :disabled="finishing" @click="finish">
              {{ finishing ? '处理中…' : '结束问诊' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>
