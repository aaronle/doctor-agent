import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

    // 新患者同样带一条未处置的红色风险
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('/report-summary/') ? makeSummary([{ id: 'r9' }]) : { id: 'P002', name: '张某' }
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
