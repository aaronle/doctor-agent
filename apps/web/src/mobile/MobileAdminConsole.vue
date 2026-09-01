<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { useAdminConsole } from '../composables/useAdminConsole'
import { log } from '../logging'

/**
 * Agent 控制台（移动端）。
 *
 * 桌面是「240px 岗位侧栏 + 主区五标签」。390px 里侧栏放不下，改成
 * **顶部岗位切换 + 底部四档**（配置 / 试运行 / 回归集 / 日志）。
 *
 * **与医生端不同，这里保留写入动作** —— 改的是 Agent 配置，不是病历。
 * 但「存草稿 / 发布」固定在底部操作条，不藏在长表单末尾：手机上滚到底
 * 才发现按钮，等于让人多滚一屏才敢确认。
 *
 * 状态全部来自 `useAdminConsole`，与桌面版同一份实现。
 */

const {
  loading, agents, bundleVersion, activeKey, detail, runs,
  draft, saving, dirty,
  dryPatient, comparing, comparison, changedFields, fieldText, runCompare,
  evaluating, evalResult, evalCases, datasets, togglingDataset, activeCaseCount,
  runEval, loadDatasets, toggleDataset,
  loadOverview, select, saveDraft, publish, rollback, discard, resetToCodeDefault,
} = useAdminConsole()

type Pane = '配置' | '试运行' | '回归集' | '日志'
const pane = ref<Pane>('配置')

const pickerOpen = ref(false)
/** 平台安全层有二十多行，铺开会把可编辑的岗位层挤出屏幕 */
const safetyOpen = ref(false)

async function pickAgent(key: string) {
  pickerOpen.value = false
  await select(key)
}

function switchPane(next: Pane) {
  log('admin-mobile', 'switch_pane', { from: pane.value, to: next, agent: activeKey.value })
  pane.value = next
}

function rateClass(rate: number | null) {
  if (rate === null) return ''
  return rate < 90 ? 'm-rate-bad' : 'm-rate-ok'
}

onMounted(async () => {
  await loadOverview()
  await loadDatasets()
})
</script>

<template>
  <div class="m-page">
    <div class="m-topbar">
      <span class="m-cell-icon">⚙</span>
      <div class="m-who">
        <span class="m-who-meta">Agent 控制台 · {{ bundleVersion }}</span>
        <!-- 六个岗位的侧栏在 390px 放不下，改成点这一行弹出选择器 -->
        <button class="m-agent-pick" type="button" @click="pickerOpen = true">
          <span class="m-who-name">{{ detail?.name ?? '选择岗位' }}</span>
          <span class="m-chev">▾</span>
        </button>
      </div>
      <span class="m-spacer" />
      <button class="m-btn link" type="button" :disabled="loading" @click="loadOverview">↻ 刷新</button>
    </div>

    <!-- ---------------- 配置 ---------------- -->
    <template v-if="pane === '配置'">
      <div class="m-body">
        <div class="m-records">
          <div v-if="detail" class="m-field-card">
            <div class="m-tags">
              <span class="m-row-strong">{{ detail.running.version }}</span>
              <span v-if="detail.draft" class="m-tag warn">草稿</span>
              <span class="m-spacer" />
              <span class="m-tag">{{ detail.tasks.join(' · ') }}</span>
            </div>
            <span class="m-row-sub">{{ detail.running.source === 'published' ? '已发布配置' : '代码默认' }} · {{ detail.running.model_tier }}</span>
          </div>

          <!-- 安全层：只读且默认折叠，但「不可编辑」这个事实始终可见 -->
          <div class="m-field-card m-locked">
            <div class="m-tags">
              <span class="m-row-strong">平台安全层</span>
              <span class="m-spacer" />
              <span class="m-tag danger">不可编辑</span>
            </div>
            <span class="m-row-sub">
              只能随代码发布。安全层若可编辑，「不得自行确诊」「缺失写未获得」这类红线就成了摆设。
            </span>
            <button class="m-cbtn" type="button" @click="safetyOpen = !safetyOpen">
              {{ safetyOpen ? '收起全文' : '展开全文' }}
            </button>
            <pre v-if="safetyOpen" class="m-pre">{{ detail?.safety_layer }}</pre>
          </div>

          <div class="m-field-card">
            <div class="m-tags">
              <span class="m-row-strong">岗位层 Prompt</span>
              <span class="m-spacer" />
              <button class="m-btn link" type="button" @click="resetToCodeDefault">填入代码默认值</button>
            </div>
            <!-- 字号 16px：iOS 对更小字号会在聚焦时自动放大整页且不缩回 -->
            <textarea v-model="draft.role_prompt" class="m-textarea" rows="8" />
          </div>

          <div class="m-field-card">
            <div class="m-tags">
              <span class="m-row-strong">模型档位</span>
              <span class="m-spacer" />
              <select v-model="draft.model_tier" class="m-select">
                <option value="clinical_fast">clinical_fast</option>
                <option value="clinical_reasoning">clinical_reasoning</option>
                <option value="clinical_safety">clinical_safety</option>
              </select>
            </div>
          </div>

          <div v-if="detail?.draft" class="m-field-card">
            <span class="m-row-sub">当前有未发布的草稿。</span>
            <button class="m-btn" type="button" @click="discard">丢弃草稿</button>
          </div>
        </div>
      </div>

      <!-- 固定操作条：手机上滚到底才发现按钮，等于让人多滚一屏才敢确认 -->
      <div class="m-input-bar">
        <button class="m-btn" style="flex: 1" type="button" :disabled="saving || !dirty" @click="saveDraft">
          {{ saving ? '保存中…' : '存草稿' }}
        </button>
        <button class="m-btn primary" style="flex: 1" type="button" :disabled="!detail?.draft" @click="publish">
          发布
        </button>
      </div>
    </template>

    <!-- ---------------- 试运行 ---------------- -->
    <div v-else-if="pane === '试运行'" class="m-body">
      <div class="m-records">
        <div class="m-actionrow">
          <input v-model="dryPatient" class="m-search" placeholder="病例 ID，如 P001" />
          <button class="m-btn primary" type="button" :disabled="comparing" @click="runCompare">
            {{ comparing ? '运行中…' : '并排对比' }}
          </button>
        </div>
        <p class="m-row-sub">草稿与线上跑同一个病例。不记账、不写缓存。</p>

        <template v-if="comparison">
          <p class="m-row-sub">只列变化过的字段 —— 几十个 same 会把两条真差异淹掉。</p>
          <div v-for="d in changedFields" :key="d.field" class="m-field-card">
            <span class="m-field-label">{{ d.field }} · {{ d.kind }}</span>
            <span class="m-row-sub">线上</span>
            <span class="m-field-value">{{ fieldText('published', d.field) }}</span>
            <span class="m-row-sub">草稿</span>
            <span class="m-field-value">{{ fieldText('draft', d.field) }}</span>
          </div>
          <p v-if="!changedFields.length" class="m-empty">两边输出一致，没有差异。</p>
        </template>
      </div>
    </div>

    <!-- ---------------- 回归集 ---------------- -->
    <div v-else-if="pane === '回归集'" class="m-body">
      <div class="m-records">
        <div class="m-actionrow">
          <button class="m-btn primary" type="button" :disabled="evaluating" @click="runEval">
            {{ evaluating ? '执行中…' : '用草稿跑回归集' }}
          </button>
          <span class="m-spacer" />
          <span class="m-row-sub">{{ activeCaseCount }} 条会跑</span>
        </div>

        <!-- 数据集管理：开关摆在结果上方，因为通过率必须有分母 -->
        <div class="m-ds-panel">
          <div class="m-ds-head">
            <span class="m-row-strong">评测数据集</span>
            <span class="m-spacer" />
            <span class="m-row-sub">停用的不参与运行</span>
          </div>
          <div
            v-for="ds in datasets"
            :key="ds.id"
            class="m-ds-row"
            :class="{ off: !ds.enabled, broken: !!ds.error }"
          >
            <el-switch
              :model-value="ds.enabled"
              :disabled="!!ds.error || togglingDataset === ds.id"
              size="small"
              @change="(v: boolean) => toggleDataset(ds, v)"
            />
            <div class="m-ds-main">
              <div class="m-tags">
                <span class="m-row-strong">{{ ds.name }}</span>
                <span class="m-tag">{{ ds.source }}</span>
                <span class="m-row-sub">{{ ds.case_count }} 条 · {{ ds.agents.join('/') || '—' }}</span>
              </div>
              <div class="m-row-sub">{{ ds.description }}</div>
              <div v-if="ds.reference" class="m-row-sub">依据：{{ ds.reference }}</div>
              <!-- 加载失败的照样列出来带原因：静默藏起来等于少跑一集却看不出来 -->
              <div v-if="ds.error" class="m-ds-error">✕ 加载失败，本集不参与运行：{{ ds.error }}</div>
            </div>
          </div>
          <div v-if="!datasets.length" class="m-empty">还没有任何数据集。</div>
        </div>

        <template v-if="evalResult">
          <div class="m-stats" style="padding: 0; grid-template-columns: repeat(3, 1fr)">
            <div class="m-stat">
              <div class="m-stat-value" style="color: var(--green)">{{ evalResult.passed }}</div>
              <div class="m-stat-label">通过</div>
            </div>
            <div class="m-stat">
              <div class="m-stat-value danger">{{ evalResult.failed }}</div>
              <div class="m-stat-label">失败</div>
            </div>
            <div class="m-stat">
              <div class="m-stat-value">{{ evalResult.total }}</div>
              <div class="m-stat-label">用例</div>
            </div>
          </div>
          <!-- 分母必须写出来：关掉半个数据集也能把通过率刷上去 -->
          <p v-if="evalResult.datasets?.length" class="m-row-sub">
            本次跑到：{{ evalResult.datasets.map((d) => `${d.name}(${d.case_count})`).join(' · ') }}
          </p>

          <div
            v-for="c in evalResult.cases"
            :key="c.case_id"
            class="m-field-card"
            :class="{ 'm-case-failed': !c.passed }"
          >
            <div class="m-tags">
              <span :class="c.passed ? 'm-rate-ok' : 'm-rate-bad'">{{ c.passed ? '✓' : '✕' }}</span>
              <span class="m-row-strong">{{ c.case_id }}</span>
              <span class="m-row-sub">{{ c.name }}</span>
              <span class="m-spacer" />
              <span class="m-row-sub">{{ (c.elapsed_ms / 1000).toFixed(1) }}s</span>
            </div>
            <span v-if="c.degraded" class="m-row-sub">降级 · 本次判定不说明提示词好坏</span>
            <div class="m-tags">
              <span
                v-for="k in c.checks"
                :key="k.name"
                class="m-tag"
                :class="k.passed ? 'ok' : 'danger'"
              >{{ k.passed ? '✓' : '✕' }} {{ k.name }}</span>
            </div>
            <div v-for="k in c.checks.filter((x) => !x.passed && x.detail)" :key="`d-${k.name}`" class="m-ds-error">
              └ {{ k.detail }}
            </div>
          </div>
        </template>

        <template v-else-if="!evaluating">
          <p class="m-row-sub">
            该岗位共 {{ evalCases.length }} 条用例。改提示词修好一个病例、弄坏另一个，是这类工作最常见的失败模式。
          </p>
          <div v-for="c in evalCases" :key="c.id" class="m-field-card">
            <div class="m-tags">
              <span class="m-row-strong">{{ c.id }}</span>
              <span class="m-row-sub">{{ c.name }}</span>
              <span class="m-spacer" />
              <span class="m-tag">{{ c.dataset_name }}</span>
            </div>
            <span class="m-row-sub">{{ c.checks.join(' / ') }}</span>
          </div>
        </template>
      </div>
    </div>

    <!-- ---------------- 日志 ---------------- -->
    <div v-else class="m-body">
      <div class="m-records">
        <p class="m-row-sub">
          最近 {{ runs.length }} 条。桌面是一张八列表格 —— 390px 里必然溢出且够不着，改为卡片。
        </p>
        <div v-for="r in runs" :key="r.id" class="m-field-card">
          <div class="m-tags">
            <span class="m-row-strong">{{ r.created_at?.slice(11, 19) }}</span>
            <span
              class="m-tag"
              :class="r.status === 'ok' ? 'ok' : r.status === 'degraded' ? 'warn' : 'danger'"
            >{{ r.status === 'ok' ? '成功' : r.status === 'degraded' ? '降级' : '失败' }}</span>
            <span class="m-spacer" />
            <span class="m-row-sub">{{ (r.elapsed_ms / 1000).toFixed(1) }}s</span>
          </div>
          <span class="m-row-sub">{{ r.agent_key }} · {{ r.patient_id || '—' }} · {{ r.model_tier }}</span>
          <span v-if="r.error" class="m-ds-error">{{ r.error }}</span>
        </div>
        <p v-if="!runs.length" class="m-empty">还没有运行记录。</p>
      </div>
    </div>

    <div class="m-tabbar">
      <button
        v-for="p in (['配置', '试运行', '回归集', '日志'] as Pane[])"
        :key="p"
        class="m-tab"
        :class="{ active: pane === p }"
        type="button"
        @click="switchPane(p)"
      >
        <span class="m-tab-icon">{{ { 配置: '⚙', 试运行: '▶', 回归集: '✅', 日志: '📜' }[p] }}</span>
        <span class="m-tab-label">{{ p }}</span>
      </button>
    </div>

    <!-- 岗位选择器 -->
    <template v-if="pickerOpen">
      <div class="m-scrim" @click="pickerOpen = false" />
      <div class="m-sheet">
        <div class="m-grab" />
        <div class="m-sheet-head"><span class="m-sheet-title">六个岗位</span></div>
        <div class="m-sheet-body">
          <button
            v-for="a in agents"
            :key="a.agent_key"
            class="m-agent-row"
            :class="{ active: a.agent_key === activeKey }"
            type="button"
            @click="pickAgent(a.agent_key)"
          >
            <div class="m-tags">
              <span class="m-row-strong">{{ a.name }}</span>
              <span v-if="a.has_draft" class="m-tag warn">草稿</span>
              <span class="m-spacer" />
              <!-- 成功率摆在右侧：切岗位时最该先看到的就是「哪个在掉」 -->
              <span v-if="a.success_rate !== null" :class="rateClass(a.success_rate)">
                24h {{ a.success_rate }}%
              </span>
            </div>
            <span class="m-row-sub">{{ a.tasks.join(' · ') }} · {{ a.running_version }}</span>
          </button>
        </div>
      </div>
    </template>

    <!-- 版本回滚放在岗位选择器之外的独立入口，避免误触 -->
    <template v-if="detail && pane === '配置' && detail.versions.length > 1">
      <div class="m-version-hint">
        历史版本 {{ detail.versions.length }} 个。
        <button
          class="m-btn link"
          type="button"
          @click="rollback(detail.versions[1].id, detail.versions[1].version)"
        >回滚到 {{ detail.versions[1].version }}</button>
      </div>
    </template>
  </div>
</template>
