<script setup lang="ts">
import { onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import MobileDelivery from '../mobile/MobileDelivery.vue'
import { STAGE_MARK, useDelivery } from '../composables/useDelivery'
import { useIsMobile } from '../composables/useMediaQuery'
import type { DeliveryReleaseItem } from '../api'

/**
 * 交付平台（桌面）。
 *
 * **两条线并排，不合并。** 阶段名看着一样，但失败的含义完全不同：
 * 功能线失败是「构建挂了」，一眼看得见；智能体线失败是「输出退化了」，
 * 测试照样全绿。塞进一条流水线，等于逼人用同一种眼光看两种失败。
 *
 * 规格见 docs/product/16-交付平台-CICD需求规格说明书.md。
 */

const isMobile = useIsMobile()
const d = useDelivery()
const {
  loading, error, tab, pipelines, releases, production,
  featureRun, agentRun, passRateText, allPassed, loadAll, rollbackAgent,
} = d

onMounted(loadAll)

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)
const fmtAt = (at: string | null) => (at ? at.replace('T', ' ').slice(5, 16) : '—')

async function onRollback(item: DeliveryReleaseItem) {
  if (item.kind === 'feature') {
    // 平台不持有生产凭据。把这件事说清楚，别让「点了回滚」被当成「回滚了」。
    await ElMessageBox.alert(
      '功能制品回滚要换镜像重建容器，平台不持有生产凭据，无法在这里执行。请在开发机上跑部署脚本并指定这一版。',
      '这一步平台做不了',
      { confirmButtonText: '知道了' },
    )
    return
  }
  try {
    await ElMessageBox.confirm(
      `把「${item.title}」重新置为 published。不重启、不换镜像，下一次调用即生效 —— 镜像 tag 不会变，事后查「生产上是哪一版」要看环境页的两栏。`,
      '回滚到这一版？',
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
</script>

<template>
  <MobileDelivery v-if="isMobile" />

  <div v-else class="delivery-page">
    <header class="delivery-header">
      <span class="delivery-logo">⚙</span>
      <span class="delivery-title">Doctor Agent · 交付平台</span>
      <nav class="delivery-tabs">
        <button
          v-for="t in ([
            { key: 'pipelines', label: '流水线' },
            { key: 'feature', label: '功能制品' },
            { key: 'agent', label: '智能体制品' },
            { key: 'releases', label: '发布历史' },
          ] as const)"
          :key="t.key"
          class="delivery-tab"
          :class="{ 'is-active': tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </nav>
      <span class="delivery-spacer" />
      <span v-if="production" class="delivery-env">
        ● 生产 {{ production.from_image.release }}
      </span>
      <el-button size="small" :loading="loading" @click="loadAll">刷新</el-button>
      <el-button size="small" @click="$router.push('/admin')">Agent 控制台</el-button>
    </header>

    <!--
      平台自己挂了，和流水线挂了，是两回事。分开报，别让人去查错方向。
    -->
    <div v-if="error" class="delivery-error">
      交付平台读取失败：{{ error }}（这是平台自身的问题，不代表流水线的状态）
    </div>

    <div v-loading="loading" class="delivery-body">
      <!-- ------------------------------------------------ 流水线看板 -->
      <section v-if="tab === 'pipelines'" class="delivery-lanes">
        <article
          v-for="lane in ([
            { key: 'feature', label: '功能线', run: featureRun },
            { key: 'agent', label: '智能体线', run: agentRun },
          ] as const)"
          :key="lane.key"
          class="lane-card"
          :class="`lane-${lane.key}`"
        >
          <header class="lane-head">
            <span class="lane-kind" :class="`kind-${lane.key}`">{{ lane.label }}</span>
            <span class="lane-spacer" />
            <span v-if="lane.run" class="lane-status" :class="`st-${lane.run.status}`">
              {{ lane.run.status }}
            </span>
          </header>

          <p v-if="!lane.run" class="lane-empty">
            还没有上报过运行。门禁跑一次 <code>npm run verify</code>（带
            <code>DELIVERY_API</code> 与 <code>DELIVERY_INGEST_TOKEN</code>）就会出现在这里。
          </p>

          <template v-else>
            <h3 class="lane-title">{{ lane.run.title || lane.run.run_key }}</h3>
            <p class="lane-sub">{{ lane.run.subtitle }}</p>

            <ul class="stage-list">
              <li v-for="s in lane.run.stages" :key="s.name" class="stage-row" :class="`tone-${STAGE_MARK[s.status].tone}`">
                <span class="stage-icon">{{ STAGE_MARK[s.status].icon }}</span>
                <span class="stage-name">{{ s.name }}</span>
                <span class="stage-detail">{{ s.detail }}</span>
                <span class="stage-spacer" />
                <span class="stage-time">{{ s.elapsed_ms ? fmtMs(s.elapsed_ms) : '—' }}</span>
              </li>
            </ul>

            <!--
              通过率必须和分母一起显示：13 条的 77% 和 130 条的 77% 是两回事。
              但颜色跟着结果走 —— 全过了还标成橙色，看板上就多一处「看着像出事」的
              噪音，久了人连真的橙色也不看了。
            -->
            <p v-if="passRateText(lane.run)" class="lane-rate" :class="{ 'is-clean': allPassed(lane.run) }">
              回归集 {{ passRateText(lane.run) }}
            </p>
          </template>
        </article>
      </section>

      <!-- ------------------------------------------------ 功能制品 -->
      <section v-else-if="tab === 'feature'" class="delivery-artifact">
        <p v-if="!featureRun" class="lane-empty">功能线还没有上报过运行。</p>
        <template v-else>
          <div class="artifact-id">
            <strong class="mono">{{ featureRun.meta.commit }}</strong>
            <span class="artifact-subject">{{ featureRun.meta.subject }}</span>
            <span class="lane-spacer" />
            <span class="artifact-meta">分支 {{ featureRun.meta.branch }}</span>
            <span class="artifact-meta">改动 {{ featureRun.meta.dirty_files ?? 0 }} 个文件</span>
          </div>

          <h4 class="block-title">
            门禁逐项
            <!--
              两道界面闸互补：还原度比「做了的长得对不对」，
              类名覆盖率比「有没有整块漏做」。缺一不可。
            -->
            <small>还原度比「做了的对不对」，类名覆盖率比「有没有整块漏做」</small>
          </h4>
          <ul class="gate-list">
            <li v-for="g in (featureRun.meta.gates ?? [])" :key="g.key" class="gate-row" :class="g.ok ? 'tone-ok' : 'tone-bad'">
              <span class="stage-icon">{{ g.ok ? '✓' : '✕' }}</span>
              <span class="gate-label">{{ g.label }}</span>
              <span class="gate-detail">{{ g.detail }}</span>
              <span class="stage-spacer" />
              <span class="stage-time">{{ fmtMs(g.elapsed_ms) }}</span>
            </li>
          </ul>

          <template v-if="featureRun.meta.log?.length">
            <h4 class="block-title">构建日志</h4>
            <pre class="console"><span
              v-for="(l, i) in featureRun.meta.log"
              :key="i"
              class="console-line"
              :class="`log-${l[2]}`"
            >{{ l[0] }}  {{ l[1] }}
</span></pre>
          </template>
        </template>
      </section>

      <!-- ------------------------------------------------ 智能体制品 -->
      <section v-else-if="tab === 'agent'" class="delivery-artifact">
        <p v-if="!agentRun" class="lane-empty">智能体线还没有上报过运行。</p>
        <template v-else>
          <div class="artifact-id">
            <strong>{{ agentRun.title || agentRun.run_key }}</strong>
            <span class="lane-spacer" />
            <span class="artifact-meta">{{ agentRun.subtitle }}</span>
          </div>

          <h4 class="block-title">
            回归集
            <small v-if="passRateText(agentRun)">{{ passRateText(agentRun) }} —— 通过率要和分母一起看</small>
          </h4>
          <!--
            智能体的失败不自明：给个红叉没有用，必须写清为什么算失败。
          -->
          <ul class="regression-list">
            <li v-for="(r, i) in (agentRun.meta.regressions ?? [])" :key="i" class="regression-row">
              <span class="stage-icon tone-bad">✕</span>
              <div>
                <div class="regression-case">{{ r.case }}</div>
                <div class="regression-reason">{{ r.reason }}</div>
              </div>
            </li>
            <li v-if="!agentRun.meta.regressions?.length" class="regression-row">
              <span class="regression-reason">本次没有未通过的条目。</span>
            </li>
          </ul>
        </template>
      </section>

      <!-- ------------------------------------------------ 发布历史 -->
      <section v-else class="delivery-releases">
        <p class="block-note">
          两种制品同一条时间线 —— 排查「什么时候开始不对的」时，
          最需要知道的恰恰是这两者谁先动的。
        </p>

        <ul class="release-list">
          <li
            v-for="item in (releases?.items ?? [])"
            :key="`${item.kind}-${item.ref}`"
            class="release-row"
            :class="[`kind-${item.kind}`, `st-${item.status}`]"
          >
            <span class="release-at">{{ fmtAt(item.at) }}</span>
            <span class="release-kind" :class="`kind-${item.kind}`">
              {{ item.kind === 'feature' ? '功能' : '智能体' }}
            </span>
            <div class="release-main">
              <div class="release-title">{{ item.title }}</div>
              <div class="release-detail">{{ item.detail }}</div>
            </div>
            <span class="lane-spacer" />
            <span v-if="item.status === 'current'" class="release-current">● 当前生产</span>
            <span v-else-if="item.status === 'rolled_back'" class="release-rolled">已回滚</span>
            <el-button v-if="item.can_rollback" size="small" @click="onRollback(item)">回滚到这一版</el-button>
          </li>
        </ul>

        <!--
          回滚的两种含义不一样。这段不是装饰 —— 不写清楚，
          「回滚了但提交号没变」会被当成没生效。
        -->
        <div v-if="releases" class="semantics">
          <h4 class="block-title">回滚的两种含义不一样</h4>
          <p><strong>功能制品</strong>：{{ releases.rollback_semantics.feature }}</p>
          <p><strong>智能体制品</strong>：{{ releases.rollback_semantics.agent }}</p>
        </div>

        <!-- 生产指纹：镜像 tag 只说明了一半 -->
        <div v-if="production" class="fingerprint">
          <h4 class="block-title">
            生产上现在到底是哪一版
            <small>{{ production.note }}</small>
          </h4>
          <div class="fp-cols">
            <div class="fp-col">
              <div class="fp-col-title">来自镜像（换镜像才会变）</div>
              <div class="fp-row"><span>版本</span><b class="mono">{{ production.from_image.release }}</b></div>
              <div class="fp-row"><span>提交</span><b class="mono">{{ production.from_image.commit || '—' }}</b></div>
              <div class="fp-row"><span>快档模型</span><b class="mono">{{ production.from_image.model_fast }}</b></div>
              <div class="fp-row"><span>慢档模型</span><b class="mono">{{ production.from_image.model_smart }}</b></div>
              <div class="fp-row"><span>编排模型</span><b class="mono">{{ production.from_image.model_orchestration }}</b></div>
              <div class="fp-row"><span>模型超时</span><b class="mono">{{ production.from_image.timeout_ms }}ms</b></div>
            </div>
            <div class="fp-col">
              <div class="fp-col-title">来自数据库（不重启即可变）</div>
              <div v-for="a in production.from_database.agents" :key="a.agent_key" class="fp-row">
                <span>{{ a.label }}</span>
                <b class="mono" :class="{ 'fp-code-default': a.source === 'code_default' }">
                  {{ a.version }}{{ a.source === 'code_default' ? ' · 代码兜底' : '' }}
                </b>
              </div>
              <div class="fp-row">
                <span>数据集开关</span>
                <b class="mono">{{ production.from_database.datasets_enabled }} 开 / {{ production.from_database.datasets_disabled }} 关</b>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.delivery-page { display: flex; flex-direction: column; height: 100vh; background: #f5f7fa; overflow: hidden; }
.delivery-header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #fff; border-bottom: 1px solid #e6e8eb; flex: 0 0 auto; }
.delivery-logo { font-size: 15px; }
.delivery-title { font-size: 14px; font-weight: 700; color: #1f2329; }
.delivery-tabs { display: flex; gap: 4px; margin-left: 12px; }
.delivery-tab { border: 0; background: transparent; font-size: 12px; color: #8a9099; padding: 6px 10px; cursor: pointer; border-bottom: 2px solid transparent; }
.delivery-tab.is-active { color: #1677ff; font-weight: 600; border-bottom-color: #1677ff; }
.delivery-spacer, .lane-spacer, .stage-spacer { flex: 1 1 auto; }
.delivery-env { font-size: 11px; color: #16a34a; font-weight: 600; }
.delivery-error { margin: 10px 16px 0; padding: 8px 12px; border-radius: 8px; background: #fff2f0; border: 1px solid #ffccc7; color: #cf1322; font-size: 12px; }
.delivery-body { flex: 1 1 auto; overflow: auto; padding: 14px 16px; }

.delivery-lanes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.lane-card { background: #fff; border: 1px solid #e6e8eb; border-radius: 10px; padding: 12px 14px; }
.lane-feature { border-color: #b7cbf2; }
.lane-agent { border-color: #dcdfe6; }
.lane-head { display: flex; align-items: center; gap: 8px; }
.lane-kind { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; }
.kind-feature { background: #edf3ff; color: #1677ff; }
.kind-agent { background: #f2f3f5; color: #6b7280; }
.lane-status { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: #f2f3f5; color: #6b7280; }
.st-passed, .st-deployed { background: #edfaed; color: #16a34a; }
.st-failed, .st-blocked { background: #fff1f0; color: #cf1322; }
.st-running { background: #edf3ff; color: #1677ff; }
.lane-title { margin: 8px 0 2px; font-size: 13px; font-weight: 600; color: #1f2329; }
.lane-sub, .lane-empty { font-size: 11px; color: #8a9099; margin: 0; line-height: 1.6; }
.lane-empty code { background: #f2f3f5; padding: 1px 4px; border-radius: 3px; }
.lane-rate { font-size: 11px; color: #d97706; font-weight: 600; margin: 6px 0 0; }
.lane-rate.is-clean { color: #16a34a; }

.stage-list, .gate-list, .regression-list, .release-list { list-style: none; margin: 8px 0 0; padding: 0; }
.stage-row, .gate-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 11px; }
.stage-icon { width: 12px; text-align: center; font-weight: 700; }
.stage-name, .gate-label { color: #414750; font-weight: 500; }
.stage-detail, .gate-detail { color: #8a9099; }
.stage-time { color: #b0b5bd; font-size: 10px; }
.tone-ok .stage-icon { color: #16a34a; }
.tone-run .stage-icon { color: #1677ff; }
.tone-bad .stage-icon { color: #cf1322; }
.tone-bad .gate-detail { color: #cf1322; }
.tone-idle .stage-icon, .tone-mute .stage-icon { color: #c0c4cc; }
.tone-idle .stage-name { color: #b0b5bd; }

.delivery-artifact, .delivery-releases { background: #fff; border: 1px solid #e6e8eb; border-radius: 10px; padding: 14px; }
.artifact-id { display: flex; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid #f0f1f2; }
.artifact-subject { font-size: 13px; font-weight: 600; color: #1f2329; }
.artifact-meta { font-size: 10px; color: #8a9099; }
.block-title { font-size: 12px; font-weight: 700; color: #1f2329; margin: 14px 0 4px; }
.block-title small { font-weight: 400; color: #8a9099; margin-left: 8px; font-size: 10px; }
.block-note { font-size: 11px; color: #8a9099; margin: 0 0 10px; line-height: 1.6; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.console { background: #1f2329; border-radius: 8px; padding: 10px 12px; margin: 6px 0 0; overflow: auto; max-height: 320px; }
.console-line { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.7; white-space: pre-wrap; }
.log-dim { color: #8a9099; }
.log-ok { color: #4ade80; }
.log-err { color: #f87171; }
.log-fix { color: #fbbf24; }

.regression-row { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f5f6f7; }
.regression-case { font-size: 11px; font-weight: 600; color: #1f2329; }
.regression-reason { font-size: 10px; color: #8a9099; line-height: 1.6; }

.release-row { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid #e6e8eb; border-radius: 8px; margin-bottom: 6px; }
.release-row.st-current { border-color: #b7cbf2; }
.release-row.st-rolled_back { opacity: 0.7; background: #fafbfc; }
.release-at { font-size: 10px; color: #8a9099; font-variant-numeric: tabular-nums; }
.release-kind { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; }
.release-title { font-size: 12px; font-weight: 600; color: #1f2329; }
.release-detail { font-size: 10px; color: #8a9099; }
.release-current { font-size: 10px; font-weight: 600; color: #16a34a; }
.release-rolled { font-size: 10px; font-weight: 600; color: #d97706; }

.semantics { margin-top: 14px; padding: 10px 12px; background: #f7f8fa; border-radius: 8px; }
.semantics p { font-size: 11px; color: #6b7280; margin: 4px 0; line-height: 1.6; }
.fingerprint { margin-top: 12px; padding: 12px; border: 1px solid #b7cbf2; border-radius: 10px; }
.fp-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.fp-col { background: #f7f8fa; border-radius: 8px; padding: 10px 12px; }
.fp-col-title { font-size: 11px; font-weight: 700; color: #414750; margin-bottom: 6px; }
.fp-row { display: flex; justify-content: space-between; gap: 10px; font-size: 10px; padding: 2px 0; }
.fp-row span { color: #8a9099; }
.fp-row b { color: #414750; font-weight: 600; }
/* 吃代码兜底的岗位要看得出来 —— 它意味着数据库里根本没有 published 记录 */
.fp-code-default { color: #d97706 !important; }
</style>
