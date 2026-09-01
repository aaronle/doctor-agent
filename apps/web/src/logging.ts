/**
 * 前端结构化日志。
 *
 * **为什么不用裸 console.log**：出问题时真正需要的是「按什么顺序发生了什么、
 * 各自耗时多少」，而不是散落各处的字符串。这里统一成 `{ts, scope, event, ...}`，
 * 并留一份环形缓冲，出问题时一条命令导出，不必复现。
 *
 * **默认关闭**：诊间用的系统，控制台不该一直刷字。三种打开方式：
 *   - URL 加 `?debug=1`（当次会话有效，会写进 localStorage）
 *   - 控制台执行 `__da.on()`
 *   - `localStorage.setItem('da_debug', '1')`
 *
 * 出问题时怎么取：
 *   `__da.dump()`   → 打成表格看
 *   `__da.json()`   → 复制成 JSON 贴给我
 *   `__da.slow(500)`→ 只看耗时超过 500ms 的
 */

export interface LogEntry {
  ts: string
  /** 毫秒时间戳，算耗时用 —— ISO 串相减要解析，麻烦 */
  t: number
  scope: string
  event: string
  data?: Record<string, unknown>
  /** 该事件自身耗时，由 `time()` 填 */
  ms?: number
}

const STORAGE_KEY = 'da_debug'
/** 环形缓冲上限。一次门诊几百条足够，再多是内存负担 */
const MAX_ENTRIES = 500

const buffer: LogEntry[] = []
let enabled = false

function readFlag(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('debug') === '1') {
      window.localStorage.setItem(STORAGE_KEY, '1')
      return true
    }
    if (params.get('debug') === '0') {
      window.localStorage.removeItem(STORAGE_KEY)
      return false
    }
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // 隐私模式下 localStorage 会抛。日志开不开不值得让页面挂掉
    return false
  }
}

function push(entry: LogEntry) {
  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) buffer.shift()
}

/**
 * 记一条。
 *
 * **即使关闭也进缓冲**：出问题往往是在事后才想起来要看日志，
 * 那时再打开开关重现一遍，现场早没了。关闭的只是控制台输出。
 */
export function log(scope: string, event: string, data?: Record<string, unknown>) {
  const now = Date.now()
  const entry: LogEntry = { ts: new Date(now).toISOString(), t: now, scope, event, data }
  push(entry)
  if (enabled) {
    // eslint-disable-next-line no-console
    console.debug(`%c[${scope}]%c ${event}`, 'color:#3b6ef5;font-weight:600', 'color:inherit', data ?? '')
  }
}

/**
 * 给一段异步过程记时。
 *
 * 成功与失败都会落一条，且**失败也带耗时** —— 「失败得多快」本身就是线索：
 * 3ms 失败多半是本地校验，20s 失败多半是网关超时。
 */
export async function time<T>(scope: string, event: string, fn: () => Promise<T>, data?: Record<string, unknown>): Promise<T> {
  const start = Date.now()
  try {
    const result = await fn()
    log(scope, event, { ...data, ok: true, ms: Date.now() - start })
    return result
  } catch (error) {
    log(scope, event, { ...data, ok: false, ms: Date.now() - start, error: (error as Error).message })
    throw error
  }
}

export function entries(): LogEntry[] {
  return [...buffer]
}

export function setEnabled(on: boolean) {
  enabled = on
  try {
    if (on) window.localStorage.setItem(STORAGE_KEY, '1')
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 同上，写不进去不影响本次会话
  }
}

/** 把调试入口挂到 window，出问题时不必改代码就能取现场 */
export function installDebugHandle() {
  if (typeof window === 'undefined') return
  enabled = readFlag()
  const handle = {
    on: () => setEnabled(true),
    off: () => setEnabled(false),
    entries,
    dump: () => {
      // eslint-disable-next-line no-console
      console.table(buffer.map((e) => ({ 时间: e.ts.slice(11, 23), 模块: e.scope, 事件: e.event, 耗时ms: e.data?.ms ?? '', 详情: JSON.stringify(e.data ?? {}) })))
    },
    json: () => JSON.stringify(buffer, null, 2),
    /** 只看慢的。默认 1 秒 —— 首屏聚合本来就要十几秒，阈值太低会全是噪音 */
    slow: (thresholdMs = 1000) => buffer.filter((e) => Number(e.data?.ms ?? 0) >= thresholdMs),
    clear: () => buffer.splice(0, buffer.length),
  }
  ;(window as unknown as Record<string, unknown>).__da = handle
  if (enabled) {
    // eslint-disable-next-line no-console
    console.info('%c[da]%c 调试日志已开启。__da.dump() 看表格，__da.json() 导出，__da.off() 关闭。', 'color:#3b6ef5;font-weight:600', 'color:inherit')
  }
}
