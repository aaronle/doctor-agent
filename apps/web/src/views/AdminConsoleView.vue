<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import MobileAdminConsole from '../mobile/MobileAdminConsole.vue'
import { api } from '../api'
import { useAdminConsole } from '../composables/useAdminConsole'
import { useDataConsole } from '../composables/useDataConsole'
import { useIsMobile } from '../composables/useMediaQuery'

/**
 * Agent 配置与运行控制台（桌面）。
 *
 * 面向产品管理员与调优人员，**不是医生端的第八个功能** —— 单独挂在 /admin，
 * 不占用 V4.3 定义的五个医生端页面，也不复用医生端的 scoped 样式。
 *
 * 状态全在 `useAdminConsole`，与移动版共用同一份。这里只负责桌面的排布。
 */

const isMobile = useIsMobile()

const {
  loading, agents, tiers, bundleVersion, activeKey, detail, runs, tab,
  draft, params, saving, dirty,
  dryPatient, comparing, comparison, changedFields, fieldText, runCompare,
  evaluating, evalResult, evalCases, datasets, togglingDataset, activeCaseCount,
  runEval, loadDatasets, toggleDataset,
  loadOverview, select, saveDraft, publish, rollback, discard, resetToCodeDefault, statusType,
} = useAdminConsole()

/* ===================== 数据看板 ===================== */

const dc = useDataConsole()
const dsFile = ref<HTMLInputElement | null>(null)
const kbFile = ref<HTMLInputElement | null>(null)
const uploadFailOpen = ref(false)
const kbOpen = ref(false)
const kbEditing = ref(false)
const kbForm = reactive({ key: '', title: '', keywords: '', content: '' })

/** 首次进「数据」页才拉数据 —— 别让不看这页的人白等四个请求 */
async function openData() {
  tab.value = 'data'
  if (!dc.usage.value) await dc.refresh()
}

/**
 * 条形长度按**本组最大值**归一，不按总和。
 *
 * 按总和的话，条目一多每根都短得看不出差别 —— 而这张图要回答的是
 * 「谁最多、差多少」，不是「各占几成」。
 */
function barPct(n: number, rows?: { count: number }[]) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.count))
  return `${Math.round((n / max) * 100)}%`
}

async function onDataset(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''      // 同一个文件改完再传要能再触发
  if (!f) return
  const ok = await dc.uploadDataset(f)
  ok ? ElMessage.success('测试集已入库') : (uploadFailOpen.value = true)
}

async function onKnowledge(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  const ok = await dc.importKnowledge(f)
  ok ? ElMessage.success('词条已导入') : (uploadFailOpen.value = true)
}

async function removeDataset(row: { id: string; name: string }) {
  await ElMessageBox.confirm(`删除测试集「${row.name}」？它的用例将不再参与评测。`, '确认', { type: 'warning' })
  await api.deleteDataset(row.id)
  await dc.refresh()
  ElMessage.success('已删除')
}

async function editKnowledge(key: string) {
  kbEditing.value = Boolean(key)
  if (key) {
    const d = await api.getKnowledge(key)
    Object.assign(kbForm, { key, title: d.title, keywords: (d.keywords ?? []).join(', '), content: d.content })
  } else {
    Object.assign(kbForm, { key: '', title: '', keywords: '', content: '' })
  }
  kbOpen.value = true
}

async function saveKnowledge() {
  if (!kbForm.key.trim() || !kbForm.title.trim()) {
    ElMessage.warning('key 与标题都不能为空')
    return
  }
  const r = await api.saveKnowledge(kbForm.key.trim(), {
    key: kbForm.key.trim(),
    title: kbForm.title.trim(),
    keywords: kbForm.keywords.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
    content: kbForm.content,
  })
  kbOpen.value = false
  await dc.refresh()
  // 消毒改动过内容就明说 —— 悄悄改掉别人写的东西是最难查的那类问题
  ElMessage.success(r.sanitized ? '已保存（正文中的脚本/事件属性已被转义）' : '已保存')
}

async function removeKnowledge(row: { key: string; title: string; source: string }) {
  const extra = row.source === 'builtin' ? '这是内置词条，删除会在库里写一条墓碑，升级后仍然不出现。' : ''
  await ElMessageBox.confirm(`删除词条「${row.title}」？${extra}`, '确认', { type: 'warning' })
  await api.deleteKnowledge(row.key)
  await dc.refresh()
  ElMessage.success('已删除')
}

onMounted(async () => {
  await loadOverview()
  await loadDatasets()
})
</script>

<template>
  <!--
    控制台移动端是另一套 IA：左右分栏改「顶部岗位切换 + 底部四档」。
    与医生端不同，这里**保留写入动作** —— 改的是 Agent 配置，不是病历。
  -->
  <MobileAdminConsole v-if="isMobile" />

  <div v-else class="admin-page">
    <header class="admin-header">
      <div class="admin-brand">
        <span class="admin-logo">⚙</span>
        <span class="admin-title">Agent 配置与运行控制台</span>
        <span class="admin-sub">Prompt 分层版本 {{ bundleVersion }}</span>
      </div>
      <div class="admin-header-right">
        <el-button size="small" @click="loadOverview">刷新</el-button>
        <el-button size="small" @click="$router.push('/delivery')">交付平台</el-button>
        <el-button size="small" @click="$router.push('/outpatient/list')">返回医生站</el-button>
      </div>
    </header>

    <div v-loading="loading" class="admin-body">
      <!-- 岗位总览 -->
      <aside class="admin-side">
        <div class="admin-side-title">六个岗位</div>
        <div
          v-for="agent in agents"
          :key="agent.agent_key"
          class="agent-item"
          :class="{ active: agent.agent_key === activeKey }"
          @click="select(agent.agent_key)"
        >
          <div class="agent-item-top">
            <span class="agent-item-name">{{ agent.name }}</span>
            <el-tag v-if="agent.has_draft" size="small" type="warning" effect="plain">草稿</el-tag>
          </div>
          <div class="agent-item-meta">{{ agent.tasks.join(' · ') }}</div>
          <div class="agent-item-foot">
            <span class="agent-ver">{{ agent.running_version }}</span>
            <span class="agent-src" :class="agent.config_source">
              {{ agent.config_source === 'published' ? '已发布配置' : '代码默认' }}
            </span>
            <span v-if="agent.success_rate !== null" class="agent-rate" :class="{ bad: agent.success_rate < 90 }">
              24h {{ agent.success_rate }}%
            </span>
          </div>
        </div>
      </aside>

      <main v-if="detail" class="admin-main">
        <div class="admin-main-head">
          <div>
            <span class="main-title">{{ detail.name }}</span>
            <span class="main-tasks">{{ detail.tasks.join(' · ') }}</span>
          </div>
          <div class="admin-tabs">
            <span class="admin-tab" :class="{ active: tab === 'config' }" @click="tab = 'config'">配置</span>
            <span class="admin-tab" :class="{ active: tab === 'tune' }" @click="tab = 'tune'">试运行</span>
            <span class="admin-tab" :class="{ active: tab === 'eval' }" @click="tab = 'eval'">试跑测试集</span>
            <span class="admin-tab" :class="{ active: tab === 'versions' }" @click="tab = 'versions'">
              版本 <em>{{ detail.versions.length }}</em>
            </span>
            <span class="admin-tab" :class="{ active: tab === 'runs' }" @click="tab = 'runs'">
              运行日志 <em>{{ runs.length }}</em>
            </span>
            <span class="admin-tab" :class="{ active: tab === 'data' }" @click="openData">数据</span>
          </div>
        </div>

        <!-- 配置 -->
        <section v-show="tab === 'config'" class="admin-pane">
          <div class="cfg-card locked">
            <div class="cfg-card-head">
              <span class="cfg-title">平台安全层</span>
              <el-tag size="small" type="danger" effect="plain">不可编辑</el-tag>
            </div>
            <p class="cfg-hint">
              只能随代码发布。安全层若可编辑，「不得自行确诊」「缺失写未获得」这类红线就成了摆设 ——
              所以这里只读展示，让你看得到自己改不了什么。
            </p>
            <pre class="cfg-readonly">{{ detail.safety_layer }}</pre>
          </div>

          <div class="cfg-card">
            <div class="cfg-card-head">
              <span class="cfg-title">岗位层 Prompt</span>
              <div class="cfg-actions">
                <el-button size="small" link @click="resetToCodeDefault">填入代码默认值</el-button>
              </div>
            </div>
            <el-input v-model="draft.role_prompt" type="textarea" :rows="12" placeholder="岗位职责与硬性要求" />
          </div>

          <div class="cfg-card">
            <div class="cfg-card-head"><span class="cfg-title">模型档位</span></div>
            <p class="cfg-hint">
              档位是稳定别名，业务代码只认档位不认具体模型名 —— 换 Haiku 版本或接院内模型时，医生端调用协议不动。
            </p>
            <el-radio-group v-model="draft.model_tier">
              <el-radio v-for="t in tiers" :key="t.tier" :value="t.tier" class="tier-radio">
                <span class="tier-name">{{ t.tier }}</span>
                <span class="tier-label">{{ t.label }}</span>
                <code class="tier-model">{{ t.model }}</code>
              </el-radio>
            </el-radio-group>
          </div>

          <div class="cfg-card">
            <div class="cfg-card-head"><span class="cfg-title">发布说明</span></div>
            <el-input v-model="draft.note" placeholder="这一版改了什么、为什么改" />
          </div>

          <div class="cfg-bar">
            <span class="cfg-state">
              当前生效：<strong>{{ detail.running.version }}</strong>
              （{{ detail.running.source === 'published' ? '已发布配置' : '代码默认' }}）
              <template v-if="dirty"> · <em class="dirty">有未保存改动</em></template>
            </span>
            <div class="cfg-bar-actions">
              <el-button v-if="detail.draft" size="small" @click="discard">丢弃草稿</el-button>
              <el-button size="small" :loading="saving" @click="saveDraft">保存草稿</el-button>
              <el-button type="primary" size="small" :disabled="!detail.draft && !dirty" @click="publish">
                发布
              </el-button>
            </div>
          </div>
        </section>

        <!-- 版本历史 -->
        <!-- ---------------- 试运行与并排对比 ---------------- -->
        <section v-show="tab === 'tune'" class="admin-pane">
          <div class="tune-bar">
            <span class="tune-label">病例</span>
            <el-select v-model="dryPatient" size="small" style="width: 200px">
              <el-option value="P001" label="P001 王某某 · 内分泌" />
              <el-option value="P002" label="P002 张某 · 心内" />
              <el-option value="P004" label="P004 陈某 · 神内" />
              <el-option value="P006" label="P006 赵某某 · 神内" />
            </el-select>
            <el-button type="primary" size="small" :loading="comparing" @click="runCompare">
              试运行并对比
            </el-button>
            <span class="tune-note">
              试运行不写缓存 · 不落库 · 不计入运行统计 · 仅限演示病例
            </span>
          </div>

          <div v-if="!comparison && !comparing" class="tune-empty">
            选一个病例，用当前草稿跑一次，与线上并排对照。<br>
            没有这一步，改完提示词只能盲发 —— 而改动一旦发布就已经在给医生用了。
          </div>

          <div v-if="comparison" class="tune-cols">
            <div v-for="side in (['published', 'draft'] as const)" :key="side" class="tune-col">
              <div class="tune-col-head">
                <span class="tune-tag" :class="side">{{ side === 'draft' ? '草稿' : '线上' }}</span>
                <span class="tune-ver">
                  {{ comparison[side].config_version }} · {{ comparison[side].config_source }}
                </span>
              </div>
              <div class="tune-metrics">
                <div class="tune-metric">
                  <span class="tm-k">耗时</span>
                  <span class="tm-v">{{ (comparison[side].elapsed_ms / 1000).toFixed(1) }}s</span>
                </div>
                <div class="tune-metric">
                  <span class="tm-k">Token</span>
                  <span class="tm-v">{{ comparison[side].total_tokens.toLocaleString() }}</span>
                </div>
                <div class="tune-metric">
                  <span class="tm-k">降级</span>
                  <span class="tm-v" :class="comparison[side].degraded ? 'bad' : 'good'">
                    {{ comparison[side].degraded ? '是' : '无' }}
                  </span>
                </div>
              </div>
              <!-- 只列变化过的字段：几十个 same 会把两条真差异淹掉 -->
              <div class="tune-out">
                <div v-if="!changedFields.length" class="tune-same">两侧输出完全一致</div>
                <div v-for="d in changedFields" :key="d.field" class="tune-field" :class="d.kind">
                  <div class="tf-head">
                    <span class="tf-kind">{{ d.kind === 'added' ? '新增' : d.kind === 'removed' ? '删除' : '变化' }}</span>
                    <span class="tf-name">{{ d.field }}</span>
                  </div>
                  <pre class="tf-body">{{ fieldText(side, d.field) }}</pre>
                </div>
              </div>
            </div>
          </div>

          <div v-if="comparison && (comparison.published.degraded || comparison.draft.degraded)" class="tune-warn">
            有一侧降级了 —— 降级输出来自本地规则，这次对比说明不了提示词的好坏，请重跑。
          </div>
        </section>

        <!-- ---------------- 回归集 ---------------- -->
        <section v-show="tab === 'eval'" class="admin-pane">
          <div class="tune-bar">
            <el-button type="primary" size="small" :loading="evaluating" @click="runEval">
              用草稿跑回归集
            </el-button>
            <template v-if="evalResult">
              <span class="eval-stat"><i>通过</i><b class="good">{{ evalResult.passed }}</b></span>
              <span class="eval-stat"><i>失败</i><b class="bad">{{ evalResult.failed }}</b></span>
              <span class="eval-stat"><i>用例</i><b>{{ evalResult.total }}</b></span>
              <span v-if="evalResult.datasets?.length" class="eval-stat ds">
                <i>数据集</i><b>{{ evalResult.datasets.map((d) => d.name).join('、') }}</b>
              </span>
            </template>
            <span class="tune-note">校验全部是确定性规则，不用模型给模型打分</span>
          </div>

          <!--
            数据集管理。用例来自 data/eval_datasets/*.json，开关落库。
            把「跑了哪几集」摆在结果上方，是因为通过率必须有分母 ——
            关掉半个数据集也能把百分比刷上去。
          -->
          <div class="ds-panel">
            <div class="ds-panel-head">
              <span class="ds-panel-title">评测数据集</span>
              <span class="ds-panel-note">
                停用的不参与运行。当前岗位共 <b>{{ activeCaseCount }}</b> 条用例会跑。
              </span>
            </div>
            <div v-for="ds in datasets" :key="ds.id" class="ds-row" :class="{ off: !ds.enabled, broken: !!ds.error }">
              <el-switch
                :model-value="ds.enabled"
                :disabled="!!ds.error || togglingDataset === ds.id"
                size="small"
                @change="(v: boolean) => toggleDataset(ds, v)"
              />
              <div class="ds-main">
                <div class="ds-title">
                  {{ ds.name }}
                  <span class="ds-tag">{{ ds.source }}</span>
                  <span class="ds-count">{{ ds.case_count }} 条 · {{ ds.agents.join('/') || '—' }}</span>
                </div>
                <div class="ds-desc">{{ ds.description }}</div>
                <div v-if="ds.reference" class="ds-ref">依据：{{ ds.reference }}</div>
                <!-- 加载失败的照样列出来，带着原因。静默藏起来等于少跑一集却看不出来 -->
                <div v-if="ds.error" class="ds-error">✕ 加载失败，本集不参与运行：{{ ds.error }}</div>
              </div>
            </div>
            <div v-if="!datasets.length" class="ds-empty">还没有任何数据集。</div>
          </div>

          <div v-if="!evalResult && !evaluating" class="tune-empty">
            <div>该岗位共 {{ evalCases.length }} 条用例。改提示词修好一个病例、弄坏另一个，是这类工作最常见的失败模式 —— 单次试运行看不出来。</div>
            <ul class="eval-preview">
              <li v-for="c in evalCases" :key="c.id">
                <b>{{ c.id }}</b> {{ c.name }} · {{ c.patient_id }}
                <span class="eval-ds">{{ c.dataset_name }}</span>
                <span class="eval-checks">{{ c.checks.join(' / ') }}</span>
              </li>
            </ul>
          </div>

          <div v-if="evalResult" class="eval-list">
            <div v-for="c in evalResult.cases" :key="c.case_id" class="eval-case" :class="{ failed: !c.passed }">
              <div class="ec-head">
                <span class="ec-mark" :class="c.passed ? 'good' : 'bad'">{{ c.passed ? '✓' : '✕' }}</span>
                <span class="ec-id">{{ c.case_id }} {{ c.name }}</span>
                <span class="ec-meta">{{ c.patient_id }} · {{ (c.elapsed_ms / 1000).toFixed(1) }}s</span>
                <span v-if="c.degraded" class="ec-degraded">降级 · 本次判定不说明提示词好坏</span>
              </div>
              <div class="ec-checks">
                <span v-for="k in c.checks" :key="k.name" class="ec-chip" :class="k.passed ? 'good' : 'bad'">
                  {{ k.passed ? '✓' : '✕' }} {{ k.name }}
                </span>
              </div>
              <div v-for="k in c.checks.filter((x) => !x.passed && x.detail)" :key="`d-${k.name}`" class="ec-detail">
                └ {{ k.detail }}
              </div>
            </div>
          </div>
        </section>

        <section v-show="tab === 'versions'" class="admin-pane">
          <el-table :data="detail.versions" size="small" border stripe>
            <el-table-column prop="version" label="版本" width="80" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="statusType(row.status)" effect="light">
                  {{ row.status === 'published' ? '生产' : row.status === 'draft' ? '草稿' : '历史' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="model_tier" label="模型档位" width="150" />
            <el-table-column prop="prompt_hash" label="Prompt 哈希" width="140" />
            <el-table-column prop="note" label="发布说明" min-width="200" />
            <el-table-column prop="published_at" label="发布时间" width="180" />
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.status === 'inactive'"
                  type="primary"
                  size="small"
                  link
                  @click="rollback(row.id, row.version)"
                >
                  回滚
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <!-- 运行日志 -->
        <section v-show="tab === 'runs'" class="admin-pane">
          <p class="cfg-hint">
            只展示定位问题所需的摘要 —— <strong>不含完整输出与病历内容</strong>，运行日志不应成为病历副本。
          </p>
          <el-table :data="runs" size="small" border stripe>
            <el-table-column prop="created_at" label="时间" width="180" />
            <el-table-column prop="patient_id" label="患者" width="80" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'ok' ? 'success' : 'warning'" effect="light">
                  {{ row.status === 'ok' ? '成功' : '降级' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="config_version" label="配置版本" width="100" />
            <el-table-column prop="model_tier" label="档位" width="150" />
            <el-table-column prop="elapsed_ms" label="耗时(ms)" width="100" />
            <el-table-column prop="total_tokens" label="Token" width="90" />
            <el-table-column prop="context_hash" label="上下文哈希" width="140" />
            <el-table-column prop="error" label="错误" min-width="200" />
          </el-table>
        </section>
        <!-- 数据看板 -->
        <section v-show="tab === 'data'" class="admin-pane data-pane">
          <div class="tune-bar">
            <el-radio-group v-model="dc.usageDays.value" size="small" @change="dc.refresh">
              <el-radio-button :value="7">近 7 天</el-radio-button>
              <el-radio-button :value="30">近 30 天</el-radio-button>
            </el-radio-group>
            <el-button size="small" :loading="dc.loading.value" @click="dc.refresh">刷新</el-button>
            <span class="tune-note">上传的内容进数据库 —— 容器只读，写进镜像里一次部署就没了</span>
          </div>
          <el-alert v-if="dc.error.value" type="error" :closable="false" :title="dc.error.value" />

          <!-- 埋点 -->
          <h3 class="data-h">使用埋点<em>医生实际点了什么 —— HTTP 日志答不了这个</em></h3>
          <div class="data-metrics">
            <div class="dm"><i>总事件</i><b>{{ dc.usage.value?.total_events ?? 0 }}</b></div>
            <div class="dm"><i>会话数</i><b>{{ dc.usage.value?.sessions ?? 0 }}</b></div>
            <div class="dm accent">
              <i>人均次数</i><b>{{ dc.usage.value?.per_session ?? 0 }}</b>
              <span>只看总量会被一个人狂点刷上去</span>
            </div>
          </div>
          <div class="data-cols">
            <div class="data-card">
              <div class="data-card-h">按功能<em>点一行看细分</em></div>
              <div
                v-for="row in dc.usage.value?.by_event ?? []" :key="row.event"
                class="bar-row" :class="{ on: dc.drillEvent.value === row.event }"
                @click="dc.drillEvent.value = row.event"
              >
                <span class="bar-name">{{ row.event }}</span>
                <span class="bar-track"><i :style="{ width: barPct(row.count, dc.usage.value?.by_event) }" /></span>
                <span class="bar-num">{{ row.count }}</span>
              </div>
              <p v-if="!dc.usage.value?.by_event?.length" class="data-empty">还没有埋点数据</p>
            </div>
            <div class="data-card">
              <div class="data-card-h">{{ dc.drillEvent.value || '细分' }}<em>按作用对象</em></div>
              <div v-for="row in dc.drillRows.value" :key="row.target" class="bar-row">
                <span class="bar-name">{{ row.target }}</span>
                <span class="bar-track"><i :style="{ width: barPct(row.count, dc.drillRows.value) }" /></span>
                <span class="bar-num">{{ row.count }}</span>
              </div>
              <p v-if="!dc.drillRows.value.length" class="data-empty">这个事件没有细分维度</p>
            </div>
          </div>

          <!-- 测试集 -->
          <h3 class="data-h">测试集<em>固定病例 + 确定性校验，防「改提示词修好一个、弄坏另一个」</em></h3>
          <el-table :data="dc.datasets.value" size="small" border stripe>
            <el-table-column prop="name" label="数据集" min-width="180" />
            <el-table-column prop="case_count" label="用例" width="70" />
            <el-table-column label="来源" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.builtin ? 'info' : 'primary'" effect="light">
                  {{ row.builtin ? '内置' : '上传' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="岗位" min-width="160">
              <template #default="{ row }">{{ row.agents.join('、') || '—' }}</template>
            </el-table-column>
            <el-table-column prop="error" label="加载错误" min-width="140" />
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <span v-if="row.builtin" class="data-muted">内置不可删</span>
                <el-button v-else text type="danger" size="small" @click="removeDataset(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="data-upload">
            <input ref="dsFile" type="file" accept=".json,application/json" hidden @change="onDataset">
            <el-button type="primary" size="small" @click="dsFile?.click()">上传测试集 .json</el-button>
            <span class="data-muted">全对才收 —— 半个数据集给出的通过率是误导性的</span>
          </div>

          <!-- 知识库 -->
          <h3 class="data-h">
            知识库<em>给模型查的临床资料</em>
            <el-tag v-if="dc.emptyCount.value" size="small" type="warning" effect="light">
              {{ dc.emptyCount.value }} 条正文为空
            </el-tag>
          </h3>
          <el-table :data="dc.knowledge.value" size="small" border stripe>
            <el-table-column prop="title" label="词条" min-width="160" />
            <el-table-column label="关键词" min-width="220">
              <template #default="{ row }">{{ row.keywords.join(' / ') }}</template>
            </el-table-column>
            <el-table-column label="正文" width="90">
              <template #default="{ row }">
                <span :class="row.content_length ? 'good' : 'bad'">
                  {{ row.content_length ? row.content_length + ' 字' : '空' }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.source === 'builtin' ? 'info' : 'primary'" effect="light">
                  {{ row.source === 'builtin' ? '内置' : '本院' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button text type="primary" size="small" @click="editKnowledge(row.key)">编辑</el-button>
                <el-button text type="danger" size="small" @click="removeKnowledge(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="data-upload">
            <el-button type="primary" size="small" @click="editKnowledge('')">＋ 新增词条</el-button>
            <input ref="kbFile" type="file" accept=".json,application/json" hidden @change="onKnowledge">
            <el-button size="small" @click="kbFile?.click()">批量导入 .json</el-button>
            <span class="data-muted">内置词条也能删 —— 库里写墓碑，读取时跳过；升级不丢本院内容</span>
          </div>

          <!-- 微调语料 -->
          <h3 class="data-h">微调语料<em>值钱的不是「AI 输出了什么」，是「医生改了什么」</em></h3>
          <div class="data-metrics">
            <div class="dm"><i>总条数</i><b>{{ dc.training.value?.total ?? 0 }}</b></div>
            <div class="dm accent"><i>可训练</i><b>{{ dc.training.value?.trainable_count ?? 0 }}</b>
              <span>真实院内数据默认不可训练，要人工过完合规才翻</span></div>
            <div v-for="v in dc.training.value?.by_verdict ?? []" :key="v.verdict" class="dm">
              <i>{{ v.verdict }}</i><b>{{ v.count }}</b>
            </div>
          </div>
          <el-table :data="dc.training.value?.recent ?? []" size="small" border stripe>
            <el-table-column prop="created_at" label="时间" width="180" />
            <el-table-column prop="patient_id" label="病例" width="80" />
            <el-table-column prop="agent_key" label="岗位" width="100" />
            <el-table-column prop="verdict" label="判定" width="100" />
            <el-table-column label="改了什么" min-width="220">
              <template #default="{ row }">{{ row.changed_fields.join('、') || '—' }}</template>
            </el-table-column>
            <el-table-column prop="source" label="来源" width="90" />
          </el-table>
          <p class="cfg-hint">
            列表<strong>不带病历正文</strong> —— 概览页不需要原文；顺手塞进一个随手可访问的接口，等于给自己开了个数据出口。
          </p>
        </section>
      </main>
    </div>

    <!-- 上传校验失败：逐条列出，别只说「格式不对」 -->
    <el-dialog v-model="uploadFailOpen" title="校验失败 · 不入库" width="640px">
      <p class="data-muted">{{ dc.uploadName.value }}</p>
      <ul class="data-errs"><li v-for="(e, i) in dc.uploadErrors.value" :key="i">{{ e }}</li></ul>
      <p class="cfg-hint">全对才收 —— 一半进去一半报错，没人知道究竟进去了哪些。</p>
    </el-dialog>

    <!-- 词条编辑 -->
    <el-dialog v-model="kbOpen" :title="kbForm.key ? '编辑词条' : '新增词条'" width="680px">
      <el-form label-width="86px" size="small">
        <el-form-item label="key">
          <el-input v-model="kbForm.key" :disabled="kbEditing" placeholder="英文短标识，如 kl_grade" />
        </el-form-item>
        <el-form-item label="标题"><el-input v-model="kbForm.title" /></el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="kbForm.keywords" placeholder="逗号分隔 —— 没有关键词就永远匹配不上" />
        </el-form-item>
        <el-form-item label="正文">
          <el-input v-model="kbForm.content" type="textarea" :rows="10" />
        </el-form-item>
      </el-form>
      <p class="cfg-hint">
        正文写入前<strong>消毒</strong>：只保留排版标签，脚本与事件属性一律转义 ——
        正文可编辑之后，前端 v-html 渲染就不再天然安全了。
      </p>
      <template #footer>
        <el-button size="small" @click="kbOpen = false">取消</el-button>
        <el-button type="primary" size="small" @click="saveKnowledge">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped src="../styles/admin.css"></style>
