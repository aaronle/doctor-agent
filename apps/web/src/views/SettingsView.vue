<script setup lang="ts">
import MobileSettings from '../mobile/MobileSettings.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import { useIsMobile } from '../composables/useMediaQuery'

/**
 * 个人配置（整页）。
 *
 * 正文在 `components/SettingsPanel.vue` —— 它同时被医生智能体面板里的
 * 设置对话框复用。这一层只负责页面外壳与移动端分支。
 *
 * 这一页与 `/admin`、`/delivery` 同类：**不在 V4.3 原件里**，
 * 所以两道界面闸（fidelity / coverage）不比对它，靠单测守。
 */

const isMobile = useIsMobile()
</script>

<template>
  <MobileSettings v-if="isMobile" />

  <div v-else class="settings-page">
    <SettingsPanel />
  </div>
</template>

<style scoped src="../styles/Settings.scoped.css"></style>
