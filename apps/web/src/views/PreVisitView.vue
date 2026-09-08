<script setup lang="ts">
import MobilePreVisit from '../mobile/MobilePreVisit.vue'

/**
 * 预问诊页面外壳。
 *
 * **不做视口分流。** 其他页面 ≤768px 才走移动端组件，这一页任何尺寸
 * 都是同一套 —— 患者可能用平板、可能用护士站的大屏帮着填，
 * 按宽度挡掉只会让人以为坏了。
 *
 * 它也不在 V4.3 原件里，所以 fidelity / coverage 两道界面闸不比对它，靠单测守。
 */
</script>

<template>
  <MobilePreVisit />
</template>
