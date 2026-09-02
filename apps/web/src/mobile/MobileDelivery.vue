<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { STAGE_MARK, useDelivery } from '../composables/useDelivery'
import type { DeliveryReleaseItem } from '../api'

/**
 * 交付平台（移动端）。
 *
 * **只读，不改配置、不编 Prompt。** 与「移动端不写回 HIS/EMR」同一条理由：
 * 小屏上改 Prompt，改错了看不出来。界面第一屏就把这句写出来，
 * 免得有人到处找编辑入口。
 *
 * 唯一保留的写动作是**智能体回滚** —— 那是出事时最需要在手机上做的一件事，
 * 且有确认弹层兜着，弹层里把「不重启、镜像 tag 不会变」讲清楚。
 */

const d = useDelivery()
const { loading, error, pipelines, releases, production, featureRun, agentRun, passRateText, allPassed, loadAll, rollbackAgent } = d

type Pane = 'pipelines' | 'artifact' | 'releases' | 'env'
const pane = ref<Pane>('pipelines')

onMounted(loadAll)

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)
const fmtAt = (at: string | null) => (at ? at.replace('T', ' ').slice(5, 16) : '—')

async function onRollback(item: DeliveryReleaseItem) {
  if (item.kind === 'feature') {
    await ElMessageBox.alert(
      '功能制品回滚要换镜像重建容器，平台不持有生产凭据，手机上做不了。请在开发机上执行。',
      '这一步平台做不了',
      { confirmButtonText: '知道了' },
    )
    return
  }
  try {
    await ElMessageBox.confirm(
      '智能体回滚不重启、不换镜像 —— 把这一版重新置为 published，下一次调用即生效。所以镜像 tag 不会变，事后查「生产上是哪一版」要看环境页的两栏。',
      `回滚到 ${item.meta.version ?? item.ref}？`,
      { confirmButtonText: '确认回滚', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    await rollbackAgent(item)
    ElMessage.success('已回滚，下一次调用即生效')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '回滚失败')
  }
}

const TABS = [
  { key: 'pipelines', icon: '📊', label: '流水线' },
  { key: 'artifact', icon: '📦', label: '制品' },
  { key: 'releases', icon: '🕐', label: '历史' },
  { key: 'env', icon: '🌐', label: '环境' },
] as const
</script>

<template>
  <div class="md-page">
    <header class="md-top">
      <span class="md-logo">⚙</span>
      <div class="md-titles">
        <div class="md-sub">Doctor Agent</div>
        <div class="md-title">交付平台</div>
      </div>
      <span class="md-spacer" />
      <button class="md-refresh" :disabled="loading" @click="loadAll">↻ 刷新</button>
    </header>

    <div v-if="error" class="md-error">
      交付平台读取失败：{{ error }}（平台自身的问题，不代表流水线的状态）
    </div>

    <main class="md-body">
      <!-- ------------------------------------------------ 流水线 -->
      <template v-if="pane === 'pipelines'">
        <!-- 第一屏就说清楚这里能做什么、不能做什么 -->
        <p class="md-note md-note-blue">
          手机上只看两件事：现在卡在哪、能不能放行。改配置、编 Prompt 一律回桌面 ——
          小屏上改 Prompt，改错了看不出来。
        </p>

        <article
          v-for="lane in ([
            { key: 'feature', label: '功能线', run: featureRun },
            { key: 'agent', label: '智能体线', run: agentRun },
          ] as const)"
          :key="lane.key"
          class="md-card"
        >
          <div class="md-card-head">
            <span class="md-chip" :class="`kind-${lane.key}`">{{ lane.label }}</span>
            <span class="md-spacer" />
            <span v-if="lane.run" class="md-chip" :class="`st-${lane.run.status}`">{{ lane.run.status }}</span>
          </div>
          <p v-if="!lane.run" class="md-empty">还没有上报过运行。</p>
          <template v-else>
            <div class="md-card-title">{{ lane.run.title || lane.run.run_key }}</div>
            <ul class="md-stages">
              <li
                v-for="s in lane.run.stages"
                :key="s.name"
                class="md-stage"
                :class="`tone-${STAGE_MARK[s.status].tone}`"
              >
                <span class="md-stage-icon">{{ STAGE_MARK[s.status].icon }}</span>
                <span class="md-stage-name">{{ s.name }}</span>
                <span class="md-spacer" />
                <span class="md-stage-time">{{ s.elapsed_ms ? fmtMs(s.elapsed_ms) : '' }}</span>
              </li>
            </ul>
            <p v-if="passRateText(lane.run)" class="md-rate" :class="{ 'is-clean': allPassed(lane.run) }">回归集 {{ passRateText(lane.run) }}</p>
          </template>
        </article>

        <p class="md-note">
          两条线不合并：功能线失败是「构建挂了」，智能体线失败是「输出退化了」——
          后者测试照样全绿，混在一起就看不出区别。
        </p>
      </template>

      <!-- ------------------------------------------------ 制品 -->
      <template v-else-if="pane === 'artifact'">
        <p v-if="!featureRun" class="md-empty">功能线还没有上报过运行。</p>
        <template v-else>
          <article class="md-card">
            <div class="md-card-head">
              <span class="md-mono md-strong">{{ featureRun.meta.commit }}</span>
              <span class="md-spacer" />
              <span class="md-chip" :class="`st-${featureRun.status}`">{{ featureRun.status }}</span>
            </div>
            <div class="md-card-title">{{ featureRun.meta.subject }}</div>
            <ul class="md-stages">
              <li
                v-for="g in (featureRun.meta.gates ?? [])"
                :key="g.key"
                class="md-stage"
                :class="g.ok ? 'tone-ok' : 'tone-bad'"
              >
                <span class="md-stage-icon">{{ g.ok ? '✓' : '✕' }}</span>
                <span class="md-stage-name">{{ g.label }}</span>
                <span class="md-spacer" />
                <span class="md-stage-time">{{ g.detail }}</span>
              </li>
            </ul>
          </article>

          <article v-if="featureRun.meta.log?.length" class="md-console">
            <div class="md-console-head">构建日志</div>
            <div
              v-for="(l, i) in featureRun.meta.log"
              :key="i"
              class="md-console-line"
              :class="`log-${l[2]}`"
            >{{ l[1] }}</div>
          </article>
        </template>
      </template>

      <!-- ------------------------------------------------ 历史 -->
      <template v-else-if="pane === 'releases'">
        <p class="md-note">
          两种制品同一条时间线 —— 排查「什么时候开始不对的」时，最需要知道的就是这两者谁先动的。
        </p>
        <article
          v-for="item in (releases?.items ?? [])"
          :key="`${item.kind}-${item.ref}`"
          class="md-card"
          :class="`st-row-${item.status}`"
        >
          <div class="md-card-head">
            <span class="md-at">{{ fmtAt(item.at) }}</span>
            <span class="md-chip" :class="`kind-${item.kind}`">
              {{ item.kind === 'feature' ? '功能' : '智能体' }}
            </span>
            <span class="md-spacer" />
            <span v-if="item.status === 'current'" class="md-chip st-passed">● 当前生产</span>
            <span v-else-if="item.status === 'rolled_back'" class="md-chip st-rolled">已回滚</span>
          </div>
          <div class="md-card-title">{{ item.title }}</div>
          <div class="md-card-detail">{{ item.detail }}</div>
          <button v-if="item.can_rollback" class="md-btn" @click="onRollback(item)">回滚到这一版</button>
        </article>
      </template>

      <!-- ------------------------------------------------ 环境 -->
      <template v-else>
        <p v-if="!production" class="md-empty">读取生产指纹失败。</p>
        <template v-else>
          <p class="md-note">{{ production.note }}</p>
          <article class="md-card">
            <div class="md-card-title">来自镜像（换镜像才会变）</div>
            <div class="md-kv"><span>版本</span><b class="md-mono">{{ production.from_image.release }}</b></div>
            <div class="md-kv"><span>提交</span><b class="md-mono">{{ production.from_image.commit || '—' }}</b></div>
            <div class="md-kv"><span>快档模型</span><b class="md-mono">{{ production.from_image.model_fast }}</b></div>
            <div class="md-kv"><span>慢档模型</span><b class="md-mono">{{ production.from_image.model_smart }}</b></div>
            <div class="md-kv"><span>编排模型</span><b class="md-mono">{{ production.from_image.model_orchestration }}</b></div>
            <div class="md-kv"><span>模型超时</span><b class="md-mono">{{ production.from_image.timeout_ms }}ms</b></div>
          </article>
          <article class="md-card">
            <div class="md-card-title">来自数据库（不重启即可变）</div>
            <div v-for="a in production.from_database.agents" :key="a.agent_key" class="md-kv">
              <span>{{ a.label }}</span>
              <b class="md-mono" :class="{ 'md-code-default': a.source === 'code_default' }">
                {{ a.version }}{{ a.source === 'code_default' ? ' · 代码兜底' : '' }}
              </b>
            </div>
            <div class="md-kv">
              <span>数据集开关</span>
              <b class="md-mono">{{ production.from_database.datasets_enabled }} 开 / {{ production.from_database.datasets_disabled }} 关</b>
            </div>
          </article>
          <p v-if="pipelines" class="md-note">{{ pipelines.deploy_note }}</p>
        </template>
      </template>
    </main>

    <nav class="md-tabbar">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="md-tab"
        :class="{ 'is-active': pane === t.key }"
        @click="pane = t.key"
      >
        <span class="md-tab-icon">{{ t.icon }}</span>
        <span class="md-tab-label">{{ t.label }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
/*
  移动端整页自己管滚动。全局 tokens 里 html,body 是 overflow:hidden ——
  在手机上那不是「不滚动」，是「溢出的部分永远够不着」。
*/
.md-page { display: flex; flex-direction: column; height: 100dvh; background: #f5f7fa; overflow: hidden; }
.md-top { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #fff; border-bottom: 1px solid #e6e8eb; flex: 0 0 auto; }
.md-logo { font-size: 15px; }
.md-titles { line-height: 1.25; }
.md-sub { font-size: 10px; color: #8a9099; }
.md-title { font-size: 15px; font-weight: 700; color: #1f2329; }
.md-spacer { flex: 1 1 auto; }
/* 16px 起步：iOS Safari 对小于 16px 的可交互元素会自动放大且不会缩回去 */
.md-refresh { font-size: 16px; padding: 6px 10px; border: 1px solid #dcdfe6; border-radius: 6px; background: #fff; color: #414750; }
.md-error { margin: 8px 12px 0; padding: 8px 10px; border-radius: 8px; background: #fff2f0; border: 1px solid #ffccc7; color: #cf1322; font-size: 12px; line-height: 1.6; }
.md-body { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }

.md-card { background: #fff; border: 1px solid #e6e8eb; border-radius: 10px; padding: 10px 11px; }
.md-card.st-row-current { border-color: #b7cbf2; }
.md-card.st-row-rolled_back { opacity: 0.75; background: #fafbfc; }
.md-card-head { display: flex; align-items: center; gap: 6px; }
.md-card-title { font-size: 12px; font-weight: 600; color: #1f2329; margin-top: 4px; line-height: 1.5; }
.md-card-detail { font-size: 11px; color: #8a9099; margin-top: 2px; line-height: 1.6; }
.md-at { font-size: 10px; color: #8a9099; font-variant-numeric: tabular-nums; }
.md-chip { font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 4px; background: #f2f3f5; color: #6b7280; }
.kind-feature { background: #edf3ff; color: #1677ff; }
.kind-agent { background: #f2f3f5; color: #6b7280; }
.st-passed, .st-deployed { background: #edfaed; color: #16a34a; }
.st-failed, .st-blocked { background: #fff1f0; color: #cf1322; }
.st-running { background: #edf3ff; color: #1677ff; }
.st-rolled { background: #fff7e6; color: #d97706; }

.md-note { font-size: 11px; color: #8a9099; line-height: 1.7; margin: 0; padding: 9px 11px; background: #fff; border: 1px solid #e6e8eb; border-radius: 10px; }
.md-note-blue { background: #f4f8ff; border-color: #d2e2fc; color: #414750; }
.md-empty { font-size: 11px; color: #8a9099; padding: 12px; text-align: center; }

.md-stages { list-style: none; margin: 6px 0 0; padding: 0; }
.md-stage { display: flex; align-items: center; gap: 7px; padding: 4px 0; font-size: 11px; }
.md-stage-icon { width: 12px; text-align: center; font-weight: 700; }
.md-stage-name { color: #414750; font-weight: 500; }
.md-stage-time { color: #b0b5bd; font-size: 10px; }
.tone-ok .md-stage-icon { color: #16a34a; }
.tone-run .md-stage-icon { color: #1677ff; }
.tone-bad .md-stage-icon { color: #cf1322; }
.tone-idle .md-stage-icon, .tone-mute .md-stage-icon { color: #c0c4cc; }
.tone-idle .md-stage-name { color: #b0b5bd; }
.md-rate { font-size: 11px; font-weight: 600; color: #d97706; margin: 6px 0 0; }
.md-rate.is-clean { color: #16a34a; }

.md-console { background: #1f2329; border-radius: 10px; padding: 9px 11px; overflow-x: auto; }
.md-console-head { font-size: 11px; font-weight: 700; color: #fff; margin-bottom: 4px; }
.md-console-line { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; line-height: 1.8; white-space: pre; }
.log-dim { color: #8a9099; }
.log-ok { color: #4ade80; }
.log-err { color: #f87171; }
.log-fix { color: #fbbf24; }

.md-kv { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; padding: 3px 0; }
.md-kv span { color: #8a9099; }
.md-kv b { color: #414750; font-weight: 600; }
.md-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.md-strong { font-size: 12px; font-weight: 700; color: #1f2329; }
.md-code-default { color: #d97706; }

/* 触控目标 44pt 起 */
.md-btn { width: 100%; margin-top: 8px; min-height: 44px; font-size: 12px; font-weight: 600; border: 1px solid #dcdfe6; border-radius: 8px; background: #fff; color: #414750; }

/* 底部安全区：iPhone 的 Home 指示条会盖住最后一行 */
.md-tabbar { display: flex; background: #fff; border-top: 1px solid #e6e8eb; padding: 6px 0 calc(6px + env(safe-area-inset-bottom)); flex: 0 0 auto; }
.md-tab { flex: 1 1 0; display: flex; flex-direction: column; align-items: center; gap: 2px; border: 0; background: transparent; min-height: 44px; padding: 4px 0; }
.md-tab-icon { font-size: 14px; }
.md-tab-label { font-size: 10px; color: #8a9099; }
.md-tab.is-active .md-tab-label { color: #1677ff; font-weight: 600; }
</style>
