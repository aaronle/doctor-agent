import { computed, ref } from 'vue'

import { api } from '../api'

/**
 * AI 追问提示的状态机。
 *
 * 一份清单 + 「哪些已经问到了」的标记。三条不变量，改之前先读：
 *
 * **① 单调：已划掉的不会回来。** 判定是逐轮增量做的，每轮只把**还开着的**
 * 问题发上去 —— 服务端因此没有机会「取消划掉」某一条。一条已经答过的问题
 * 又变回未答，医生会当场不再信任这个清单。
 *
 * **② 非阻塞：判定在后台跑，跑不动就算了。** 它是提示，不是流程的一环。
 * 一次判定要 4–6 秒，而对话每 1.4 秒推进一条 —— 排队等它会让清单
 * 越落越远。同一时刻只允许一个判定在飞，飞着的时候新对话直接跳过这一轮。
 *
 * **③ 拿不准就不划。** 服务端只回「已覆盖」，降级时回空 —— 这里不做任何
 * 本地兜底判定（比如按关键词匹配）。漏划是医生多扫一眼，错划是该问的
 * 问题再也不提醒了。
 */

/** 攒够几条对话才自动浮出。太早弹时清单还没有任何东西被划掉，像在催人。 */
export const AUTO_OPEN_AFTER_MESSAGES = 3

/** 每新增几条对话跑一次判定。太勤只是烧钱，对话本身也没那么快产生新信息。 */
const COVERAGE_EVERY = 2

export interface FollowUpItem {
  question: string
  /** 判定为已问到时，患者的那句原话。没有原话的标记在服务端就被丢了 */
  quote: string
  done: boolean
}

export function useFollowUp(getPatientId: () => string) {
  const items = ref<FollowUpItem[]>([])
  const loading = ref(false)

  /** 医生手动关掉过。本轮问诊不再自动弹 —— 不跟医生较劲 */
  const dismissed = ref(false)

  const pending = computed(() => items.value.filter((i) => !i.done))
  const done = computed(() => items.value.filter((i) => i.done))
  const hasItems = computed(() => items.value.length > 0)

  /** 上次跑判定时的对话条数，用来算「又攒了几条」 */
  let judgedAt = 0
  /** 同一时刻只允许一个判定在飞 —— 见不变量 ② */
  let inFlight = false

  function reset() {
    items.value = []
    dismissed.value = false
    loading.value = false
    judgedAt = 0
    inFlight = false
  }

  /**
   * 取清单。**一场问诊只调一次。**
   *
   * 清单是从患者档案里读出来的缺口，对话推进不会改变它 ——
   * 会变的是「哪些已经问到了」。每轮重算清单会让条目在医生眼皮底下
   * 换来换去，比不给还糟。
   */
  async function loadPlan() {
    const patientId = getPatientId()
    if (!patientId || items.value.length) return
    loading.value = true
    try {
      const res = await api.followUpPlan(patientId)
      const qs = res?.degraded ? [] : res?.questions
      items.value = Array.isArray(qs)
        ? qs.map(String).filter((q) => q.trim()).map((question) => ({ question, quote: '', done: false }))
        : []
    } catch {
      // 提示功能取不到就没有，不打断问诊 —— 它不在关键路径上
      items.value = []
    } finally {
      loading.value = false
    }
  }

  /**
   * 对话推进后判定一次。调用方每来一条对话就调，这里自己决定跑不跑。
   *
   * 不 await 也没关系：它从不抛错，也不影响任何流程。
   */
  async function advance(messages: { role: string; text: string }[]) {
    const patientId = getPatientId()
    if (!patientId || inFlight) return
    if (messages.length - judgedAt < COVERAGE_EVERY) return
    const open = pending.value.map((i) => i.question)
    if (!open.length) return

    inFlight = true
    judgedAt = messages.length
    try {
      const res = await api.followUpCoverage(patientId, open, messages)
      const covered = res?.degraded ? [] : res?.covered
      if (!Array.isArray(covered)) return
      const byQuestion = new Map(
        covered
          .filter((c): c is { question: string; quote: string } => Boolean(c && c.question))
          .map((c) => [String(c.question), String(c.quote || '')]),
      )
      // **只从 false 翻到 true，不反向。** 见不变量 ①
      items.value = items.value.map((item) =>
        item.done || !byQuestion.has(item.question)
          ? item
          : { ...item, done: true, quote: byQuestion.get(item.question) || '' },
      )
    } catch {
      // 判定失败 = 这一轮不划任何东西。清单停在原地是安全的那个方向
    } finally {
      inFlight = false
    }
  }

  return {
    items,
    pending,
    done,
    hasItems,
    loading,
    dismissed,
    reset,
    loadPlan,
    advance,
  }
}
