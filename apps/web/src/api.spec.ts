import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, api, streamSse, type SseEvent } from './api'

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
