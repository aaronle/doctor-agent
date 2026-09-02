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

  it('内容播完只进 awaiting，不算问诊结束', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await play(voice, DIALOG.length)
    await vi.advanceTimersByTimeAsync(1400)

    // 「播完」不等于「结束」：正式环境是连续音频流，根本没有播完这个事件；
    // 而结束会触发问诊小结进病历，属于有后果的动作，必须医生点。
    expect(voice.state.value).toBe('awaiting')
    expect(voice.messages.value).toHaveLength(DIALOG.length)
  })

  it('awaiting 时问诊仍算进行中 —— 内容播完不等于问诊结束', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await play(voice, DIALOG.length)
    await vi.advanceTimersByTimeAsync(1400)

    expect(voice.state.value).toBe('awaiting')
    // active 决定浮层是否显示 —— 医生还没结束，就该看得到哪几条没问到
    expect(voice.active.value).toBe(true)
  })

  it('只有医生点结束才转 ended', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await play(voice, DIALOG.length)
    await vi.advanceTimersByTimeAsync(1400)
    expect(voice.state.value).toBe('awaiting')

    await voice.finish()
    expect(voice.state.value).toBe('ended')
    expect(voice.active.value).toBe(false)
  })

  it('结束后手动补录会回到 awaiting，不是重开一场', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await play(voice, DIALOG.length)
    await vi.advanceTimersByTimeAsync(1400)
    await voice.finish()
    expect(voice.state.value).toBe('ended')

    const before = voice.messages.value.length
    voice.recordPatientUtterance('还有点头晕')
    expect(voice.state.value).toBe('awaiting')
    // 补录是接着说，不是清空重来
    expect(voice.messages.value.length).toBeGreaterThan(before)
    // **只记患者原话，不生成任何医生侧建议** —— 那是已撤掉的追问提示
    expect(voice.messages.value.at(-1)).toEqual({ role: 'patient', text: '还有点头晕' })
  })




  it('落库不改变状态 —— 生成/更新不该顺手把问诊结束掉', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()
    expect(voice.state.value).toBe('playing')

    await voice.persist()

    // 「结束」只能由医生点「结束问诊」。早先落库复用了 finish()，
    // 点一下「更新」问诊就悄悄结束了。
    expect(voice.state.value).toBe('playing')
    expect(voice.active.value).toBe(true)
  })



  it('继续问诊：脚本没播完就接着播', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()
    await vi.advanceTimersByTimeAsync(1400)
    const played = voice.messages.value.length

    // 结束后再点继续，应从上次的位置接着播，而不是重头来
    await voice.finish()
    expect(voice.state.value).toBe('ended')

    voice.resumeCapture()
    expect(voice.state.value).toBe('playing')
    await vi.advanceTimersByTimeAsync(1400)
    expect(voice.messages.value.length).toBeGreaterThan(played)
  })

  it('继续问诊：内容已播完则切回可录入状态，不假装还有可播的', async () => {
    stubInit()
    const voice = useVoiceInterview(() => 'P006')
    await play(voice, DIALOG.length)
    await vi.advanceTimersByTimeAsync(1400)
    await voice.finish()

    const before = voice.messages.value.length
    voice.resumeCapture()

    expect(voice.state.value).toBe('awaiting')
    await vi.advanceTimersByTimeAsync(5000)
    expect(voice.messages.value).toHaveLength(before)
  })

  it('没有演示脚本时不假装播放', async () => {
    stubInit({ dialog: [] })
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()

    expect(voice.state.value).toBe('awaiting')
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




  it('一条都没录到就点结束，状态机照样收尾', async () => {
    stubInit({ dialog: [] })
    const voice = useVoiceInterview(() => 'P006')
    await voice.start()
    expect(voice.messages.value).toHaveLength(0)

    await voice.finish()

    // 早先「有没有消息」的判断写在调用方，没消息就整个跳过 finish()，
    // 于是分析已经解锁、界面却还停在 awaiting，一副问诊没结束的样子。
    expect(voice.state.value).toBe('ended')
    expect(voice.active.value).toBe(false)
  })

  it('一期不提供追问提示与补充观察 —— 撤掉的东西不该从后门回来', async () => {
    // 这两块给的是「接下来该问什么」的临床建议，而一期没有临床知识库支撑：
    // 建议错一条的代价大于不给建议，何况它出现在医生正在问诊的那一刻。
    //
    // 服务端 voice/init 仍会返回 questions / observations（接口形状留着，
    // 等知识库就位再接），所以**必须有一条测试盯住前端不消费它们** ——
    // 否则哪天有人「顺手接上」，一个不准的清单就又回到医生眼前了。
    stubInit()
    const voice = useVoiceInterview(() => 'P006') as unknown as Record<string, unknown>
    await (voice.start as () => Promise<void>)()

    for (const gone of [
      'questions', 'pendingQuestions', 'doneQuestions', 'currentQuestion',
      'observations', 'coveredObservations', 'pickedObservations',
      'showObservations', 'observationsVisible',
      'toggleQuestionDone', 'toggleObservation', 'judgeCoverage', 'coverageDegraded',
      'askManual', 'manualThinking',
    ]) {
      expect(voice[gone], `useVoiceInterview 不该再暴露 ${gone}`).toBeUndefined()
    }
  })
})
