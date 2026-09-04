import { computed, ref } from 'vue'

import { api, type DatasetRow, type KnowledgeRow, type TrainingSummary, type UsageSummary } from '../api'

/**
 * 数据看板的状态：埋点 / 测试集 / 知识库 / 微调语料。
 *
 * 四块合成一个组合式而不是四个 —— 它们共用同一套「加载中 / 出错 / 刷新」，
 * 拆开会得到四份几乎一样的样板。真正不同的只有请求的那一行。
 */

export function useDataConsole() {
  const loading = ref(false)
  const error = ref('')

  const usageDays = ref(7)
  const usage = ref<UsageSummary | null>(null)
  const training = ref<TrainingSummary | null>(null)
  const datasets = ref<DatasetRow[]>([])
  const knowledge = ref<KnowledgeRow[]>([])
  const emptyCount = ref(0)

  /** 上传/导入的校验错误。**逐条**保留 —— 只显示第一条等于让人来回试 */
  const uploadErrors = ref<string[]>([])
  const uploadName = ref('')

  /** 点开某个事件看 target 细分 */
  const drillEvent = ref('')
  const drillRows = computed(() =>
    (usage.value?.by_target ?? []).filter((r) => r.event === drillEvent.value),
  )

  async function refresh() {
    loading.value = true
    error.value = ''
    try {
      const [u, t, d, k] = await Promise.all([
        api.usageSummary(usageDays.value),
        api.trainingSummary(),
        api.listDatasets(),
        api.listKnowledge(),
      ])
      usage.value = u
      training.value = t
      datasets.value = d.items
      knowledge.value = k.items
      emptyCount.value = k.empty_count
      if (!drillEvent.value && u.by_event.length) drillEvent.value = u.by_event[0].event
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  /**
   * 从校验失败的响应里取出**逐条**错误。
   *
   * 服务端把它们放在 `detail.errors`；取不到就退回整条消息 ——
   * 宁可显示一句笼统的，也不能什么都不显示让人对着一个静默的失败发呆。
   */
  function takeErrors(e: unknown): string[] {
    const detail = (e as { detail?: { errors?: unknown } })?.detail
    const list = detail?.errors
    if (Array.isArray(list) && list.length) return list.map(String)
    return [e instanceof Error ? e.message : String(e)]
  }

  async function uploadDataset(file: File) {
    uploadErrors.value = []
    uploadName.value = file.name
    let payload: unknown
    try {
      payload = JSON.parse(await file.text())
    } catch (e) {
      // JSON 都没解析出来时，说清是文件本身坏了，别让人以为是内容不合规
      uploadErrors.value = [`不是合法的 JSON：${e instanceof Error ? e.message : e}`]
      return false
    }
    try {
      await api.uploadDataset(payload as Record<string, unknown>)
      await refresh()
      return true
    } catch (e) {
      uploadErrors.value = takeErrors(e)
      return false
    }
  }

  async function importKnowledge(file: File) {
    uploadErrors.value = []
    uploadName.value = file.name
    let entries: unknown
    try {
      entries = JSON.parse(await file.text())
    } catch (e) {
      uploadErrors.value = [`不是合法的 JSON：${e instanceof Error ? e.message : e}`]
      return false
    }
    try {
      await api.importKnowledge(entries as Record<string, unknown>)
      await refresh()
      return true
    } catch (e) {
      uploadErrors.value = takeErrors(e)
      return false
    }
  }

  return {
    loading, error, usage, usageDays, training, datasets, knowledge, emptyCount,
    uploadErrors, uploadName, drillEvent, drillRows,
    refresh, uploadDataset, importKnowledge,
  }
}
