import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { entries, installDebugHandle, log, setEnabled, time } from './logging'

type Handle = {
  on: () => void
  off: () => void
  dump: () => void
  json: () => string
  slow: (ms?: number) => unknown[]
  clear: () => void
}

const handle = () => (window as unknown as { __da: Handle }).__da

beforeEach(() => {
  installDebugHandle()
  handle().clear()
  setEnabled(false)
})

afterEach(() => {
  handle()?.clear()
  vi.restoreAllMocks()
})

describe('结构化日志', () => {
  it('关闭时仍然进缓冲 —— 出问题往往是事后才想起要看日志', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    setEnabled(false)

    log('workstation', 'submit_record', { patient: 'P001' })

    expect(spy, '关闭时不该往控制台刷字').not.toHaveBeenCalled()
    expect(entries(), '但缓冲必须记下 —— 关掉的只是输出，不是记录').toHaveLength(1)
    expect(entries()[0]).toMatchObject({ scope: 'workstation', event: 'submit_record' })
  })

  it('打开后才输出到控制台', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    setEnabled(true)
    log('admin', 'publish', { agent: 'record' })
    expect(spy).toHaveBeenCalled()
  })

  it('time 成功时记 ok 与耗时', async () => {
    const result = await time('admin', 'run_eval', async () => 'done', { agent: 'record' })
    expect(result).toBe('done')

    const entry = entries().at(-1)!
    expect(entry.event).toBe('run_eval')
    expect(entry.data?.ok).toBe(true)
    expect(typeof entry.data?.ms).toBe('number')
  })

  it('time 失败也记耗时 —— 「失败得多快」本身是线索', async () => {
    // 3ms 失败多半是本地校验，20s 失败多半是网关超时
    await expect(
      time('admin', 'publish', async () => {
        throw new Error('409 红色风险未处置')
      }),
    ).rejects.toThrow('409')

    const entry = entries().at(-1)!
    expect(entry.data?.ok).toBe(false)
    expect(entry.data?.error).toContain('409')
    expect(typeof entry.data?.ms).toBe('number')
  })

  it('缓冲是环形的，不会无限涨', () => {
    for (let i = 0; i < 620; i++) log('t', 'tick', { i })
    expect(entries().length).toBeLessThanOrEqual(500)
    // 丢的是最老的，最新的必须在
    expect(entries().at(-1)?.data?.i).toBe(619)
  })

  it('__da.slow 只挑慢的 —— 首屏聚合本来就十几秒，阈值太低全是噪音', () => {
    log('a', 'fast', { ms: 40 })
    log('b', 'slow', { ms: 2400 })
    const slow = handle().slow(1000) as { event: string }[]
    expect(slow.map((e) => e.event)).toEqual(['slow'])
  })

  it('__da.json 能一次性导出，便于贴进工单', () => {
    log('x', 'y', { z: 1 })
    const parsed = JSON.parse(handle().json())
    expect(parsed).toHaveLength(1)
    expect(parsed[0].scope).toBe('x')
  })

  it('localStorage 不可用时不能把页面搞挂', () => {
    const original = window.localStorage.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('隐私模式')
    })
    // 隐私模式下 localStorage 会抛。日志开不开，不值得让整页挂掉。
    expect(() => installDebugHandle()).not.toThrow()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(original)
  })
})
