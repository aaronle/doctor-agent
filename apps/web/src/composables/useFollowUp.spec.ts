import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { AUTO_OPEN_AFTER_MESSAGES, useFollowUp } from './useFollowUp'

/**
 * AI 追问提示的三条不变量。
 *
 * 这个功能撤过一次，撤的理由是「判错一条对医生是干扰」。所以这里钉的
 * 不是「能不能跑」，而是**判错时会往哪个方向错**。
 */

function turns(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? 'patient' : 'doctor',
    text: `第 ${i + 1} 句`,
  }))
}

afterEach(() => vi.restoreAllMocks())

describe('追问清单 · 取清单', () => {
  it('把问题装成未完成的条目', async () => {
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['疼多久了？', '有没有药物过敏？'], provider: 'x', degraded: false,
    } as never)
    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()

    expect(fu.items.value).toHaveLength(2)
    expect(fu.items.value.every((i) => !i.done)).toBe(true)
    expect(fu.pending.value).toHaveLength(2)
    expect(fu.done.value).toHaveLength(0)
  })

  it('**一场问诊只取一次** —— 重算会让条目在医生眼皮底下换来换去', async () => {
    const spy = vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['疼多久了？'], provider: 'x', degraded: false,
    } as never)
    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    await fu.loadPlan()
    await fu.loadPlan()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('降级时清单为空 —— 不给一份与这位患者无关的通用模板', async () => {
    // 模型不可用时给一份看起来像样、实际没针对性的清单比不给更糟：
    // 医生照着问完，会以为该问的都问过了。
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['随便一条'], provider: 'none', degraded: true,
    } as never)
    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()

    expect(fu.items.value).toHaveLength(0)
  })

  it('接口出错不抛出去 —— 提示不在关键路径上，不该打断问诊', async () => {
    vi.spyOn(api, 'followUpPlan').mockRejectedValue(new Error('boom'))
    const fu = useFollowUp(() => 'P006')
    await expect(fu.loadPlan()).resolves.toBeUndefined()
    expect(fu.items.value).toHaveLength(0)
  })
})

describe('追问清单 · 不变量①：单调，已划掉的不会回来', () => {
  it('判定回来一条就划一条', async () => {
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['A？', 'B？'], provider: 'x', degraded: false,
    } as never)
    vi.spyOn(api, 'followUpCoverage').mockResolvedValue({
      covered: [{ question: 'A？', quote: '患者说的那句' }], provider: 'x', degraded: false,
    } as never)

    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    await fu.advance(turns(4))

    expect(fu.done.value.map((i) => i.question)).toEqual(['A？'])
    expect(fu.done.value[0].quote).toBe('患者说的那句')
    expect(fu.pending.value.map((i) => i.question)).toEqual(['B？'])
  })

  it('**下一轮判定没再提它，也不许翻回未完成**', async () => {
    // 一条已经答过的问题又变回未答，医生会当场不再信任这个清单。
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['A？', 'B？'], provider: 'x', degraded: false,
    } as never)
    const cov = vi.spyOn(api, 'followUpCoverage')
      .mockResolvedValueOnce({ covered: [{ question: 'A？', quote: '原话' }], degraded: false } as never)
      .mockResolvedValueOnce({ covered: [], degraded: false } as never)

    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    await fu.advance(turns(4))
    await fu.advance(turns(8))

    expect(cov).toHaveBeenCalledTimes(2)
    expect(fu.done.value.map((i) => i.question)).toEqual(['A？'])
  })

  it('只把**还开着的**问题发上去 —— 服务端因此没机会取消划掉', async () => {
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['A？', 'B？', 'C？'], provider: 'x', degraded: false,
    } as never)
    const cov = vi.spyOn(api, 'followUpCoverage')
      .mockResolvedValueOnce({ covered: [{ question: 'A？', quote: '原话' }], degraded: false } as never)
      .mockResolvedValueOnce({ covered: [], degraded: false } as never)

    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    await fu.advance(turns(4))
    await fu.advance(turns(8))

    expect(cov.mock.calls[1][1]).toEqual(['B？', 'C？'])
  })
})

describe('追问清单 · 不变量②：非阻塞', () => {
  it('同一时刻只允许一个判定在飞', async () => {
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['A？'], provider: 'x', degraded: false,
    } as never)
    let release: (v: unknown) => void = () => {}
    const cov = vi.spyOn(api, 'followUpCoverage')
      .mockReturnValue(new Promise((r) => { release = r }) as never)

    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    const first = fu.advance(turns(4))
    await fu.advance(turns(8))   // 前一个还没回来
    await fu.advance(turns(12))

    expect(cov).toHaveBeenCalledTimes(1)
    release({ covered: [], degraded: false })
    await first
  })

  it('攒够 2 条新对话才跑一次 —— 每条都跑只是烧钱', async () => {
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['A？'], provider: 'x', degraded: false,
    } as never)
    const cov = vi.spyOn(api, 'followUpCoverage')
      .mockResolvedValue({ covered: [], degraded: false } as never)

    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    await fu.advance(turns(1))
    expect(cov).not.toHaveBeenCalled()
    await fu.advance(turns(2))
    expect(cov).toHaveBeenCalledTimes(1)
  })

  it('清单全划完就不再调用了', async () => {
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['A？'], provider: 'x', degraded: false,
    } as never)
    const cov = vi.spyOn(api, 'followUpCoverage')
      .mockResolvedValue({ covered: [{ question: 'A？', quote: '原话' }], degraded: false } as never)

    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    await fu.advance(turns(4))
    await fu.advance(turns(8))

    expect(cov).toHaveBeenCalledTimes(1)
  })
})

describe('追问清单 · 不变量③：拿不准就不划', () => {
  it('判定降级 → 一条都不划，清单停在原地', async () => {
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['A？'], provider: 'x', degraded: false,
    } as never)
    vi.spyOn(api, 'followUpCoverage').mockResolvedValue({
      covered: [{ question: 'A？', quote: '原话' }], provider: 'none', degraded: true,
    } as never)

    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    await fu.advance(turns(4))

    expect(fu.done.value).toHaveLength(0)
  })

  it('判定接口出错 → 一条都不划，也不抛出去', async () => {
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['A？'], provider: 'x', degraded: false,
    } as never)
    vi.spyOn(api, 'followUpCoverage').mockRejectedValue(new Error('boom'))

    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    await expect(fu.advance(turns(4))).resolves.toBeUndefined()
    expect(fu.done.value).toHaveLength(0)
  })

  it('**不做任何本地兜底判定** —— 关键词撞上了也不算问到了', async () => {
    // 「按关键词匹配划掉」正是错标最容易发生的地方。
    // 对话里出现了问题的字面词，但服务端没判它覆盖，就不许划。
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['有没有药物过敏？'], provider: 'x', degraded: false,
    } as never)
    vi.spyOn(api, 'followUpCoverage').mockResolvedValue({ covered: [], degraded: false } as never)

    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    await fu.advance([
      { role: 'doctor', text: '有没有药物过敏？' },
      { role: 'patient', text: '嗯……' },
    ])

    expect(fu.done.value).toHaveLength(0)
  })
})

describe('追问清单 · 展开时机', () => {
  it('攒够 3 条对话才自动浮出 —— 太早弹时一条都没划掉，像在催人', () => {
    expect(AUTO_OPEN_AFTER_MESSAGES).toBe(3)
  })

  it('reset 清空一切，包括医生关过的那个标记', async () => {
    vi.spyOn(api, 'followUpPlan').mockResolvedValue({
      questions: ['A？'], provider: 'x', degraded: false,
    } as never)
    const fu = useFollowUp(() => 'P006')
    await fu.loadPlan()
    fu.dismissed.value = true

    fu.reset()

    expect(fu.items.value).toHaveLength(0)
    expect(fu.dismissed.value).toBe(false)
    expect(fu.hasItems.value).toBe(false)
  })
})
