<script setup lang="ts">
/**
 * 医生智能体收起后的桌面卡通 —— 方案 **D1「微笑」**。
 *
 * ## 它替掉了什么
 *
 * 原件那个 52px 的蓝色圆钮，正中写着「AI」。位置与职责这里一个字没改：
 * 都是「面板收起后，把它找回来的那个东西」。换的只是长相。
 *
 * 换的理由：圆钮上的「AI」是一个**标签**，说的是「这里有个 AI」；
 * 而这一屏真正该传达的是「医生智能体待命中，随时叫它」。
 * 一张脸能表达状态（在想 / 有几条待补问），两个字母不能 ——
 * 原件为此另挂了一个绿色呼吸点，那个点只有「在线」一种含义。
 *
 * ## 三条设计约束（改之前先读）
 *
 * **① 眼睛保持圆点，不做眯眼笑。** 缩到这个尺寸时眯眼会糊成一条线，
 * 读起来像闭眼睡着了 —— 和「待命」正好相反。笑只由嘴表达。
 *
 * **② 分析中不做旋转风火轮。** 它浮在医生的桌面上，而分析要跑 20–30 秒；
 * 一个转半分钟的东西是持续的余光干扰。改成闭眼 + 呼吸 —— 同样看得出在忙，
 * 但不抢注意力。
 *
 * **③ 角标只在有待补问时出现，数字由外面传进来。**
 * 这里一个数都不自己算：它和问诊提示浮框必须是同一个数，
 * 两处对不上时医生不知道该信哪个。
 */
import { computed } from 'vue'

import { useDraggable } from '../composables/useDraggable'

const props = withDefaults(defineProps<{
  /** 待补问条数。0 = 不出角标 */
  hintCount?: number
  /** 正在跑分析 */
  thinking?: boolean
}>(), { hintCount: 0, thinking: false })

const emit = defineEmits<{ open: [] }>()

const W = 56
const H = 66

/**
 * 拖过就不算点击、拖出屏幕要钳回来 —— 两条都在 `useDraggable` 里，
 * 追问提示浮框用的是同一套（抄第二遍必然漏掉其中一个）。
 */
const { style, onPointerDown, withClickGuard } = useDraggable({
  width: W,
  height: H,
  // 没拖过时贴右下角，和原件圆钮同一个位置（right:24 bottom:32）——
  // 医生上一版在哪找它，这一版还在哪
  initial: () => ({ left: window.innerWidth - W - 24, top: window.innerHeight - H - 32 }),
})

const onClick = withClickGuard(() => emit('open'))

const label = computed(() =>
  props.hintCount > 0
    ? `展开医生智能体（${props.hintCount} 条待补问）`
    : '展开医生智能体',
)
</script>

<template>
  <div
    class="mascot"
    :class="{ thinking: props.thinking }"
    :style="style"
    role="button"
    tabindex="0"
    :title="label"
    :aria-label="label"
    @pointerdown="onPointerDown"
    @click="onClick"
    @keydown.enter="emit('open')"
    @keydown.space.prevent="emit('open')"
  >
    <svg :width="W" :height="H" viewBox="0 0 220 260" aria-hidden="true">
      <!-- 天线 -->
      <line x1="110" y1="30" x2="110" y2="52" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
      <circle class="mascot-antenna" cx="110" cy="26" r="7" fill="currentColor" />

      <!-- 圆顶头 -->
      <path
        d="M40 118 A70 70 0 0 1 180 118 L180 168 A16 16 0 0 1 164 184 L56 184 A16 16 0 0 1 40 168 Z"
        fill="currentColor"
      />

      <!-- 面屏 -->
      <rect x="56" y="86" width="108" height="84" rx="26" fill="#fff" />

      <!-- 分析中：闭眼一条弧 + 嘴收成横线。见文件头约束 ② -->
      <template v-if="props.thinking">
        <path class="mascot-eye-closed" d="M78 118 q10 -10 20 0" stroke="currentColor" stroke-width="6"
              fill="none" stroke-linecap="round" />
        <path class="mascot-eye-closed" d="M122 118 q10 -10 20 0" stroke="currentColor" stroke-width="6"
              fill="none" stroke-linecap="round" />
        <path class="mascot-mouth" d="M98 146 h24" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
      </template>

      <!-- 默认：睁眼 + 微笑。这条上扬的嘴就是 D1 与 D 的唯一区别 -->
      <template v-else>
        <circle class="mascot-eye" cx="88" cy="116" r="9" fill="currentColor" />
        <circle class="mascot-eye" cx="132" cy="116" r="9" fill="currentColor" />
        <path class="mascot-mouth" d="M92 140 Q110 156 128 140" stroke="currentColor" stroke-width="6"
              stroke-linecap="round" fill="none" />
      </template>

      <!-- 听诊器：点明「医生」 -->
      <path d="M62 184 Q58 214 84 220" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round" />
      <circle cx="92" cy="222" r="10" fill="#fff" stroke="currentColor" stroke-width="5" />
    </svg>

    <span v-if="props.hintCount > 0" class="mascot-badge">{{ props.hintCount }}</span>
  </div>
</template>

<style scoped src="../styles/AgentMascot.scoped.css"></style>
