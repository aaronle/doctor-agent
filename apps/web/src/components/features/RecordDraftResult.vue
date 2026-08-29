<script setup lang="ts">
import { reactive } from 'vue'

const props = defineProps<{ content: Record<string, any>; receipt?: string }>()
const emit = defineEmits<{ writeback: [] }>()
const sections = reactive(props.content.sections.map((item: any) => ({ ...item, state: item.status, doctor_text: item.ai_text })))

function setState(section: any, state: string) { section.state = state }
</script>

<template>
  <div class="record-draft">
    <div class="quality-strip"><strong>病历完整度 {{ content.validation.score }}%</strong><span>{{ content.validation.message }}</span></div>
    <section v-for="section in sections" :key="section.section_id" class="record-section">
      <header><strong>{{ section.title }}</strong><span :class="section.state">{{ section.state }}</span></header>
      <textarea v-model="section.doctor_text" @input="setState(section, 'edited')"></textarea>
      <div class="section-meta">来源 {{ section.source_refs.length }} 项 · 医生编辑优先，不会被重新生成覆盖</div>
      <div class="section-actions"><button class="primary" @click="setState(section, 'accepted')">采纳本段</button><button @click="setState(section, 'edited')">标记已编辑</button><button @click="setState(section, 'rejected')">拒绝</button></div>
    </section>
    <div class="validation-issues"><strong>提交前检查</strong><span v-for="item in content.validation.issues" :key="item">{{ item }}</span></div>
    <div class="writeback-bar"><button class="primary" @click="emit('writeback')">确认并回写病历</button><span v-if="receipt">演示回执：{{ receipt }}</span><span v-else>正式写回前仍需医生确认</span></div>
  </div>
</template>
