import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkstation } from './workstation'
import type { ReportSummary, RiskItem } from '../api'

function makeSummary(alerts: Partial<RiskItem>[]): ReportSummary {
  return {
    overall_conclusion: {},
    treatment_effectiveness: {},
    risk_assessments: [],
    risk_alerts: alerts.map((a, i) => ({
      id: a.id ?? `alert-${i}`,
      name: a.name ?? '风险',
      level: '高风险',
      color: 'danger',
      summary: '',
      ...a,
    })) as RiskItem[],
    recommended_orders: [],
    examinations: [],
    recommended_exams: [],
    handled_alerts: [],
    todos: [],
    dialog_script: [],
    record_nodes: {},
    record_content: {},
    is_return_visit: false,
    pre_consultation_done: false,
    suspected_diagnoses: [],
    differential_diagnosis: {},
    visit_history: [],
    comorbidity: { detected: false, conditions: [] },
    timeline: [],
    _meta: { degraded_agents: [], hard_rule_alerts: alerts.length, model_conflicts: [], cached: false },
  }
}

describe('工作站状态', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('没有红色风险时不阻断写回', () => {
    const ws = useWorkstation()
    ws.summary = makeSummary([])
    expect(ws.writeBackBlocked).toBe(false)
  })

  it('存在未处置的红色风险时阻断写回', () => {
    const ws = useWorkstation()
    ws.summary = makeSummary([{ id: 'r1', name: '血钾危急值' }])
    expect(ws.writeBackBlocked).toBe(true)
    expect(ws.openRedAlerts).toHaveLength(1)
  })

  it('逐条处置后解除阻断', () => {
    const ws = useWorkstation()
    ws.summary = makeSummary([{ id: 'r1' }, { id: 'r2' }])
    ws.markAlertHandled('r1')
    expect(ws.writeBackBlocked).toBe(true)
    ws.markAlertHandled('r2')
    expect(ws.writeBackBlocked).toBe(false)
  })

  it('降级岗位数决定是否显示降级标记', () => {
    const ws = useWorkstation()
    const summary = makeSummary([])
    summary._meta.degraded_agents = ['risk', 'diagnosis']
    ws.summary = summary
    expect(ws.isDegraded).toBe(true)
    expect(ws.degradedAgents).toEqual(['risk', 'diagnosis'])
  })

  it('AI 草稿必须经确认才进入正式病历', () => {
    const ws = useWorkstation()
    ws.record = { chief_complaint: '医生原文' }
    ws.draft = { chief_complaint: 'AI 草稿', present_illness: 'AI 现病史' }

    // 未确认前正式病历不变
    expect(ws.record.chief_complaint).toBe('医生原文')

    ws.acceptDraftField('chief_complaint')
    expect(ws.record.chief_complaint).toBe('AI 草稿')
    expect(ws.record.present_illness).toBeUndefined()

    ws.acceptAllDraft()
    expect(ws.record.present_illness).toBe('AI 现病史')
  })

  it('切换患者会清空上一位的草稿与风险处置记录', async () => {
    const ws = useWorkstation()
    ws.patientId = 'P001'
    ws.summary = makeSummary([{ id: 'r1' }])
    ws.markAlertHandled('r1')
    ws.draft = { chief_complaint: '上一位患者的草稿' }
    expect(ws.writeBackBlocked).toBe(false)

    // 新患者同样带一条未处置的红色风险。
    // visit-state 给「已解锁」：改成状态机后，selectPatient 只对解锁过的就诊拉分析。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        let body: unknown = { id: 'P002', name: '张某' }
        if (u.includes('/report-summary/')) body = makeSummary([{ id: 'r9' }])
        else if (u.includes('visit-state')) {
          body = { patient_id: 'P002', interview_done: true, analysis_unlocked: true, unlocked_by: 'interview', unlocked_at: '' }
        } else if (u.includes('red-alerts')) {
          body = { patient_id: 'P002', alerts: [], handled_alerts: [], open_count: 0 }
        }
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    await ws.selectPatient('P002')

    expect(ws.draft).toEqual({})
    // 上一位的处置记录不能带过来，否则新患者的红色风险会被误判为已闭环
    expect(ws.openRedAlerts.map((a) => a.id)).toEqual(['r9'])
    expect(ws.writeBackBlocked).toBe(true)
    vi.unstubAllGlobals()
  })
})

describe('重新生成不许盖掉医生改过的段', () => {
  // 每条用例开一份干净的 store —— Pinia 实例是共享的，
  // 不隔离的话上一条的 draft 会漏进下一条（第一次写就中招了）
  beforeEach(() => setActivePinia(createPinia()))

  /**
   * F02 SAFE-002：**新概况不得覆盖医生正在编辑的病历。**
   *
   * `generateRecord()` 第一行是 `ws.draft = {}` —— 把整份草稿清空再流式写入。
   * 医生改完现病史、又多问两句、再点一次「生成」，改的东西无声消失。
   *
   * 这条以前踩不到（七段是 readonly，没东西可丢），是 2026-09-04 把它们
   * 改成可编辑之后才变成可达路径 —— **放开一个只读约束，等于打开它
   * 原本挡住的所有下游风险**。
   */
  it('医生改过的段落在重新生成时保留', () => {
    const ws = useWorkstation()
    ws.setDraftByDoctor('present_illness', '医生写的现病史')
    ws.draft.chief_complaint = 'AI 写的主诉'

    ws.resetDraftForRegenerate()

    expect(ws.draft.present_illness).toBe('医生写的现病史')
    expect(ws.draft.chief_complaint).toBeUndefined()
  })

  it('保留了哪几段要能说出来 —— 悄悄保留和悄悄覆盖一样糟', () => {
    const ws = useWorkstation()
    ws.setDraftByDoctor('present_illness', 'x')
    ws.setDraftByDoctor('past_history', 'y')

    expect(ws.resetDraftForRegenerate()).toEqual(['present_illness', 'past_history'])
  })

  it('AI 流式写入不许覆盖医生改过的段', () => {
    const ws = useWorkstation()
    ws.setDraftByDoctor('present_illness', '医生写的')
    ws.resetDraftForRegenerate()

    ws.appendDraftFromModel('present_illness', 'AI 想写的')
    ws.appendDraftFromModel('past_history', 'AI 写的既往史')

    expect(ws.draft.present_illness).toBe('医生写的')
    expect(ws.draft.past_history).toBe('AI 写的既往史')
  })

  it('换患者时医生的编辑标记要清掉 —— 否则**下一位患者那一段永远是空的**', () => {
    // 第一版这条是空过的：断言写的是 `resetDraftForRegenerate() === []`，
    // 而 draft 清空后过滤器本来就会把陈旧标记滤掉 —— 标记留不留都通过。
    //
    // 真实危害在别处：标记还在的话，下一位患者生成时
    // `appendDraftFromModel` 会**跳过**这一段，那一栏就永远空着。
    // 按危害写断言才抓得住。
    const ws = useWorkstation()
    ws.setDraftByDoctor('present_illness', '上一位患者的内容')

    ws.clearDraft()
    ws.appendDraftFromModel('present_illness', '新患者的 AI 现病史')

    expect(ws.draft.present_illness).toBe('新患者的 AI 现病史')
  })

  it('换患者（selectPatient 的重置路径）同样要清标记', async () => {
    // clearDraft 是显式入口，但真实路径是选患者时的整体重置 —— 两条都要清
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ id: 'P002', alerts: [], _meta: { degraded_agents: [] } }), { status: 200 })))
    const ws = useWorkstation()
    ws.setDraftByDoctor('present_illness', '上一位患者的内容')

    await ws.selectPatient('P002')
    ws.appendDraftFromModel('present_illness', '新患者的 AI 现病史')

    expect(ws.draft.present_illness).toBe('新患者的 AI 现病史')
  })
})

describe('就诊状态机', () => {
  // 必须自己重置：上一个 describe 的 beforeEach 不覆盖这里，
  // 沿用同一个 store 的话 patientId 已是 P002，selectPatient 会因 id 相同直接返回。
  beforeEach(() => setActivePinia(createPinia()))

  /** 一进来只该拉客观数据，不该跑那四个岗位 */
  function stubEntry(unlocked: boolean, alerts: { id: string; level?: string }[] = []) {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        calls.push(u)
        let body: unknown = { id: 'P002', name: '张某' }
        if (u.includes('visit-state')) {
          body = {
            patient_id: 'P002', interview_done: unlocked, analysis_unlocked: unlocked,
            unlocked_by: unlocked ? 'interview' : '', unlocked_at: '',
          }
        } else if (u.includes('red-alerts')) {
          body = { patient_id: 'P002', alerts, handled_alerts: [], open_count: alerts.length }
        } else if (u.includes('/report-summary/')) {
          body = makeSummary([{ id: 'model-red' }])
        } else if (u.includes('analysis/unlock')) {
          body = { ok: true, patient_id: 'P002', interview_done: false, analysis_unlocked: true, unlocked_by: 'skipped', unlocked_at: '' }
        }
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    return calls
  }

  afterEach(() => vi.unstubAllGlobals())

  it('一进来不跑 report-summary —— 那四个岗位的结论要等问诊', async () => {
    const calls = stubEntry(false)
    const ws = useWorkstation()
    await ws.selectPatient('P002')

    expect(ws.analysisUnlocked).toBe(false)
    expect(calls.some((u) => u.includes('/report-summary/')), '未解锁时不该调分析').toBe(false)
    // 但客观数据要拉
    expect(calls.some((u) => u.includes('red-alerts'))).toBe(true)
    expect(calls.some((u) => u.includes('visit-state'))).toBe(true)
  })

  it('已解锁的就诊，刷新后要把分析拿回来', async () => {
    // 否则医生问完一轮、刷新一下，八页又锁回去了
    const calls = stubEntry(true)
    const ws = useWorkstation()
    await ws.selectPatient('P002')

    expect(ws.analysisUnlocked).toBe(true)
    expect(calls.some((u) => u.includes('/report-summary/'))).toBe(true)
  })

  it('硬规则红线不等分析 —— 危急值一进来就在门禁里', async () => {
    // 只取 summary 的话，分析没出来之前 redAlerts 是空的，
    // 而提交病历那条路在那时候本来就走得通，等于门禁在最需要它的阶段敞开
    stubEntry(false, [{ id: 'hard-k', level: '高风险' }])
    const ws = useWorkstation()
    await ws.selectPatient('P002')

    expect(ws.redAlerts.map((a) => a.id)).toEqual(['hard-k'])
    expect(ws.writeBackBlocked).toBe(true)
  })

  it('**中风险的硬规则不算红线**，不进横幅也不阻断回写', async () => {
    // 判据只能是 level，不能是来源。
    //
    // 原来这里是「硬规则出的都是红的」—— 那在当时成立（硬规则只有过敏冲突、
    // 危急值、生命体征越界三条，全是高风险），但它把一个**巧合**当成了不变量。
    // 2026-09-03 加了「阳性检查结论」这条中风险硬规则之后：
    //
    //   - 横幅写着「硬规则**红色**风险 5 条」，而其中 4 条是中风险
    //   - `writeBackBlocked` 跟着为真，**病历提交与诊断回写被中风险拦住**
    //
    // 服务端早就按 level 筛了（routers/emr.py 的 `is_red`），只有这里没筛 ——
    // 于是界面禁着按钮，而服务端其实放行。零容忍门禁一旦拦错东西，
    // 医生下一步就是想办法绕过它，那时真正该拦的也拦不住了。
    stubEntry(false, [
      { id: 'hard-allergy', level: '高风险' },
      { id: 'hard-xray', level: '中风险' },
      { id: 'hard-mri', level: '中风险' },
    ])
    const ws = useWorkstation()
    await ws.selectPatient('P002')

    expect(ws.redAlerts.map((a) => a.id)).toEqual(['hard-allergy'])
    expect(ws.openRedAlerts).toHaveLength(1)
  })

  it('只有中风险时完全不阻断回写', async () => {
    stubEntry(false, [{ id: 'hard-xray', level: '中风险' }])
    const ws = useWorkstation()
    await ws.selectPatient('P002')

    expect(ws.redAlerts).toEqual([])
    expect(ws.writeBackBlocked).toBe(false)
  })

  it('硬规则与模型红线合并去重，不重复计数', async () => {
    stubEntry(true, [{ id: 'model-red', level: '高风险' }])
    const ws = useWorkstation()
    await ws.selectPatient('P002')
    expect(ws.redAlerts.map((a) => a.id)).toEqual(['model-red'])
  })

  it('跳过问诊会解锁并标 skipped —— 界面据此标「未含问诊」', async () => {
    stubEntry(false)
    const ws = useWorkstation()
    await ws.selectPatient('P002')
    expect(ws.interviewIncluded).toBe(false)

    await ws.unlockAndAnalyse('skipped')
    expect(ws.analysisUnlocked).toBe(true)
    expect(ws.interviewIncluded, '跳过不等于问过').toBe(false)
  })

  it('换患者时状态归零，不把上一位的解锁带过来', async () => {
    stubEntry(true)
    const ws = useWorkstation()
    await ws.selectPatient('P002')
    expect(ws.analysisUnlocked).toBe(true)

    stubEntry(false)
    await ws.selectPatient('P003')
    expect(ws.analysisUnlocked).toBe(false)
  })

  it('红线接口返回体缺 alerts 时不能把工作站搞挂', async () => {
    // Vue 的渲染函数一抛就是整棵树不渲染 —— 白屏，不是局部失败
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    const ws = useWorkstation()
    await ws.selectPatient('P002')
    expect(ws.redAlerts).toEqual([])
  })
})
