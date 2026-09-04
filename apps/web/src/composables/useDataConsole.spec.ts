import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api'
import { useDataConsole } from './useDataConsole'

/** 数据看板的状态。重点在「上传失败时逐条错误要能拿到」。 */

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    api: {
      usageSummary: vi.fn().mockResolvedValue({
        days: 7, total_events: 9, sessions: 3, per_session: 3,
        by_event: [{ event: 'tab_switch', count: 6 }, { event: 'generate', count: 3 }],
        by_target: [{ event: 'tab_switch', target: '预警评估', count: 4 }],
      }),
      trainingSummary: vi.fn().mockResolvedValue({
        total: 1, trainable_count: 1, by_verdict: [], by_agent: [], recent: [],
      }),
      listDatasets: vi.fn().mockResolvedValue({ items: [{ id: 'a', builtin: true }] }),
      listKnowledge: vi.fn().mockResolvedValue({ items: [], empty_count: 2 }),
      uploadDataset: vi.fn(),
      importKnowledge: vi.fn(),
    },
  }
})

const { api } = await import('../api')

function jsonFile(text: string, name = 'x.json') {
  return { name, text: () => Promise.resolve(text) } as unknown as File
}

afterEach(() => vi.clearAllMocks())

describe('数据看板 · 加载', () => {
  it('四块一起拉，默认选中第一个事件做细分', async () => {
    const dc = useDataConsole()
    await dc.refresh()

    expect(dc.usage.value?.total_events).toBe(9)
    expect(dc.emptyCount.value).toBe(2)
    expect(dc.drillEvent.value).toBe('tab_switch')
    expect(dc.drillRows.value).toHaveLength(1)
  })

  it('细分只出当前选中事件的行', async () => {
    const dc = useDataConsole()
    await dc.refresh()
    dc.drillEvent.value = 'generate'
    expect(dc.drillRows.value).toHaveLength(0)
  })
})

describe('数据看板 · 上传失败要给出逐条错误', () => {
  it('**从 ApiError.detail 里取 errors 数组** —— 只显示一句笼统的等于让人来回试', async () => {
    // 校验类接口把逐条错误放在 detail.errors；
    // 早先 ApiError 只留 message，那个对象会被压成 [object Object]，
    // 上传的人手里是几百行 JSON，看到这五个字什么也做不了。
    vi.mocked(api.uploadDataset).mockRejectedValue(
      new ApiError('HTTP 422', 422, { errors: ['cases[0].checks[0].kind 不存在', 'cases[1] 缺 patient_id'] }),
    )
    const dc = useDataConsole()
    const ok = await dc.uploadDataset(jsonFile('{"id":"x","cases":[]}'))

    expect(ok).toBe(false)
    expect(dc.uploadErrors.value).toEqual([
      'cases[0].checks[0].kind 不存在',
      'cases[1] 缺 patient_id',
    ])
  })

  it('没有结构化错误时退回消息，不能什么都不显示', async () => {
    vi.mocked(api.uploadDataset).mockRejectedValue(new ApiError('服务器开小差', 500))
    const dc = useDataConsole()
    await dc.uploadDataset(jsonFile('{"id":"x"}'))
    expect(dc.uploadErrors.value).toEqual(['服务器开小差'])
  })

  it('JSON 本身坏掉时说清是文件坏了，别让人以为是内容不合规', async () => {
    const dc = useDataConsole()
    const ok = await dc.uploadDataset(jsonFile('{ 这不是 json'))

    expect(ok).toBe(false)
    expect(dc.uploadErrors.value[0]).toContain('不是合法的 JSON')
    expect(api.uploadDataset).not.toHaveBeenCalled()
  })

  it('上传成功要刷新列表 —— 否则新传的看不见，人会以为没成功', async () => {
    vi.mocked(api.uploadDataset).mockResolvedValue({ ok: true, dataset_id: 'x', case_count: 1 })
    const dc = useDataConsole()
    const ok = await dc.uploadDataset(jsonFile('{"id":"x","cases":[]}'))

    expect(ok).toBe(true)
    expect(api.listDatasets).toHaveBeenCalled()
  })
})

describe('数据看板 · 知识库导入', () => {
  it('导入失败同样给逐条错误', async () => {
    vi.mocked(api.importKnowledge).mockRejectedValue(
      new ApiError('HTTP 422', 422, { errors: ['"bad" 缺 title'] }),
    )
    const dc = useDataConsole()
    const ok = await dc.importKnowledge(jsonFile('{"bad":{}}'))

    expect(ok).toBe(false)
    expect(dc.uploadErrors.value).toEqual(['"bad" 缺 title'])
  })
})
