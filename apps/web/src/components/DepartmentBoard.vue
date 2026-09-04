<script setup lang="ts">
/**
 * 科室看板：**诊疗进度 × 风险** 两个维度。
 *
 * 产品定义（2026-09-04 确认）：
 *
 * > 病人看板主要是从两个维度回顾：① 诊疗进度 —— 哪些看过了、哪些没有
 * > （比如做完检查但报告还没回来的）；② 风险评估 —— 哪些有风险或危急值，
 * > 哪些是普通病人。
 *
 * 三条由此而来的取舍：
 *
 * **① 已完成的也要在。** 关键词是「回顾」，只显示候诊队列就回顾不了今天。
 *
 * **②「待报告」是独立一档**，不并进「没看过」也不并进「已完成」——
 * 医生已经开了单、做了判断，但结论还下不了。合并进任何一边，
 * 就看不出「这个人还欠我一个报告」。
 *
 * **③「普通病人」是一档，不是「没标记」。** 只标危险的，医生仍要逐个确认
 * 「这个是真没事还是我漏看了」。
 */
import { computed, onMounted, ref } from 'vue'

import { api, type BoardResponse, type BoardRow } from '../api'

const emit = defineEmits<{ open: [string] }>()

const data = ref<BoardResponse | null>(null)
const loading = ref(false)
const error = ref('')

/** 只看该我处理的 —— 回顾完之后，医生实际要的是这一屏 */
const onlyAttention = ref(false)

const rows = computed<BoardRow[]>(() => {
  const all = data.value?.rows ?? []
  return onlyAttention.value
    ? all.filter((r) => r.risk_tier !== 'ordinary' && r.progress !== 'done')
    : all
})

const PROGRESS_LABEL: Record<BoardRow['progress'], string> = {
  not_started: '未接诊',
  pending_report: '待报告',
  interviewed: '已问诊',
  done: '已完成',
}

const RISK_LABEL: Record<BoardRow['risk_tier'], string> = {
  critical: '危急',
  warning: '需关注',
  ordinary: '普通',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await api.departmentBoard()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
defineExpose({ load })
</script>

<template>
  <div class="dept-board">
    <div class="db-head">
      <span class="db-title">科室看板</span>
      <span class="db-sub">今天走到哪了 · 谁该我先看</span>
      <span class="db-spacer" />
      <button class="db-refresh" :disabled="loading" @click="load">
        {{ loading ? '读取中…' : '刷新' }}
      </button>
    </div>

    <p v-if="error" class="db-error">读取失败：{{ error }}</p>

    <template v-else-if="data">
      <!-- 医生第一眼看的是「还剩几个要处理」，所以它排第一且最大 -->
      <div class="db-stats">
        <button
          class="db-stat attention"
          :class="{ on: onlyAttention }"
          :title="onlyAttention ? '点一下看全部' : '点一下只看该我处理的'"
          @click="onlyAttention = !onlyAttention"
        >
          <i>该我处理</i><b>{{ data.needs_attention }}</b>
        </button>
        <span class="db-stat"><i>待报告</i><b>{{ data.pending_report }}</b></span>
        <span class="db-stat"><i>已完成</i><b>{{ data.done }}</b></span>
        <span class="db-stat"><i>今日合计</i><b>{{ data.total }}</b></span>
      </div>

      <table class="db-table">
        <thead>
          <tr>
            <th>患者</th><th>进度</th><th>风险</th><th>主诉</th><th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.patient_id" :class="`tier-${r.risk_tier}`">
            <td class="db-who">
              <b>{{ r.name }}</b>
              <span class="db-meta">{{ r.gender }} · {{ r.age }}岁 · {{ r.dept }}</span>
              <!-- 过敏只在**确认有**时给红标；没有就不给颜色 —— 干净就是信息 -->
              <span v-if="r.allergy_status === 'confirmed'" class="db-allergy">
                ⚠ {{ r.allergies[0] }}{{ r.allergies.length > 1 ? ` +${r.allergies.length - 1}` : '' }}
              </span>
              <span v-else-if="r.allergy_status === 'unknown'" class="db-allergy unknown">过敏史未采集</span>
            </td>
            <td>
              <span class="db-progress" :class="r.progress">{{ PROGRESS_LABEL[r.progress] }}</span>
              <span v-if="r.pending_exams" class="db-pending">{{ r.pending_exams }} 项未回</span>
            </td>
            <td>
              <span class="db-tier" :class="r.risk_tier">{{ RISK_LABEL[r.risk_tier] }}</span>
              <span v-if="r.red_names.length" class="db-red">{{ r.red_names.join(' · ') }}</span>
            </td>
            <td class="db-cc">{{ r.chief_complaint }}</td>
            <td><button class="db-open" @click="emit('open', r.patient_id)">接诊</button></td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="5" class="db-empty">
              {{ onlyAttention ? '没有需要处理的了 —— 今天的红线都闭环了' : '今天没有患者' }}
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped src="../styles/DepartmentBoard.scoped.css"></style>
