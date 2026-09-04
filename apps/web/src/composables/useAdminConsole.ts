import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import {
  api,
  type AgentSummary,
  type AgentDetail,
  type AgentRunLog,
  type CompareResult,
  type EvalDataset,
  type EvalResult,
} from '../api'
import { log, time } from '../logging'

/**
 * Agent 配置与运行控制台的全部状态。
 *
 * 桌面版与移动版是**两套信息架构**（左右分栏 vs 顶部岗位切换 + 底部四档），
 * 但背后是同一份状态与同一组动作。抄一份到移动端的话，以后改一个必漏一个 ——
 * 与 `useCopilotChat` 同样的理由。
 *
 * 每个组件实例调用一次，各自持有状态；两个视图由 `v-if` 二选一，不会同时挂载。
 */
export function useAdminConsole() {

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
  const tab = ref<'config' | 'tune' | 'eval' | 'versions' | 'runs' | 'data'>('config')

  /** 草稿编辑区。与已发布配置分开，未发布不影响线上。 */
  const draft = ref({ model_tier: 'clinical_fast', role_prompt: '', note: '' })

  /**
   * 可调参数。两个都带上下限，且**服务端也会拦** —— 界面能绕过。
   *
   * temperature 临床岗位默认 0：调高会让同一份病历每次生成不同，无法复核。
   * max_tokens 太小会截断 JSON，整个岗位跟着降级（一期真踩过）。
   */
  const params = ref<{ temperature: number; max_tokens: number }>({ temperature: 0, max_tokens: 4096 })
  const saving = ref(false)

  const dirty = computed(() => {
    if (!detail.value) return false
    const base = detail.value.draft ?? detail.value.running
    return draft.value.role_prompt !== base.role_prompt || draft.value.model_tier !== base.model_tier
  })


  /* ===================== 试运行与调优 ===================== */

  const dryPatient = ref('P001')
  const comparing = ref(false)
  const comparison = ref<CompareResult | null>(null)

  const evaluating = ref(false)
  const evalResult = ref<EvalResult | null>(null)
  const evalCases = ref<
    { id: string; name: string; patient_id: string; dataset_id: string; dataset_name: string; checks: string[] }[]
  >([])

  /* ===================== 评测数据集 ===================== */

  const datasets = ref<EvalDataset[]>([])
  const togglingDataset = ref('')

  async function loadDatasets() {
    try {
      datasets.value = (await api.adminEvalDatasets()).datasets
    } catch (error) {
      ElMessage.error(`数据集加载失败：${(error as Error).message}`)
    }
  }

  /**
   * 启停一个数据集。
   *
   * 切完要重拉用例清单 —— 停用了却还列着它的用例，医生会以为下次还会跑。
   * 已有的评测结果一并清掉：那份结果的分母是旧的，留着比没有更误导。
   */
  async function toggleDataset(dataset: EvalDataset, enabled: boolean) {
    togglingDataset.value = dataset.id
    log('admin', 'toggle_dataset', { dataset: dataset.id, enabled })
    try {
      datasets.value = (await api.adminToggleEvalDataset(dataset.id, enabled)).datasets
      evalResult.value = null
      await loadEvalCases()
    } catch (error) {
      ElMessage.error(`切换失败：${(error as Error).message}`)
      await loadDatasets()
    } finally {
      togglingDataset.value = ''
    }
  }

  /** 当前岗位会跑到的用例数。跟「该集共 N 条」不是一回事 —— 一个集可能跨多个岗位。 */
  const activeCaseCount = computed(() => evalCases.value.length)

  /** 只有变化过的字段值得看 —— 几十个 same 会把两条真差异淹掉 */
  const changedFields = computed(() =>
    (comparison.value?.diff ?? []).filter((d) => d.kind !== 'same'),
  )

  function fieldText(side: 'published' | 'draft', field: string) {
    const value = comparison.value?.[side].output?.[field]
    if (value === undefined) return '（无此字段）'
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }

  async function runCompare() {
    if (!activeKey.value) return
    comparing.value = true
    comparison.value = null
    try {
      comparison.value = await time('admin', 'compare', () => api.adminCompare(activeKey.value, dryPatient.value), {
        agent: activeKey.value, patient: dryPatient.value,
      })
    } catch (error) {
      ElMessage.error(`试运行失败：${(error as Error).message}`)
    } finally {
      comparing.value = false
    }
  }

  async function runEval() {
    if (!activeKey.value) return
    evaluating.value = true
    evalResult.value = null
    try {
      evalResult.value = await time('admin', 'run_eval', () => api.adminRunEval(activeKey.value, 'draft'), {
        agent: activeKey.value,
      })
      // 通过率必须连着分母记 —— 只记百分比的话，日后回看分不清是改好了还是关掉了半个数据集
      log('admin', 'eval_result', {
        agent: activeKey.value,
        passed: evalResult.value.passed,
        failed: evalResult.value.failed,
        total: evalResult.value.total,
        datasets: evalResult.value.datasets?.map((d) => `${d.name}(${d.case_count})`).join('、') ?? '',
        failedCases: evalResult.value.cases.filter((c) => !c.passed).map((c) => c.case_id).join('、'),
      })
    } catch (error) {
      ElMessage.error(`回归集执行失败：${(error as Error).message}`)
    } finally {
      evaluating.value = false
    }
  }

  async function loadEvalCases() {
    if (!activeKey.value) return
    try {
      evalCases.value = (await api.adminEvalCases(activeKey.value)).cases
    } catch {
      evalCases.value = []
    }
  }

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
    log('admin', 'select_agent', { from: activeKey.value || '(none)', to: key })
    activeKey.value = key
    // 清掉上一个岗位的结果 —— 留着会让人对着 A 的输出判断 B 的提示词
    comparison.value = null
    evalResult.value = null
    void loadEvalCases()
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
      await time('admin', 'save_draft', () => api.adminSaveDraft(activeKey.value, draft.value), {
        agent: activeKey.value, tier: draft.value.model_tier, promptLen: draft.value.role_prompt.length,
      })
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
    const result = await time('admin', 'publish', () => api.adminPublish(activeKey.value), { agent: activeKey.value })
    ElMessage.success(`已发布 ${result.version}`)
    await select(activeKey.value)
    await loadOverview()
  }

  async function rollback(versionId: number, version: string) {
    await ElMessageBox.confirm(`回滚到 ${version}？当前生产版本会降为历史版本。`, '确认回滚', { type: 'warning' })
    await time('admin', 'rollback', () => api.adminRollback(activeKey.value, versionId), {
      agent: activeKey.value, to: version,
    })
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


  return {
    // 概览
    loading, agents, tiers, bundleVersion, activeKey, detail, runs, tab,
    // 草稿与参数
    draft, params, saving, dirty,
    // 试运行
    dryPatient, comparing, comparison, changedFields, fieldText, runCompare,
    // 回归集与数据集
    evaluating, evalResult, evalCases, datasets, togglingDataset, activeCaseCount,
    runEval, loadEvalCases, loadDatasets, toggleDataset,
    // 动作
    loadOverview, select, saveDraft, publish, rollback, discard, resetToCodeDefault, statusType,
  }
}
