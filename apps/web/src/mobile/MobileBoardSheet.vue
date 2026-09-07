<script setup lang="ts">
import { ref, watch } from 'vue'

import { api } from '../api'

/**
 * 科室看板（移动端）。
 *
 * 桌面端是对话框里的一张表；390px 放不下表格，改成**卡片列表**。
 * 两个维度不变（规格见 `18-规格符合性走查.md` §五）：
 * 诊疗进度、风险评估。
 *
 * **做成底部弹层不做成第四档。** 底部三档讲的都是「这一位患者」，
 * 看板讲的是「这一屏患者」—— 混进去会让「当前患者是谁」变模糊，
 * 与桌面端不做成第九个标签页是同一条理由。
 */

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; pick: [patientId: string] }>()

interface Row {
  patient_id: string; name: string; age: number; gender: string; dept: string
  chief_complaint: string; progress: string; pending_exams: number
  risk_tier: string; open_red: number; red_names: string[]
  allergy_status: string; allergies: string[]
}

const rows = ref<Row[]>([])
const stat = ref({ total: 0, done: 0, pending_report: 0, needs_attention: 0 })
const loading = ref(false)
const onlyMine = ref(false)

/** 进度与风险的中文名。**闭集写在一处** —— 散在模板里，加一档就会漏改 */
const PROGRESS_LABEL: Record<string, string> = {
  not_started: '未接诊', pending_report: '待报告', interviewed: '已接诊', done: '已完成',
}
const RISK_LABEL: Record<string, string> = {
  critical: '有红线', warning: '需留意', ordinary: '普通',
}

async function load() {
  loading.value = true
  try {
    const body = await api.departmentBoard()
    rows.value = (body.rows ?? []) as Row[]
    stat.value = {
      total: body.total ?? 0, done: body.done ?? 0,
      pending_report: body.pending_report ?? 0, needs_attention: body.needs_attention ?? 0,
    }
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

// 每次打开都重拉：看板讲的是「此刻这一屏」，缓存下来就失去意义了
watch(() => props.open, (open) => { if (open) void load() })

/** 「该我处理」= 有未处置红线，或报告已回但还没看 */
function needsMe(r: Row) {
  return r.open_red > 0 || (r.progress === 'pending_report' && r.pending_exams === 0)
}
</script>

<template>
  <template v-if="props.open">
    <div class="m-scrim" @click="emit('close')" />
    <div class="m-sheet m-board-sheet">
      <div class="m-grab" />
      <div class="m-sheet-head">
        <span class="m-sheet-title">科室看板</span>
        <span class="m-board-sub">今日 {{ stat.total }} 人</span>
      </div>

      <div class="m-board-stat">
        <button class="m-board-cell" :class="{ on: onlyMine }" type="button" @click="onlyMine = !onlyMine">
          <b class="danger">{{ stat.needs_attention }}</b><i>该我处理</i>
        </button>
        <div class="m-board-cell"><b class="warn">{{ stat.pending_report }}</b><i>待报告</i></div>
        <div class="m-board-cell"><b>{{ stat.done }}</b><i>已完成</i></div>
      </div>

      <div v-loading="loading" class="m-sheet-body m-board-list">
        <p v-if="!loading && !rows.length" class="m-board-empty">看板暂无数据。</p>
        <button
          v-for="r in rows.filter((x) => !onlyMine || needsMe(x))"
          :key="r.patient_id"
          class="m-board-item"
          type="button"
          @click="emit('pick', r.patient_id)"
        >
          <span class="m-board-line1">
            <i class="m-board-dot" :class="r.risk_tier" />
            <b>{{ r.name }}</b>
            <!-- 过敏在候诊场景是安全信息，不是补充信息 —— 与安全条同一条理由 -->
            <em v-if="r.allergy_status === 'confirmed' && r.allergies.length" class="m-board-allergy">
              ⚠ {{ r.allergies[0] }}
            </em>
            <span class="m-board-go">›</span>
          </span>
          <span class="m-board-line2">
            <i>{{ r.dept }} · {{ r.age }}岁</i>
            <em class="m-board-progress" :class="r.progress">
              {{ PROGRESS_LABEL[r.progress] ?? r.progress }}
              <template v-if="r.progress === 'pending_report' && r.pending_exams"> {{ r.pending_exams }} 项</template>
            </em>
          </span>
          <span class="m-board-line3" :class="r.risk_tier">
            <template v-if="r.open_red">{{ r.open_red }} 条红线：{{ r.red_names.join('、') }}</template>
            <template v-else>{{ RISK_LABEL[r.risk_tier] ?? r.risk_tier }}</template>
          </span>
        </button>
      </div>
    </div>
  </template>
</template>
