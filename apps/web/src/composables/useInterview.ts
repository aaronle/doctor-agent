import { computed, getCurrentInstance, onUnmounted, ref } from 'vue'

import { api } from '../api'

/**
 * 问诊记录（F01）。
 *
 * 状态机：idle → playing → awaiting ⇄（继续问诊）→ ended →（继续问诊）→ awaiting
 *   - idle     ：显示「● 开始问诊」
 *   - playing  ：逐条推进医患对话
 *   - awaiting ：**内容播完，但问诊还没结束** —— 可继续录入，或点「结束问诊」
 *   - ended    ：医生已结束并生成全部内容；点「继续问诊」可回到 awaiting 接着录
 *
 * 界面只有两个按钮：「▶ 继续问诊」与「■ 结束问诊」，构成一个可重复的循环 ——
 * 继续录入 → 结束并生成 → 还要补就再继续。医生不需要判断该点哪个按钮。
 *
 * 为什么「播完」不等于「结束」：
 *   1. 正式环境是连续音频流，根本没有「播完」这个事件。靠静音判断会把医生
 *      查体、思考、敲字的停顿误判成结束，把问诊拦腰切断。
 *   2. 结束是有后果的动作 —— 它触发问诊小结，而小结要进病历。本项目里每个
 *      有后果的动作都要医生确认，这里不该例外。
 *   把结束交给医生点，MVP 的状态机就和正式环境一致了：接 ASR 时只是把
 *   「脚本推进」换成「音频流推进」，结束仍然是医生点的。
 *
 * **一期不做「AI 追问提示」与「补充观察」**（2026-09-02 撤）。
 * 这两块给的是「接下来该问什么」的临床建议，而一期没有临床知识库支撑 ——
 * 建议错一条的代价大于不给建议，何况它出现在医生正在问诊的那一刻，干扰最直接。
 * 服务端 voice/init 仍会返回 questions / observations，前端**有意不消费**：
 * 留着接口形状，等知识库就位再接，比现在给一个不准的清单强。
 *
 * 分工：对话脚本是演示数据。播放结束后医生仍可手动补问，走 voice/turn。
 */

export type VoiceState = 'idle' | 'playing' | 'awaiting' | 'ended'

export interface VoiceTurnMessage {
  role: 'doctor' | 'patient'
  text: string
}

/** 每条对话的播放间隔。太快看不清逐条推进，太慢演示拖沓。 */
const TURN_INTERVAL_MS = 1400

export function useInterview(getPatientId: () => string) {
  const state = ref<VoiceState>('idle')
  const messages = ref<VoiceTurnMessage[]>([])
  const error = ref('')
  const degraded = ref(false)

  /** 已播完的对话条数 */
  const playedCount = ref(0)
  const script = ref<VoiceTurnMessage[]>([])

  let timer: ReturnType<typeof setInterval> | null = null

  /**
   * 问诊是否仍在进行。**awaiting 也算** —— 内容播完但医生还没点结束，
   * 那时问诊并没有结束，只是没有新内容在播。
   */
  const active = computed(() => state.value !== 'idle' && state.value !== 'ended')

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
      return
    }
    messages.value = [...messages.value, script.value[playedCount.value]]
    playedCount.value += 1
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
    error.value = ''
    state.value = 'playing'

    try {
      const init = await api.interviewInit(patientId)
      degraded.value = Boolean(init.degraded)
      if (degraded.value) {
        error.value = '模型通道不可用，本次问诊按本地规则进行。'
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

  /**
   * 「继续问诊」：继续记录患者所述。
   *
   * 脚本还没播完就接着播；已经播完（或已结束）就切回可录入状态，
   * 医生可以继续跟患者对话，或自己补充内容。
   */
  function resumeCapture() {
    if (state.value === 'idle') {
      void start()
      return
    }
    if (playedCount.value < script.value.length) {
      state.value = 'playing'
      startTimer()
      return
    }
    // 内容已播完：不假装还有可播的，直接开放手动录入
    state.value = 'awaiting'
  }

  /** 手动补问会让问诊从已结束回到进行中，但不重启播放 */
  function ensureOpen() {
    if (state.value === 'ended') state.value = 'awaiting'
  }

  /**
   * 手动补录：把医生转述的患者原话记进本次问诊。
   *
   * **只记录，不给追问建议**（2026-09-02）。原先这里会流式吐出一句
   * 「下一句该问什么」，那和已撤掉的「AI 追问提示」是同一类东西 ——
   * 没有临床知识库支撑时建议错一条的代价大于不给建议，只是从常驻改成了按需。
   * 记录本身是纯事实，没有这个问题，所以留下。
   *
   * 不再需要网络请求：内容会随「结束问诊」一起落库。
   */
  function recordPatientUtterance(patientText: string) {
    const text = patientText.trim()
    if (!text) return
    ensureOpen()
    messages.value = [...messages.value, { role: 'patient', text }]
  }

  const finishing = ref(false)

  /**
   * 把当前问诊记录落库，**不改变状态**。
   *
   * 「生成」「更新」都需要先落库（下游上下文读的是持久化后的问诊记录），
   * 但它们不该顺手把问诊结束掉 —— 结束只能由医生点「结束问诊」。
   * 早先把落库和结束写在同一个函数里，点一下「更新」问诊就悄悄结束了。
   */
  async function persist() {
    const patientId = getPatientId()
    if (!patientId || !messages.value.length) return
    try {
      await api.interviewComplete({
        patient_id: patientId,
        conversation_summary: messages.value
          .map((m) => `${m.role === 'doctor' ? '医生' : '患者'}：${m.text}`)
          .join('\n'),
        messages: messages.value,
      })
    } catch (exc) {
      error.value = `问诊记录落库失败：${(exc as Error).message}`
      throw exc
    }
  }

  /** 医生点「结束问诊」：落库 + 收尾。这是唯一的结束入口。 */
  async function finish() {
    stopTimer()
    finishing.value = true
    try {
      await persist()
    } catch {
      // 落库失败已写进 error，仍然收尾，避免卡在进行中
    }
    state.value = 'ended'
    finishing.value = false
  }

  // 只在组件 setup 里注册卸载钩子。composable 也会被测试直接调用，
  // 那时没有组件实例，无条件注册只会打出一条无意义的告警。
  if (getCurrentInstance()) onUnmounted(stopTimer)

  return {
    state,
    active,
    messages,
    finishing,
    error,
    degraded,
    start,
    resumeCapture,
    persist,
    finish,
    recordPatientUtterance,
  }
}
