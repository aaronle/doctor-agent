/**
 * 交付平台的状态。桌面版与移动版共用这一份 —— 两套界面，一套事实。
 *
 * 这里只读。写入（上报、发布记录、功能回滚）由开发机上的脚本带令牌完成；
 * 智能体回滚走控制台既有的 `/api/admin/agents/{key}/rollback/{id}`，
 * 不在交付平台另开一条路径 —— 两条路径改同一张表，迟早会有一条忘了改。
 */
import { computed, ref } from 'vue'

import {
  api,
  type DeliveryLane,
  type DeliveryPipelines,
  type DeliveryProduction,
  type DeliveryReleaseItem,
  type DeliveryReleases,
  type DeliveryRun,
  type StageStatus,
} from '../api'
import { log, time } from '../logging'

export type DeliveryTab = 'pipelines' | 'feature' | 'agent' | 'releases'

/** 阶段状态 → 记号与语气。界面上到处要用，集中在一处免得各写各的。 */
export const STAGE_MARK: Record<StageStatus, { icon: string; tone: string }> = {
  passed: { icon: '✓', tone: 'ok' },
  running: { icon: '◍', tone: 'run' },
  failed: { icon: '✕', tone: 'bad' },
  skipped: { icon: '—', tone: 'mute' },
  idle: { icon: '○', tone: 'idle' },
}

export function useDelivery() {
  const loading = ref(false)
  const error = ref('')
  const tab = ref<DeliveryTab>('pipelines')

  const pipelines = ref<DeliveryPipelines | null>(null)
  const releases = ref<DeliveryReleases | null>(null)
  const production = ref<DeliveryProduction | null>(null)

  const featureRun = computed(() => pipelines.value?.lanes.feature ?? null)
  const agentRun = computed(() => pipelines.value?.lanes.agent ?? null)

  const runOf = (lane: DeliveryLane) => (lane === 'feature' ? featureRun.value : agentRun.value)

  /**
   * 通过率**必须和分母一起显示**。
   * 13 条的 77% 和 130 条的 77% 是两回事，只给百分比会让人忽略分母。
   */
  const passRateText = (run: DeliveryRun | null) => {
    const r = run?.meta?.pass_rate
    if (!r || !r.total) return ''
    return `${r.passed}/${r.total}`
  }

  /** 全过了没有。分母永远带着，但颜色跟着结果走。 */
  const allPassed = (run: DeliveryRun | null) => {
    const r = run?.meta?.pass_rate
    return !!r && r.total > 0 && r.passed === r.total
  }

  const isEmpty = computed(() => !featureRun.value && !agentRun.value)

  async function loadAll() {
    loading.value = true
    error.value = ''
    try {
      const [p, r, prod] = await time('delivery', 'load', () =>
        Promise.all([api.deliveryPipelines(), api.deliveryReleases(), api.deliveryProduction()]),
      )
      pipelines.value = p
      releases.value = r
      production.value = prod
      log('delivery', 'loaded', {
        feature: p.lanes.feature?.status ?? 'none',
        agent: p.lanes.agent?.status ?? 'none',
        releases: r.items.length,
      })
    } catch (err) {
      // 交付平台自己挂了不该让人以为是流水线挂了 —— 把两种失败区分开
      error.value = err instanceof Error ? err.message : String(err)
      log('delivery', 'load_failed', { error: error.value })
    } finally {
      loading.value = false
    }
  }

  /**
   * 智能体回滚。走控制台既有路径，不重启、不换镜像。
   * 成功后必须重拉 —— 这一步改的是「生产上跑哪版」，界面不刷新就等于在说谎。
   */
  async function rollbackAgent(item: DeliveryReleaseItem) {
    const agentKey = item.meta.agent_key
    if (!agentKey) throw new Error('这条记录没有 agent_key，无法回滚')
    await time('delivery', 'rollback_agent', () => api.adminRollback(agentKey, Number(item.ref)), {
      agent: agentKey,
      version: item.ref,
    })
    await loadAll()
  }

  return {
    loading, error, tab,
    pipelines, releases, production,
    featureRun, agentRun, runOf, passRateText, allPassed, isEmpty,
    loadAll, rollbackAgent,
  }
}
