<script setup lang="ts">
/**
 * AI 追问提示浮框。
 *
 * 问诊进行中浮在医生智能体右上角：该问的列在上面，问到一条划掉一条。
 *
 * ## 三条显示规则
 *
 * **① 已问到的沉底、灰掉、划线，不删除。** 医生要能看见「这条问过了」——
 * 那本身也是信息。直接消失的话清单会莫名其妙变短，医生分不清是问到了
 * 还是模型忘了。
 *
 * **② 角标是「还没问」的条数，不是总数。** 它要说的是「还欠几条」。
 *
 * **③ 空清单整个不渲染。** 一个常驻的空浮框只是挡住底下的内容。
 *
 * ## 它替掉了什么
 *
 * 原来那个「问诊提示浮框」（`.hint-float` / `.hf-*`）：点「生成」或「暂停」
 * 才弹一次，内容是问诊小结的 `gaps`，静态、不划掉、不能拖。
 *
 * 同一个右上角不放两个浮框，所以是**替换**不是新增。位置、配色、
 * 三态（展开/缩小/关闭）都沿用它的，医生看到的还是同一个东西，
 * 只是从「问完才告诉你漏了什么」变成「边问边提示」。
 */
import { computed } from 'vue'

import { useDraggable } from '../composables/useDraggable'
import type { FollowUpItem } from '../composables/useFollowUp'

const props = defineProps<{
  items: FollowUpItem[]
  /** 缩小成胶囊 */
  minimized: boolean
}>()

const emit = defineEmits<{
  'update:minimized': [boolean]
  close: []
}>()

const pending = computed(() => props.items.filter((i) => !i.done))
const done = computed(() => props.items.filter((i) => i.done))

/** 拖动：和桌面卡通同一套（拖完不算点击、拖出屏幕要钳回来） */
const { style, onPointerDown } = useDraggable({ width: 224, height: 280 })
</script>

<template>
  <div class="hint-float" :class="{ mini: props.minimized }" :style="style" data-draggable>
    <template v-if="!props.minimized">
      <!-- 头部整条是拖动把手：内容区要能滚动、能选中，不适合当把手 -->
      <div class="hf-head" @pointerdown="onPointerDown">
        <span class="hf-icon">💡</span>
        <span class="hf-title">AI 追问提示</span>
        <span class="hf-spacer" />
        <span class="hf-progress">{{ done.length }}/{{ props.items.length }}</span>
        <button class="hf-btn" title="缩小" @click="emit('update:minimized', true)">—</button>
        <button class="hf-btn" title="关闭（本轮不再自动弹）" @click="emit('close')">✕</button>
      </div>

      <div class="hf-body">
        <!-- 还没问的：橙色序号 -->
        <div v-for="(item, i) in pending" :key="`p-${item.question}`" class="hf-item">
          <span class="hf-num">{{ i + 1 }}</span>
          <span class="hf-text">{{ item.question }}</span>
        </div>

        <p v-if="!pending.length" class="hf-allclear">清单里的都问到了 👍</p>

        <!--
          已问到的。**留在这儿，不删** —— 见文件头规则 ①。
          title 挂上患者原话：医生想核对「凭什么算问到了」时能当场看到，
          而这个判定的判据本来就是「能指出患者在哪句话里答了」。
        -->
        <template v-if="done.length">
          <div class="hf-sep">已问到 {{ done.length }} 条</div>
          <div v-for="item in done" :key="`d-${item.question}`" class="hf-done" :title="item.quote">
            <span class="hf-check">✓</span>
            <span class="hf-done-text">{{ item.question }}</span>
          </div>
        </template>

        <!--
          这一句是刻意的。这个功能撤过一次，理由是「做不准是干扰」——
          措辞压住，它才是提示而不是必办清单。
        -->
        <div class="hf-foot">供参考，不是必须问的项</div>
      </div>
    </template>

    <button
      v-else
      class="hf-pill"
      title="展开 AI 追问提示"
      @pointerdown="onPointerDown"
      @click="emit('update:minimized', false)"
    >
      <span class="hf-icon">💡</span>追问提示
      <!-- 角标是**还没问**的条数，不是总数 —— 见文件头规则 ② -->
      <span v-if="pending.length" class="hf-count">{{ pending.length }}</span>
    </button>
  </div>
</template>

<style scoped src="../styles/FollowUpHints.scoped.css"></style>
