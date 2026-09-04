import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, api, riskLevelRank, sortByRiskLevel, streamSse, type SseEvent } from './api'

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

afterEach(() => vi.unstubAllGlobals())

describe('SSE 解析', () => {
  it('按空行切分事件并逐条回调', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'data: {"type":"token","token":"血"}\n\n',
      'data: {"type":"token","token":"糖"}\n\n',
    ])))

    const events: SseEvent[] = []
    await streamSse('/api/emr/copilot/chat', {}, (e) => events.push(e))
    expect(events.map((e) => e.token)).toEqual(['血', '糖'])
  })

  it('事件被拆到多个网络分片时仍能正确重组', async () => {
    // 真实流式里一个事件常被 TCP 分片切断，缓冲区必须留住不完整的尾巴
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'data: {"type":"record_node_start","nod',
      'e_id":"chief_complaint"}\n\ndata: {"type":"record_node_done"}\n\n',
    ])))

    const events: SseEvent[] = []
    await streamSse('/api/emr/copilot/chat', {}, (e) => events.push(e))
    expect(events).toEqual([
      { type: 'record_node_start', node_id: 'chief_complaint' },
      { type: 'record_node_done' },
    ])
  })

  it('单条事件解析失败不中断整个流', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'data: {坏掉的JSON\n\n',
      'data: {"type":"token","token":"好"}\n\n',
    ])))

    const events: SseEvent[] = []
    await streamSse('/api/emr/copilot/chat', {}, (e) => events.push(e))
    expect(events).toEqual([{ type: 'token', token: '好' }])
  })

  it('HTTP 失败时抛 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))
    await expect(streamSse('/api/emr/copilot/chat', {}, () => {})).rejects.toBeInstanceOf(ApiError)
  })
})

describe('请求错误处理', () => {
  it('把后端的 detail 作为错误消息抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: '患者不存在' }), { status: 404 })),
    )
    await expect(api.patient('P999')).rejects.toThrow('患者不存在')
  })

  it('响应不是 JSON 时回落到状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })))
    await expect(api.patients()).rejects.toThrow('HTTP 502')
  })
})

describe('风险等级排序', () => {
  it('从高到低排 —— 列表的阅读顺序就是处置顺序', () => {
    // 线上出过：两条中风险（头颅MRI异常、颈部血管超声异常）压在两条高风险
    // （血压控制、血脂控制）**上面**，因为拼接顺序是「硬规则在前」，
    // 而硬规则里恰好有中风险。最急的排在最下面等于没有排序。
    const sorted = sortByRiskLevel([
      { level: '中风险', name: '头颅MRI异常' },
      { level: '低风险', name: '随访建议' },
      { level: '高风险', name: '血压控制' },
      { level: '中风险', name: '血糖控制' },
      { level: '高风险', name: '血脂控制' },
    ])
    expect(sorted.map((i) => i.level)).toEqual(['高风险', '高风险', '中风险', '中风险', '低风险'])
  })

  it('**稳定** —— 同一等级内保持传入次序，硬规则仍在模型项前面', () => {
    // 硬规则有明确阈值、是纯代码判定，同等级下比模型判断更硬，
    // 这个既有次序不能被排序打乱。
    const sorted = sortByRiskLevel([
      { level: '高风险', name: '硬规则·血钾危急值' },
      { level: '高风险', name: '模型·血压控制' },
    ])
    expect(sorted.map((i) => i.name)).toEqual(['硬规则·血钾危急值', '模型·血压控制'])
  })

  it('未知等级排最后，不是最前 —— 查不到不能冒充最高', () => {
    const sorted = sortByRiskLevel([
      { level: '', name: '怪东西' },
      { level: '低风险', name: '随访' },
    ])
    expect(sorted.map((i) => i.name)).toEqual(['随访', '怪东西'])
  })

  it('不改原数组', () => {
    const input = [{ level: '低风险' }, { level: '高风险' }]
    sortByRiskLevel(input)
    expect(input.map((i) => i.level)).toEqual(['低风险', '高风险'])
  })

  it('与服务端 RISK_LEVEL_ORDER 是同一套次序', () => {
    // 两份实现是有意的（服务端排好的顺序，前端拼硬规则时会重新打乱），
    // 但次序必须一致 —— 改一边忘另一边，两个列表会给出不同的轻重缓急。
    expect([riskLevelRank('高风险'), riskLevelRank('中风险'), riskLevelRank('低风险')])
      .toEqual([0, 1, 2])
  })
})

describe('ApiError · 结构化 detail', () => {
  it('**422 的逐条错误要能穿过 request() 到达调用方**', async () => {
    // 这条补的是一个覆盖空洞：composable 那侧的 takeErrors 有测试，
    // 但真正往 ApiError 上挂 detail 的是 request()，那一段一直没人测 ——
    // 把 `throw new ApiError(msg, status, raw)` 的第三个参数删掉，
    // composable 的测试**照样全绿**（它们是自己 new 出来的 ApiError）。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: { errors: ['cases[0] 缺 patient_id'] } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }),
    ))

    const err = await api.uploadDataset({ id: 'x' }).catch((e) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(422)
    expect((err.detail as { errors: string[] }).errors).toEqual(['cases[0] 缺 patient_id'])
  })

  it('detail 是字符串时 message 就取它 —— 多数接口是这种', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: '内置测试集不可删除' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }),
    ))

    const err = await api.deleteDataset('followup-prompt').catch((e) => e)

    expect(err.message).toBe('内置测试集不可删除')
    expect(err.detail).toBe('内置测试集不可删除')
  })

  it('detail 是对象时 message 退回状态码，**不能变成 [object Object]**', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: { errors: ['x'] } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }),
    ))

    const err = await api.uploadDataset({}).catch((e) => e)
    expect(err.message).toBe('HTTP 422')
    expect(err.message).not.toContain('object Object')
  })
})
