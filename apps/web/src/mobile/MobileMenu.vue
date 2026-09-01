<script setup lang="ts">
/**
 * ＋ 菜单：手机端的功能全集。
 *
 * 分三组。第三组「写入 HIS/EMR」刻意**列出来但不可点** ——
 * 删掉的话医生会以为系统没有这些能力，而不是「这里不做、去工作站做」。
 * 灰显 + 「工作站专属」角标，说的是位置，不是缺失。
 */

import type { MenuAction } from './types'

interface Cell {
  icon: string
  label: string
  action?: MenuAction
}

const GROUPS: { title: string; cells: Cell[] }[] = [
  {
    title: '问诊与分析',
    cells: [
      { icon: '🎙', label: '语音问诊', action: { kind: 'voice' } },
      { icon: '📄', label: '报告解读', action: { kind: 'send', text: '请解读这位患者最近一次检查与检验报告，指出异常项及其临床意义。' } },
      { icon: '🔍', label: '鉴别诊断', action: { kind: 'analysis', focus: '鉴别诊断' } },
      { icon: '⚠️', label: '预警评估', action: { kind: 'analysis', focus: '预警评估' } },
      { icon: '🫀', label: '共病管理', action: { kind: 'analysis', focus: '共病管理' } },
      { icon: '📐', label: '专项评估', action: { kind: 'analysis', focus: '专项评估' } },
    ],
  },
  {
    title: '资料查阅',
    cells: [
      { icon: '📁', label: '健康档案', action: { kind: 'records', segment: '健康档案' } },
      { icon: '🕐', label: '就诊时间轴', action: { kind: 'records', segment: '时间轴' } },
      { icon: '💬', label: '常用提示词', action: { kind: 'prompts' } },
      { icon: '🧪', label: '检查检验', action: { kind: 'records', segment: '检查检验' } },
      { icon: '✅', label: '病历质控', action: { kind: 'analysis', focus: '病历质控' } },
      { icon: '👥', label: '患者管理', action: { kind: 'route', to: '/outpatient/manage' } },
    ],
  },
  {
    // 手机端一律不做的三件事。列出来是为了让医生知道它们在哪。
    title: '写入 HIS / EMR',
    cells: [
      { icon: '📝', label: '提交病历' },
      { icon: '🩺', label: '回写诊断' },
      { icon: '💊', label: '开立医嘱' },
    ],
  },
]

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; pick: [MenuAction] }>()

function choose(cell: Cell) {
  if (!cell.action) return
  emit('pick', cell.action)
}
</script>

<template>
  <template v-if="open">
    <div class="m-scrim" @click="emit('close')" />
    <div class="m-sheet">
      <div class="m-grab" />
      <div class="m-sheet-body">
        <div v-for="group in GROUPS" :key="group.title" class="m-group">
          <span class="m-group-title">{{ group.title }}</span>
          <div class="m-grid">
            <button
              v-for="cell in group.cells"
              :key="cell.label"
              class="m-cell"
              :class="{ locked: !cell.action }"
              type="button"
              :disabled="!cell.action"
              @click="choose(cell)"
            >
              <span class="m-cell-icon">{{ cell.icon }}</span>
              <span class="m-cell-label">{{ cell.label }}</span>
              <span v-if="!cell.action" class="m-cell-note">工作站专属</span>
            </button>
          </div>
        </div>

        <div class="m-tip">
          <span>ℹ️</span>
          <span>手机端不写入 HIS/EMR。以上三项请在门诊工作站完成。</span>
        </div>
      </div>
    </div>
  </template>
</template>
