import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVoiceInterview } from './useVoiceInterview'

const DIALOG = [
  { role: 'doctor', text: '哪一侧肢体无力？' },
  { role: 'patient', text: '右边手脚不利索。' },
  { role: 'doctor', text: '有没有进行性加重？' },
  { role: 'patient', text: '这三天差不多。' },
]

/** 覆盖判定的桩：默认判「第一条已覆盖」，用于验证映射与单调性 */
function stubInit(payload: Partial<Record<string, unknown>> = {}, coverage: { index: number; evidence: string }[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/voice/coverage')) {
        return new Response(JSON.stringify({ covered: coverage, provider: 'haiku', degraded: false }), { status: 200 })
      }
      if (url.includes('/voice/init/')) {
        return new Response(
          JSON.stringify({
            greeting: '您好',
            patient_name: '赵某某',
            chief_complaint: '右侧肢体无力',
            diagnoses: [],
            dialog: DIALOG,
            questions: ['哪一侧肢体无力？', '有无进行性加重？', '有无言语不清？'],
            observations: ['右上肢肌力', '吞咽功能', '睡眠质量'],
            provider: 'haiku',
            degraded: false,
            ...payload,
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }),
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 起播并推进 n 条对话 */
async function play(voice: ReturnType<typeof useVoiceInterview>, turns: number) {
  await voice.start()
  // start() 内部第一条是立即播出的，其余按定时器推进
  for (let i = 1; i < turns; i += 1) await vi.advanceTimersByTimeAsync(1400)
}

describe('语音问诊', () => {
  it('按脚本逐条播放，不是一次性刷出全部对话', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')

    await voice.start()
    expect(voice.messages.value).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1400)
    expect(voice.messages.value).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(1400)
    expect(voice.messages.value).toHaveLength(3)
  })

  it('播完转 ended', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await play(voice, DIALOG.length)
    await vi.advanceTimersByTimeAsync(1400)

    expect(voice.state.value).toBe('ended')
    expect(voice.messages.value).toHaveLength(DIALOG.length)
  })

  it('追问清单按语义判定划掉，不是按轮次顺序', async () => {
    // 后端判定「第 2 条（有无进行性加重）已覆盖」——若按轮次顺序，划掉的会是第 1 条
    stubInit({}, [{ index: 2, evidence: '这三天差不多。' }])
    const voice = useVoiceInterview(() => 'P006')

    await voice.start()
    expect(voice.doneQuestions.value).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1400)
    await vi.advanceTimersByTimeAsync(0)

    expect(voice.doneQuestions.value).toEqual(['有无进行性加重？'])
    expect(voice.currentQuestion.value?.index).toBe(0)
  })

  it('覆盖判定是单调的，已标记的不会回退', async () => {
    stubInit({}, [{ index: 1, evidence: 'x' }])
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()
    await vi.advanceTimersByTimeAsync(1400)
    await vi.advanceTimersByTimeAsync(0)
    const first = voice.doneQuestions.value.length
    expect(first).toBeGreaterThan(0)

    // 后续判定不再返回该条，它也不能掉回未问
    await vi.advanceTimersByTimeAsync(1400)
    await vi.advanceTimersByTimeAsync(0)
    expect(voice.doneQuestions.value.length).toBeGreaterThanOrEqual(first)
  })

  it('判定降级时不做任何标记，宁可让清单冗余也不错标已问', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/voice/coverage')) {
          return new Response(JSON.stringify({ covered: [], provider: 'local-rules', degraded: true }), { status: 200 })
        }
        if (url.includes('/voice/init/')) {
          return new Response(
            JSON.stringify({
              greeting: '您好', patient_name: '赵某某', chief_complaint: '右侧肢体无力', diagnoses: [],
              dialog: DIALOG, questions: ['哪一侧肢体无力？', '有无进行性加重？'], observations: [],
              provider: 'haiku', degraded: false,
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }),
    )
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()
    await vi.advanceTimersByTimeAsync(1400)
    await vi.advanceTimersByTimeAsync(0)

    expect(voice.coverageDegraded.value).toBe(true)
    expect(voice.doneQuestions.value).toHaveLength(0)
  })

  it('医生可手动勾销，模型判错时能一键纠正', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()

    voice.toggleQuestionDone(1)
    expect(voice.doneQuestions.value).toContain('有无进行性加重？')

    voice.toggleQuestionDone(1)
    expect(voice.doneQuestions.value).not.toContain('有无进行性加重？')
  })

  it('待观察清单会剔掉对话中已经问到的条目', async () => {
    // 「右上肢肌力」的判定键是「右上肢」，患者说「右边手脚不利索」不含它 —— 保留
    // 「吞咽功能」的判定键是「吞咽功」，对话未涉及 —— 保留
    stubInit({ observations: ['右上肢肌力', '有无进行性加重', '睡眠质量'] })
    const voice = useVoiceInterview(() => 'P006')

    await voice.start()
    expect(voice.observations.value).toContain('有无进行性加重')

    // 播到医生问出「有没有进行性加重？」后，该项应从待观察里移出
    await play(voice, 3)
    expect(voice.observations.value).not.toContain('有无进行性加重')
    expect(voice.coveredObservations.value).toContain('有无进行性加重')
    // 未被提及的仍在清单里
    expect(voice.observations.value).toContain('睡眠质量')
  })

  it('暂停后不再推进，继续后恢复', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()

    voice.pause()
    const frozen = voice.messages.value.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(voice.messages.value).toHaveLength(frozen)

    voice.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(voice.messages.value.length).toBeGreaterThan(frozen)
  })

  it('没有演示脚本时不假装播放', async () => {
    stubInit({ dialog: [] })
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()

    expect(voice.state.value).toBe('ended')
    expect(voice.messages.value).toHaveLength(0)
    expect(voice.error.value).toContain('没有演示对话脚本')
  })

  it('模型降级时显式标注，不静默给通用清单', async () => {
    stubInit({ degraded: true })
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()

    expect(voice.degraded.value).toBe(true)
    expect(voice.error.value).toContain('模型通道不可用')
  })
})
