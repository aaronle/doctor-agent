/**
 * 埋点上报。
 *
 * ## 三条要求
 *
 * **① 攒批发，不是一次点击一个请求。** 医生切个标签页就发一次 POST，
 * 既吵又会在弱网下排队堵住真正要紧的请求。
 *
 * **② 关页面时必须把没发出去的补发掉。** 定时器攒着的那一批，
 * 用户一关标签页就没了 —— 而「关页面前干了什么」往往正是要看的。
 * 用 `sendBeacon`：它专为这个场景设计，页面卸载后浏览器仍会把请求发完。
 *
 * **③ 出错就吞掉。** 埋点是旁路，它挂了不能影响医生。
 * 连失败重试都不做 —— 重试会在服务端不可用时把队列撑爆，
 * 而丢几条使用数据没有任何后果。
 */

const ENDPOINT = '/api/telemetry/events'

/** 攒够这么多条就发一次 */
const BATCH_SIZE = 20
/** 或者攒够这么久就发一次（毫秒） */
const FLUSH_MS = 10_000

export interface TrackEvent {
  event: string
  target?: string
  patient_id?: string
  props?: Record<string, unknown>
  client_ts: number
}

/**
 * 一次浏览器会话的 id。
 *
 * 用来算「人均点了几次」—— 只看总量的话，一个人狂点就能把数字刷上去。
 * 存 `sessionStorage`：刷新页面算同一次会话，关掉标签页算新的一次，
 * 这正是「一次门诊」的粒度。
 */
function sessionId(): string {
  const KEY = 'doctor-agent:telemetry-session'
  try {
    let id = window.sessionStorage?.getItem(KEY)
    if (!id) {
      id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      window.sessionStorage?.setItem(KEY, id)
    }
    return id
  } catch {
    // 隐私模式下 sessionStorage 会抛。给个一次性 id，总比不采强
    return `s_anon_${Math.random().toString(36).slice(2, 8)}`
  }
}

let queue: TrackEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let installed = false

function payload(events: TrackEvent[]) {
  return JSON.stringify({ session_id: sessionId(), actor: '', events })
}

function flush(useBeacon = false) {
  if (timer) { clearTimeout(timer); timer = null }
  if (!queue.length) return
  const batch = queue
  queue = []

  const body = payload(batch)
  try {
    if (useBeacon && navigator.sendBeacon) {
      // 页面卸载中：普通 fetch 会被浏览器取消，beacon 不会
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
      return
    }
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // **不重试。** 重试会在服务端不可用时把队列撑爆，
      // 而丢几条使用数据没有任何后果。
    })
  } catch {
    // 埋点挂了不能影响医生
  }
}

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  // 关标签页 / 切到后台时补发。`visibilitychange` 比 `unload` 可靠 ——
  // 移动端和某些桌面场景下 unload 根本不触发
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true)
  })
  window.addEventListener('pagehide', () => flush(true))
}

export function useTelemetry() {
  install()

  /**
   * 记一条。第三个参数是**事件特有的字段**（props），不是 TrackEvent 的部分覆盖 ——
   * 第一版写成后者，于是每加一种 prop 都要去改类型定义，调用点全部飘红。
   *
   * `patient_id` 从 props 里拎出来单独存：它是要按患者查的维度，
   * 埋在 JSON 里就没法建索引。
   */
  function track(event: string, target = '', props: Record<string, unknown> = {}) {
    const { patient_id: pid, ...rest } = props
    queue.push({
      event,
      target,
      patient_id: typeof pid === 'string' ? pid : '',
      props: rest,
      client_ts: Date.now(),
    })
    if (queue.length >= BATCH_SIZE) { flush(); return }
    if (!timer) timer = setTimeout(() => flush(), FLUSH_MS)
  }

  return { track, flush, sessionId, _queue: () => queue }
}

/** 测试用：把模块级队列清空 */
export function __resetTelemetry() {
  queue = []
  if (timer) { clearTimeout(timer); timer = null }
}
