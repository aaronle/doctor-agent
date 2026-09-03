<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'

import { useWorkstation } from '../stores/workstation'
import type { useInterview } from '../composables/useInterview'

/**
 * 问诊记录底部面板。
 *
 * 复用桌面端同一个 useInterview —— 状态机、追问清单的语义覆盖判定、
 * 全都是同一份实现。手机上只是换了呈现：
 * 桌面把问诊做成右栏悬浮，手机没有那个空间，
 * 改为面板内两段。
 *
 * 「结束问诊」会把问诊记录落库并重算分析 —— 写的是本系统的库，
 * 不触达 HIS/EMR，所以手机上允许。病历草稿的重新生成留在工作站。
 */

const props = defineProps<{ open: boolean; voice: ReturnType<typeof useInterview> }>()
const emit = defineEmits<{ close: [] }>()

const ws = useWorkstation()
const manualText = ref('')
const finishing = ref(false)

function submitManual() {
  const text = manualText.value.trim()
  if (!text) return
  manualText.value = ''
  props.voice.recordPatientUtterance(text)
}

/** 落库 + 重算分析。不在手机上重新起草病历 —— 那是要写进病历的动作。 */
async function finish() {
  if (finishing.value) return
  finishing.value = true
  try {
    await props.voice.finish()
    await ws.loadSummary(true)
    // 问诊结束就把这张单子收起来。留着它等于把「追问清单 / 补充观察 / 继续问诊」
    // 一起留在屏幕上 —— 那是一场已经结束的问诊的界面，看着像没结束。
    // 桌面端点「结束问诊」后收起浮层，是同一个道理。
    emit('close')
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
        <span class="m-sheet-title">💬 问诊记录</span>
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

        <div class="m-group">
          <span class="m-group-title">手动补录患者所述（只记录，不给追问建议）</span>
          <input
            v-model="manualText"
            class="m-search"
            placeholder="输入患者所述，记入本次问诊"
            @keyup.enter="submitManual"
          />
          <div class="m-pcard-foot">
            <button class="m-btn" type="button" @click="submitManual">记录</button>
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
