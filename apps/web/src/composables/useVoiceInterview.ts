import { computed, getCurrentInstance, onUnmounted, ref } from 'vue'

import { api, streamSse } from '../api'

/**
 * 语音问诊（F01）。
 *
 * 状态机：idle → playing ⇄ paused → awaiting →（医生点结束）→ ended
 *   - idle     ：显示「● 语音问诊」
 *   - playing  ：逐条推进医患对话
 *   - paused   ：医生暂停
 *   - awaiting ：**内容播完，但问诊还没结束** —— 医生可继续手动补问，或点「结束问诊」
 *   - ended    ：医生已结束，问诊小结已生成
 *
 * 为什么「播完」不等于「结束」：
 *   1. 正式环境是连续音频流，根本没有「播完」这个事件。靠静音判断会把医生
 *      查体、思考、敲字的停顿误判成结束，把问诊拦腰切断。
 *   2. 结束是有后果的动作 —— 它触发问诊小结，而小结要进病历。本项目里每个
 *      有后果的动作都要医生确认，这里不该例外。
 *   把结束交给医生点，MVP 的状态机就和正式环境一致了：接 ASR 时只是把
 *   「脚本推进」换成「音频流推进」，结束仍然是医生点的。
 *
 * 播放过程中：
 *   - 「AI 追问提示」清单随对话推进逐条划掉（浮层 pending-float）
 *   - 「补充观察」候选项可随时展开勾选（浮层 obs-float）
 *
 * 分工：对话脚本是演示数据，追问清单与补充观察是真实模型输出（voice/init）。
 * 播放结束后医生仍可手动补问，走 voice/turn。
 */

export type VoiceState = 'idle' | 'playing' | 'paused' | 'awaiting' | 'ended'

export interface VoiceTurnMessage {
  role: 'doctor' | 'patient'
  text: string
}

/** 每条对话的播放间隔。太快看不清逐条推进，太慢演示拖沓。 */
const TURN_INTERVAL_MS = 1400

export function useVoiceInterview(getPatientId: () => string) {
  const state = ref<VoiceState>('idle')
  const messages = ref<VoiceTurnMessage[]>([])
  const questions = ref<string[]>([])
  /** 模型给的候选观察项全集，不随对话变化 */
  const allObservations = ref<string[]>([])
  const pickedObservations = ref<Set<string>>(new Set())
  const showObservations = ref(false)
  const error = ref('')
  const degraded = ref(false)

  /** 已播完的对话条数，同时决定追问清单划掉到第几条 */
  const playedCount = ref(0)
  const script = ref<VoiceTurnMessage[]>([])

  let timer: ReturnType<typeof setInterval> | null = null

  /**
   * 问诊是否仍在进行。awaiting 也算 —— 内容播完但医生还没点结束，
   * 追问清单浮层要继续留着，让医生看到还有哪几条没问到。
   */
  const active = computed(() => state.value !== 'idle' && state.value !== 'ended')

  /**
   * 追问清单的完成判定：**语义判定**，不是按轮次顺序划掉。
   *
   * 「覆盖」是蕴含关系不是相似关系 —— 患者答「右手拿筷子拿不稳」完整回答了
   * 「哪一侧肢体无力」，两句几乎零字面重叠。所以关键词法与向量相似度都不适用，
   * 交给后端 /voice/coverage 由模型判定。
   *
   * 判定是**单调**的：一旦标记为已问就不再回退。既符合直觉，也让每次只需要
   * 把还开着的问题发过去，对话越往后 payload 越小。
   */
  const coveredIndexes = ref<Set<number>>(new Set())
  const coverageEvidence = ref<Map<number, string>>(new Map())
  const coverageDegraded = ref(false)

  const doneQuestions = computed(() => questions.value.filter((_, i) => coveredIndexes.value.has(i)))
  const pendingQuestions = computed(() =>
    questions.value.map((text, index) => ({
      text,
      index,
      done: coveredIndexes.value.has(index),
      evidence: coverageEvidence.value.get(index) ?? '',
    })),
  )
  /** 当前该问的那一条，浮层里高亮显示 */
  const currentQuestion = computed(() => pendingQuestions.value.find((q) => !q.done) ?? null)

  /** 医生手动勾销 —— 最便宜的正确性兜底，模型判错时一键纠正 */
  function toggleQuestionDone(index: number) {
    const next = new Set(coveredIndexes.value)
    next.has(index) ? next.delete(index) : next.add(index)
    coveredIndexes.value = next
  }

  let coveragePending = false

  /**
   * 判定当前还开着的问题有没有被对话覆盖。
   *
   * 异步非阻塞：界面任何时候都不等它。失败或降级时**不做任何标记** ——
   * 退回关键词或按轮次猜都会往「错标已问」偏，而错标会让该问的问题
   * 再也不提醒，那是不能接受的方向。宁可让医生看一份冗余的完整清单。
   */
  async function judgeCoverage() {
    const patientId = getPatientId()
    if (!patientId || coveragePending || !questions.value.length) return

    const open = pendingQuestions.value.filter((q) => !q.done)
    if (!open.length || !messages.value.length) return

    coveragePending = true
    try {
      const result = await api.voiceCoverage(
        patientId,
        open.map((q) => q.text),
        messages.value,
      )
      coverageDegraded.value = Boolean(result.degraded)
      if (result.degraded) return

      const next = new Set(coveredIndexes.value)
      const evidence = new Map(coverageEvidence.value)
      for (const item of result.covered) {
        // 后端返回的序号是「还开着的问题」里的位置，要映射回原始下标
        const origin = open[item.index - 1]
        if (!origin) continue
        next.add(origin.index)
        evidence.set(origin.index, item.evidence)
      }
      coveredIndexes.value = next
      coverageEvidence.value = evidence
    } catch {
      // 判定失败就保持现状，不猜
    } finally {
      coveragePending = false
    }
  }

  /** 已播出的对话全文，用于判断哪些观察项已经被问到 */
  const spokenText = computed(() => messages.value.map((m) => m.text).join(''))

  /**
   * 「待观察」清单：从候选全集里剔掉对话中已经覆盖到的条目。
   *
   * 与 V4.3 同一套判定 —— 去掉「有无/是否」这类问法前缀后取前 3 个字，
   * 在已说出的内容里做包含匹配。剩下的才是还需要医生补问的。
   * 静态清单看起来一样，但医生分不清哪些已经问过，价值差很多。
   */
  const observations = computed(() =>
    allObservations.value.filter((item) => {
      const key = item.replace(/[有无是否]/g, '').slice(0, 3)
      return key.length > 0 && !spokenText.value.includes(key)
    }),
  )

  /** 已被对话覆盖、从待观察里移出的条目，供界面说明「已覆盖 N 项」 */
  const coveredObservations = computed(() =>
    allObservations.value.filter((item) => !observations.value.includes(item)),
  )

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function tick() {
    if (playedCount.value >= script.value.length) {
      stopTimer()
      // 播完进 awaiting 而不是 ended：问诊由医生点「结束问诊」才算结束
      state.value = 'awaiting'
      // 再判一次，兜住奇数轮结尾
      void judgeCoverage()
      return
    }
    messages.value = [...messages.value, script.value[playedCount.value]]
    playedCount.value += 1

    // 一轮医患问答闭合时判一次。实时 ASR 下这里换成「静默 N 秒」的停顿判定，
    // 判定逻辑本身不用改。
    if (playedCount.value % 2 === 0) void judgeCoverage()
  }

  function startTimer() {
    stopTimer()
    // 先立刻播一条再起定时器：只用 setInterval 的话点完要干等一个间隔
    // 才看到第一句，观感上像是没反应。
    tick()
    timer = setInterval(tick, TURN_INTERVAL_MS)
  }

  async function start() {
    const patientId = getPatientId()
    if (!patientId) return

    stopTimer()
    messages.value = []
    playedCount.value = 0
    coveredIndexes.value = new Set()
    coverageEvidence.value = new Map()
    pickedObservations.value = new Set()
    error.value = ''
    state.value = 'playing'

    try {
      const init = await api.voiceInit(patientId)
      questions.value = init.questions ?? []
      allObservations.value = init.observations ?? []
      degraded.value = Boolean(init.degraded)
      if (degraded.value) {
        error.value = '模型通道不可用，追问清单为通用问法，未生成补充观察项。'
      }

      const dialog = (init.dialog ?? []) as { role: string; text: string }[]
      script.value = dialog.map((turn) => ({
        role: turn.role === 'patient' ? 'patient' : 'doctor',
        text: turn.text,
      }))

      if (!script.value.length) {
        // 没有演示脚本的患者：不假装播放，直接进入可手动补问的状态
        state.value = 'awaiting'
        error.value = '该患者没有演示对话脚本，可在下方手动录入患者所述。'
        return
      }
      startTimer()
    } catch (exc) {
      state.value = 'idle'
      error.value = `问诊初始化失败：${(exc as Error).message}`
    }
  }

  function pause() {
    if (state.value !== 'playing') return
    stopTimer()
    state.value = 'paused'
  }

  function resume() {
    if (state.value !== 'paused') return
    state.value = 'playing'
    startTimer()
  }

  function restart() {
    void start()
  }

  /** 手动补问会让问诊从 awaiting 回到「进行中」的语义，但不重启播放 */
  function ensureOpen() {
    if (state.value === 'ended') state.value = 'awaiting'
  }

  function toggleObservation(item: string) {
    const next = new Set(pickedObservations.value)
    next.has(item) ? next.delete(item) : next.add(item)
    pickedObservations.value = next
  }

  /** 手动补问：医生自己输入患者所述，取下一句追问建议。 */
  const manualThinking = ref(false)

  async function askManual(patientText: string) {
    const patientId = getPatientId()
    const text = patientText.trim()
    if (!patientId || !text || manualThinking.value) return

    ensureOpen()
    messages.value = [...messages.value, { role: 'patient', text }]
    messages.value = [...messages.value, { role: 'doctor', text: '' }]
    const index = messages.value.length - 1
    manualThinking.value = true

    try {
      await streamSse(
        '/api/emr/voice/turn',
        {
          patient_id: patientId,
          patient_text: text,
          turn_index: messages.value.length,
          conversation_history: messages.value.slice(0, -1),
        },
        (event) => {
          if (event.type === 'prompt_token') {
            messages.value[index].text += String(event.token)
          } else if (event.type === 'prompt_done') {
            const extra = (event.observations as string[]) ?? []
            allObservations.value = [...new Set([...allObservations.value, ...extra])]
          }
        },
      )
    } catch (exc) {
      messages.value[index].text = `（追问建议获取失败：${(exc as Error).message}）`
    } finally {
      manualThinking.value = false
      void judgeCoverage()
    }
  }

  const finishing = ref(false)

  /** 医生点「结束问诊」：生成问诊小结并收尾。这是本功能唯一的结束入口。 */
  async function finish() {
    stopTimer()
    finishing.value = true
    const patientId = getPatientId()

    if (patientId && messages.value.length) {
      try {
        await api.voiceComplete({
          patient_id: patientId,
          conversation_summary: [
            ...messages.value.map((m) => `${m.role === 'doctor' ? '医生' : '患者'}：${m.text}`),
            ...(pickedObservations.value.size ? [`补充观察：${[...pickedObservations.value].join('；')}`] : []),
          ].join('\n'),
          messages: messages.value,
        })
      } catch (exc) {
        error.value = `问诊小结生成失败：${(exc as Error).message}`
      }
    }
    state.value = 'ended'
  }

  // 只在组件 setup 里注册卸载钩子。composable 也会被测试直接调用，
  // 那时没有组件实例，无条件注册只会打出一条无意义的告警。
  if (getCurrentInstance()) onUnmounted(stopTimer)

  return {
    state,
    active,
    messages,
    questions,
    pendingQuestions,
    doneQuestions,
    currentQuestion,
    coverageDegraded,
    toggleQuestionDone,
    judgeCoverage,
    observations,
    coveredObservations,
    pickedObservations,
    showObservations,
    manualThinking,
    finishing,
    error,
    degraded,
    start,
    pause,
    resume,
    restart,
    finish,
    toggleObservation,
    askManual,
  }
}
