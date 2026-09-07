<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { useSession } from '../stores/session'
import {
  FOLLOW_UP_LABELS,
  FONT_LABELS,
  THEME_LABELS,
  THEME_SWATCHES,
  usePreferences,
} from '../composables/usePreferences'

/**
 * 个人配置（移动端）。
 *
 * **另一套信息架构，不是桌面的响应式重排**：整屏纵向列表、每项一行、点进去选。
 *
 * **不显示「工作区布局」整组** —— 移动端没有可拖拽浮窗，那组对它没有意义。
 * 只留一句说明，告诉医生桌面端的布局记忆要在电脑上重置。
 *
 * 规格见 docs/product/12-移动端需求规格说明书.md 与 20-个人配置需求规格说明书.md §6.3。
 */

const session = useSession()
const p = usePreferences()
const { prefs, syncError, themes, fontLevels, followUpModes, load, update, resetAll } = p

/** 当前展开的二级页。null 表示在一级列表。 */
type Pane = 'theme' | 'font' | 'followUp'
const pane = ref<Pane | null>(null)

onMounted(() => load(session.doctorName))

const themeLabel = (k: string) => THEME_LABELS[k] ?? { name: k, desc: '' }
const followUpLabel = (k: string) => FOLLOW_UP_LABELS[k] ?? { name: k, desc: '' }
const swatch = (k: string) => THEME_SWATCHES[k] ?? ['#ccc', '#ddd', '#eee']

async function pick(kind: Pane, value: string) {
  const patch =
    kind === 'theme' ? { theme: value } : kind === 'font' ? { font_level: value } : { follow_up: value }
  await update(patch)
  pane.value = null
}

async function onReset() {
  try {
    await ElMessageBox.confirm('会把色调、字号、AI 追问全部恢复默认。', '恢复全部默认', {
      confirmButtonText: '恢复默认',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  await resetAll()
  ElMessage.success('已恢复默认')
}
</script>

<template>
  <div class="ms-page">
    <header class="ms-nav">
      <button v-if="pane" class="ms-back" type="button" @click="pane = null">‹</button>
      <span class="ms-title">
        {{ pane === 'theme' ? '界面色调' : pane === 'font' ? '界面字号' : pane === 'followUp' ? 'AI 追问' : '配置' }}
      </span>
    </header>

    <p v-if="syncError" class="ms-warn">{{ syncError }}</p>

    <!-- ------------------------------------------------------ 一级列表 -->
    <template v-if="!pane">
      <div class="ms-group-title">外观</div>
      <div class="ms-group">
        <button class="ms-cell" type="button" @click="pane = 'theme'">
          <span class="ms-cell-label">界面色调</span>
          <span class="ms-cell-value">{{ themeLabel(prefs.theme).name }}</span>
          <span class="ms-chev">›</span>
        </button>
        <button class="ms-cell ms-last" type="button" @click="pane = 'font'">
          <span class="ms-cell-label">界面字号</span>
          <span class="ms-cell-value">{{ FONT_LABELS[prefs.font_level] ?? prefs.font_level }}</span>
          <span class="ms-chev">›</span>
        </button>
      </div>

      <div class="ms-group-title">医生智能体</div>
      <div class="ms-group">
        <button class="ms-cell ms-last" type="button" @click="pane = 'followUp'">
          <span class="ms-cell-label">AI 追问</span>
          <span class="ms-cell-value">{{ followUpLabel(prefs.follow_up).name }}</span>
          <span class="ms-chev">›</span>
        </button>
      </div>

      <div class="ms-group-title">其他</div>
      <div class="ms-group">
        <button class="ms-cell ms-last" type="button" @click="onReset">
          <span class="ms-cell-label">恢复全部默认</span>
          <span class="ms-chev">›</span>
        </button>
      </div>

      <!-- 移动端没有可拖拽浮窗，「工作区布局」整组不显示，只解释一句 -->
      <p class="ms-hint">
        手机端没有可拖拽浮窗，「工作区布局」不在此显示。桌面端已记住的布局可在电脑上重置。
      </p>
    </template>

    <!-- ------------------------------------------------------ 色调 -->
    <template v-else-if="pane === 'theme'">
      <div class="ms-group-title">选择主题</div>
      <div class="ms-group">
        <button
          v-for="(key, i) in themes"
          :key="key"
          class="ms-cell ms-tone"
          :class="{ 'ms-last': i === themes.length - 1 }"
          type="button"
          @click="pick('theme', key)"
        >
          <!-- 色值来自 JS 常量，不进 CSS —— 否则会被 build-themes 一起换掉 -->
          <span class="ms-swatch">
            <i v-for="c in swatch(key)" :key="c" :style="{ background: c }" />
          </span>
          <span class="ms-tone-text">
            <b>{{ themeLabel(key).name }}</b>
            <em>{{ themeLabel(key).desc }}</em>
          </span>
          <span v-if="prefs.theme === key" class="ms-check">✓</span>
        </button>
      </div>

      <div class="ms-group-title">预览</div>
      <div class="ms-preview">
        <button class="ms-btn-primary" type="button">生成病历</button>
        <div class="ms-risk">
          <i /><b>红色·紧急</b><span>状态色不随主题变</span>
        </div>
      </div>
    </template>

    <!-- ------------------------------------------------------ 字号 -->
    <template v-else-if="pane === 'font'">
      <div class="ms-group">
        <button
          v-for="(key, i) in fontLevels"
          :key="key"
          class="ms-cell"
          :class="{ 'ms-last': i === fontLevels.length - 1 }"
          type="button"
          @click="pick('font', key)"
        >
          <span class="ms-cell-label">{{ FONT_LABELS[key] ?? key }}</span>
          <span v-if="prefs.font_level === key" class="ms-check">✓</span>
        </button>
      </div>
    </template>

    <!-- ------------------------------------------------------ 追问 -->
    <template v-else>
      <div class="ms-group">
        <button
          v-for="(key, i) in followUpModes"
          :key="key"
          class="ms-cell ms-tone"
          :class="{ 'ms-last': i === followUpModes.length - 1 }"
          type="button"
          @click="pick('followUp', key)"
        >
          <span class="ms-tone-text">
            <b>{{ followUpLabel(key).name }}</b>
            <em>{{ followUpLabel(key).desc }}</em>
          </span>
          <span v-if="prefs.follow_up === key" class="ms-check">✓</span>
        </button>
      </div>
      <p class="ms-hint">
        「完全关闭」只关闭追问清单这一个浮层，不影响风险预警、硬规则红线与写回门禁。
        医生可以选择不看追问建议，不能选择不看危急值。
      </p>
    </template>
  </div>
</template>

<style scoped>
.ms-page {
  min-height: 100vh;
  background: #f4f6fa;
  padding-bottom: 32px;
}

.ms-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 48px;
  padding: 0 16px;
  background: #ffffff;
  border-bottom: 1px solid #eef1f5;
}

.ms-back {
  border: 0;
  background: transparent;
  font-size: 20px;
  color: var(--t-1677ff, #1677ff);
  padding: 0;
  cursor: pointer;
}

.ms-title {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.ms-warn {
  margin: 12px 16px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  font-size: 11px;
}

.ms-group-title {
  padding: 16px 16px 6px;
  font-size: 11px;
  color: #9ca3af;
}

.ms-group {
  background: #ffffff;
}

.ms-cell {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border: 0;
  border-bottom: 1px solid #eef1f5;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.ms-cell.ms-last {
  border-bottom: 0;
}

.ms-cell-label {
  flex: 1;
  font-size: 14px;
  color: #1f2937;
}

.ms-cell-value {
  font-size: 13px;
  color: #6b7280;
}

.ms-chev {
  font-size: 16px;
  color: #9ca3af;
}

.ms-check {
  font-size: 16px;
  font-weight: 600;
  color: var(--t-1677ff, #1677ff);
}

.ms-swatch {
  display: flex;
  width: 48px;
  height: 24px;
  border-radius: 4px;
  overflow: hidden;
  flex: none;
}

.ms-swatch i {
  flex: 1;
}

.ms-tone-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ms-tone-text b {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
}

.ms-tone-text em {
  font-style: normal;
  font-size: 11px;
  color: #9ca3af;
}

.ms-preview {
  margin: 0 16px;
  padding: 12px;
  border-radius: 10px;
  background: #ffffff;
  border: 1px solid #e8ebf0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ms-btn-primary {
  align-self: flex-start;
  padding: 7px 14px;
  border: 0;
  border-radius: 6px;
  background: var(--t-1677ff, #1677ff);
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
}

/* 状态色：证明换主题时红色不变，色值必须留在状态色区间 */
.ms-risk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fef2f2;
  border: 1px solid #fecaca;
}

.ms-risk i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e6191a;
  flex: none;
}

.ms-risk b {
  font-size: 11px;
  font-weight: 600;
  color: #e6191a;
}

.ms-risk span {
  font-size: 11px;
  color: #6b7280;
}

.ms-hint {
  margin: 10px 16px 0;
  font-size: 11px;
  color: #9ca3af;
  line-height: 1.6;
}
</style>
