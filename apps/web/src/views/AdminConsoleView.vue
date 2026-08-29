<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { api, type AgentSummary, type AgentDetail, type AgentRunLog } from '../api'

/**
 * Agent 配置与运行控制台。
 *
 * 面向产品管理员与调优人员，**不是医生端的第八个功能** —— 单独挂在 /admin，
 * 不占用 V4.3 定义的五个医生端页面，也不复用医生端的 scoped 样式。
 */

const loading = ref(false)
const agents = ref<AgentSummary[]>([])
const tiers = ref<{ tier: string; label: string; model: string }[]>([])
const bundleVersion = ref('')

const activeKey = ref('')
const detail = ref<AgentDetail | null>(null)
const runs = ref<AgentRunLog[]>([])
const tab = ref<'config' | 'versions' | 'runs'>('config')

/** 草稿编辑区。与已发布配置分开，未发布不影响线上。 */
const draft = ref({ model_tier: 'clinical_fast', role_prompt: '', note: '' })
const saving = ref(false)

const dirty = computed(() => {
  if (!detail.value) return false
  const base = detail.value.draft ?? detail.value.running
  return draft.value.role_prompt !== base.role_prompt || draft.value.model_tier !== base.model_tier
})

async function loadOverview() {
  loading.value = true
  try {
    const result = await api.adminAgents()
    agents.value = result.agents
    tiers.value = result.model_tiers
    bundleVersion.value = result.prompt_bundle_version
    if (!activeKey.value && result.agents.length) await select(result.agents[0].agent_key)
  } catch (error) {
    ElMessage.error(`加载失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function select(key: string) {
  activeKey.value = key
  detail.value = await api.adminAgent(key)
  const base = detail.value.draft ?? detail.value.running
  draft.value = {
    model_tier: base.model_tier,
    role_prompt: base.role_prompt,
    note: detail.value.draft?.note ?? '',
  }
  runs.value = (await api.adminRuns(key)).runs
}

async function saveDraft() {
  if (!detail.value) return
  saving.value = true
  try {
    await api.adminSaveDraft(activeKey.value, draft.value)
    ElMessage.success('草稿已保存，未发布不影响线上')
    await select(activeKey.value)
    await loadOverview()
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  } finally {
    saving.value = false
  }
}

async function publish() {
  await ElMessageBox.confirm(
    '发布后所有新的调用立即使用这一版配置。旧版本保留为历史，可随时回滚。',
    '确认发布',
    { type: 'warning' },
  )
  const result = await api.adminPublish(activeKey.value)
  ElMessage.success(`已发布 ${result.version}`)
  await select(activeKey.value)
  await loadOverview()
}

async function rollback(versionId: number, version: string) {
  await ElMessageBox.confirm(`回滚到 ${version}？当前生产版本会降为历史版本。`, '确认回滚', { type: 'warning' })
  await api.adminRollback(activeKey.value, versionId)
  ElMessage.success(`已回滚到 ${version}`)
  await select(activeKey.value)
  await loadOverview()
}

async function discard() {
  await ElMessageBox.confirm('丢弃草稿？未保存的改动会丢失。', '确认丢弃', { type: 'warning' })
  await api.adminDiscardDraft(activeKey.value)
  ElMessage.success('草稿已丢弃')
  await select(activeKey.value)
  await loadOverview()
}

function resetToCodeDefault() {
  if (!detail.value) return
  draft.value.role_prompt = detail.value.code_default_prompt
  ElMessage.info('已填入代码默认 Prompt，保存并发布后生效')
}

function statusType(status: string) {
  if (status === 'published') return 'success'
  if (status === 'draft') return 'warning'
  return 'info'
}

onMounted(loadOverview)
</script>

<template>
  <div class="admin-page">
    <header class="admin-header">
      <div class="admin-brand">
        <span class="admin-logo">⚙</span>
        <span class="admin-title">Agent 配置与运行控制台</span>
        <span class="admin-sub">Prompt 分层版本 {{ bundleVersion }}</span>
      </div>
      <div class="admin-header-right">
        <el-button size="small" @click="loadOverview">刷新</el-button>
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
            <span class="admin-tab" :class="{ active: tab === 'versions' }" @click="tab = 'versions'">
              版本 <em>{{ detail.versions.length }}</em>
            </span>
            <span class="admin-tab" :class="{ active: tab === 'runs' }" @click="tab = 'runs'">
              运行日志 <em>{{ runs.length }}</em>
            </span>
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
      </main>
    </div>
  </div>
</template>

<style scoped src="../styles/admin.css"></style>
