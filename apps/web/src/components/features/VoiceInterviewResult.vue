<script setup lang="ts">
import { reactive } from 'vue'

const props = defineProps<{ content: Record<string, any> }>()
const segments = reactive(props.content.transcript_segments.map((item: any) => ({ ...item, editing: false })))

function label(speaker: string) {
  return ({ doctor: '医生', patient: '患者', family: '家属', unknown: '主体待确认' } as Record<string, string>)[speaker] || speaker
}
</script>

<template>
  <div class="voice-result">
    <section class="transcript-panel">
      <h4>可复核转写 <small>演示音频 · {{ content.recording.duration_seconds }} 秒</small></h4>
      <div v-for="segment in segments" :key="segment.segment_id" class="transcript-row" :class="segment.speaker">
        <span class="speaker">{{ label(segment.speaker) }}</span>
        <span class="timestamp">{{ segment.started_at_seconds }}s</span>
        <input v-if="segment.editing" v-model="segment.text" @keyup.enter="segment.editing = false" />
        <p v-else>{{ segment.text }}</p>
        <span v-if="segment.confidence < 0.8" class="low-confidence">低置信 {{ Math.round(segment.confidence * 100) }}%</span>
        <button @click="segment.editing = !segment.editing">{{ segment.editing ? '完成' : '纠错' }}</button>
      </div>
    </section>
    <section class="structured-history">
      <h4>结构化病史</h4>
      <dl><template v-for="(value, key) in content.structured_history" :key="key"><dt>{{ key }}</dt><dd>{{ Array.isArray(value) ? value.join('；') : value }}</dd></template></dl>
      <div v-if="content.clarifications?.length" class="clarification-list"><strong>建议补充</strong><span v-for="item in content.clarifications" :key="item">{{ item }}</span></div>
    </section>
  </div>
</template>
