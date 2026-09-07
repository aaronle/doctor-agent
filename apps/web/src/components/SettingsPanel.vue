<script setup lang="ts">
import { onMounted } from 'vue'
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
 * 个人配置的**正文**。
 *
 * 单独拆出来是因为它有两个挂载点：`/settings` 整页，以及医生智能体
 * 面板头部齿轮弹出的对话框。**两处各写一份必然会漂移** ——
 * 加一项设置只改了其中一个，而没人会同时想起另一个地方。
 *
 * 页面外壳（标题、移动端分支）留在 `SettingsView.vue`，
 * 这里只管四组配置本身。
 *
 * 规格见 docs/product/20-个人配置需求规格说明书.md。
 */

const session = useSession()
const p = usePreferences()
const {
  prefs, syncError, themes, fontLevels, followUpModes, windowSummary,
  load, update, resetAll, resetWindows,
} = p

onMounted(() => load(session.doctorName))

const themeLabel = (key: string) => THEME_LABELS[key] ?? { name: key, desc: '' }
const swatch = (key: string) => THEME_SWATCHES[key] ?? ['#ccc', '#ddd', '#eee']
const followUpLabel = (key: string) => FOLLOW_UP_LABELS[key] ?? { name: key, desc: '' }
const fontLabel = (key: string) => FONT_LABELS[key] ?? key

async function onReset() {
  try {
    await ElMessageBox.confirm(
      '会把色调、字号、AI 追问设置全部恢复默认，并清空已记住的浮窗布局。',
      '恢复全部默认',
      { confirmButtonText: '恢复默认', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  await resetAll()
  ElMessage.success('已恢复默认')
}

async function onResetWindows() {
  await resetWindows()
  ElMessage.success('已恢复默认布局')
}
</script>

<template>
  <div class="settings-col">
    <div class="settings-head">
      <h1>个人配置</h1>
      <button class="ghost-btn" @click="onReset">恢复全部默认</button>
    </div>

    <!-- 同步失败不挡使用：本机值照常生效，只挂一条提示 -->
    <div v-if="syncError" class="sync-warn">{{ syncError }}</div>

    <!-- ---------------------------------------------------------- 外观 -->
    <section class="settings-card">
      <h2>外观</h2>

      <div class="settings-row">
        <span class="row-label">界面色调</span>
        <div class="tone-options">
          <button
            v-for="key in themes"
            :key="key"
            class="tone-option"
            :class="{ on: prefs.theme === key }"
            type="button"
            @click="update({ theme: key })"
          >
            <!-- 色值来自 JS 常量，不进 CSS —— 否则会被 build-themes 一起换掉 -->
            <span class="tone-swatch">
              <i v-for="c in swatch(key)" :key="c" :style="{ background: c }" />
            </span>
            <span class="tone-name">{{ themeLabel(key).name }}</span>
            <span class="tone-desc">{{ themeLabel(key).desc }}</span>
          </button>
        </div>
      </div>

      <div class="settings-row">
        <span class="row-label">界面字号</span>
        <div class="seg">
          <button
            v-for="key in fontLevels"
            :key="key"
            type="button"
            :class="{ on: prefs.font_level === key }"
            @click="update({ font_level: key })"
          >
            {{ fontLabel(key) }}
          </button>
        </div>
      </div>

      <div class="settings-row">
        <span class="row-label">实时预览</span>
        <!--
          三个色块不足以让人判断换完长什么样，所以放真控件。
          **风险条是必须有的** —— 它的作用是当场证明状态色不跟着主题变。
        -->
        <div class="preview">
          <div class="preview-line">
            <button class="btn-primary" type="button">生成病历</button>
            <span class="tag">智慧诊疗</span>
            <a class="link">查看详细</a>
          </div>
          <div class="preview-risk">
            <i class="dot" />
            <b>红色·紧急</b>
            <span>低血糖风险 —— 任何主题下都保持红色，不参与主题变换</span>
          </div>
        </div>
      </div>
    </section>

    <!-- -------------------------------------------------- 医生智能体 -->
    <section class="settings-card">
      <h2>医生智能体</h2>

      <div class="settings-row">
        <span class="row-label">AI 追问</span>
        <div class="radio-list">
          <button
            v-for="key in followUpModes"
            :key="key"
            class="radio-item"
            :class="{ on: prefs.follow_up === key }"
            type="button"
            @click="update({ follow_up: key })"
          >
            <i class="ring" />
            <span class="radio-name">{{ followUpLabel(key).name }}</span>
            <span class="radio-desc">{{ followUpLabel(key).desc }}</span>
          </button>
        </div>
      </div>

      <p class="safety-note">
        <b>!</b>
        <span>
          「完全关闭」只关闭追问清单这一个浮层，不影响风险预警、硬规则红线与写回门禁。
          医生可以选择不看追问建议，不能选择不看危急值。
        </span>
      </p>
    </section>

    <!-- -------------------------------------------------- 工作区布局 -->
    <section class="settings-card">
      <h2>工作区布局</h2>

      <div class="switch-row">
        <span>记住浮窗尺寸与位置</span>
        <button
          class="switch"
          :class="{ on: prefs.remember_windows }"
          type="button"
          role="switch"
          :aria-checked="prefs.remember_windows"
          @click="update({ remember_windows: !prefs.remember_windows })"
        >
          <i />
        </button>
      </div>

      <div class="memo">
        <span class="memo-label">当前已记住</span>
        <span class="memo-value">{{ windowSummary || '尚未记住任何布局' }}</span>
        <button class="ghost-btn" type="button" :disabled="!windowSummary" @click="onResetWindows">
          恢复默认布局
        </button>
      </div>

      <p class="hint">
        关闭后每次进入工作站都回到默认布局。几何值由拖拽后自动记录，不在此处手填。
      </p>
    </section>
  </div>
</template>

<style scoped src="../styles/Settings.scoped.css"></style>
