import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetTelemetry, useTelemetry } from './useTelemetry'

/** 埋点上报。攒批发、关页面补发、出错吞掉。 */

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  __resetTelemetry()
  window.sessionStorage.clear()
  fetchSpy = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function bodyOf(call: unknown[]) {
  return JSON.parse((call[1] as RequestInit).body as string)
}

describe('埋点 · 攒批', () => {
  it('几条不发 —— 一次点击一个 POST 太吵，弱网下还会堵住要紧的请求', () => {
    const t = useTelemetry()
    t.track('tab_switch', '预警评估')
    t.track('tab_switch', '病历管理')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('攒够 20 条自动发', () => {
    const t = useTelemetry()
    for (let i = 0; i < 20; i++) t.track('ping')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(bodyOf(fetchSpy.mock.calls[0]).events).toHaveLength(20)
  })

  it('攒够 10 秒也发 —— 不然零星几条会一直留在内存里', () => {
    vi.useFakeTimers()
    const t = useTelemetry()
    t.track('ping')
    expect(fetchSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10_000)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('发完清空队列，不会重复上报', () => {
    const t = useTelemetry()
    for (let i = 0; i < 20; i++) t.track('ping')
    t.flush()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('埋点 · 关页面补发', () => {
  it('页面隐藏时用 **sendBeacon** 补发 —— 普通 fetch 会被浏览器取消', () => {
    const beacon = vi.fn().mockReturnValue(true)
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon })

    const t = useTelemetry()
    t.track('interview_start')
    t.flush(true)

    expect(beacon).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('没有 sendBeacon 就退回 fetch，别整个不发', () => {
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: undefined })
    const t = useTelemetry()
    t.track('ping')
    t.flush(true)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // keepalive 让请求在页面卸载后还能发完
    expect((fetchSpy.mock.calls[0][1] as RequestInit).keepalive).toBe(true)
  })

  it('队列空时不发空请求', () => {
    const t = useTelemetry()
    t.flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('埋点 · 出错吞掉', () => {
  it('fetch 抛异常不能冒到医生的操作上', () => {
    fetchSpy.mockImplementation(() => { throw new Error('network down') })
    const t = useTelemetry()

    expect(() => { for (let i = 0; i < 20; i++) t.track('ping') }).not.toThrow()
  })

  it('**失败不重试** —— 重试会在服务端不可用时把队列撑爆', async () => {
    fetchSpy.mockRejectedValue(new Error('500'))
    const t = useTelemetry()
    for (let i = 0; i < 20; i++) t.track('ping')
    await Promise.resolve()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(t._queue()).toHaveLength(0)   // 丢掉，不排队
  })
})

describe('埋点 · 会话 id', () => {
  it('同一次会话共用一个 id —— 用来算人均，只看总量会被一个人狂点刷上去', () => {
    const a = useTelemetry().sessionId()
    const b = useTelemetry().sessionId()
    expect(a).toBe(b)
    expect(a).toMatch(/^s_/)
  })

  it('sessionStorage 抛异常也要能采，别整个哑掉', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(useTelemetry().sessionId()).toMatch(/^s_anon_/)
  })
})

describe('埋点 · props 与 patient_id', () => {
  it('第三个参数是 props 包，不是 TrackEvent 的部分覆盖', () => {
    // 第一版写成后者，于是每加一种 prop 都要去改类型定义，调用点全部飘红。
    const t = useTelemetry()
    for (let i = 0; i < 19; i++) t.track('pad')
    t.track('generate', '', { turns: 7, patient_id: 'P008' })

    const last = bodyOf(fetchSpy.mock.calls[0]).events.at(-1)
    expect(last.props).toEqual({ turns: 7 })
  })

  it('**patient_id 从 props 里拎出来单独存** —— 埋在 JSON 里就没法建索引', () => {
    const t = useTelemetry()
    for (let i = 0; i < 19; i++) t.track('pad')
    t.track('generate', '', { turns: 7, patient_id: 'P008' })

    const last = bodyOf(fetchSpy.mock.calls[0]).events.at(-1)
    expect(last.patient_id).toBe('P008')
    expect(last.props.patient_id).toBeUndefined()
  })
})

describe('埋点不能拖住正经请求', () => {
  /**
   * 常规攒批上报**不加 `keepalive`**。
   *
   * `keepalive` 是给「页面正在卸载」那一次用的 —— 而那一次已经走 `sendBeacon`。
   * 常规上报加上它没有任何好处，却要占 Chromium 的 keepalive 配额
   * （全局 64KB，且这类请求的生命周期不跟随页面）。
   *
   * 走查里实测过：`telemetry/events` 与
   * `report-summary?refresh=true` 一起挂在「在途」，而后者服务端 22 秒就返回了。
   * **埋点是旁路，它绝不该和临床请求抢连接。**
   */
  it('常规上报不带 keepalive', async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      calls.push(init)
      return new Response('{}', { status: 200 })
    }))

    const { track, flush } = useTelemetry()
    track('probe', 'x')
    flush()

    expect(calls).toHaveLength(1)
    expect(calls[0].keepalive).not.toBe(true)
  })

  it('页面卸载那一次仍然用 sendBeacon —— 那才是它该在的地方', () => {
    const beacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { track, flush } = useTelemetry()
    track('probe', 'y')
    flush(true)

    expect(beacon).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
