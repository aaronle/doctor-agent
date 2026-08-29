import { mount } from '@vue/test-utils'

import ComorbidityResult from './ComorbidityResult.vue'
import DiagnosisManagementResult from './DiagnosisManagementResult.vue'
import DifferentialResult from './DifferentialResult.vue'
import RecordDraftResult from './RecordDraftResult.vue'
import RiskManagementResult from './RiskManagementResult.vue'
import SpecialtyAssessmentPanel from './SpecialtyAssessmentPanel.vue'
import VoiceInterviewResult from './VoiceInterviewResult.vue'
import VoiceRecorderMock from './VoiceRecorderMock.vue'

describe('phase one product interaction effects', () => {
  it('runs the explicit voice recording state machine before generating a result', async () => {
    const wrapper = mount(VoiceRecorderMock)
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('录音中')
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('已暂停')
    await wrapper.findAll('button')[1].trigger('click')
    expect(wrapper.emitted('complete')).toHaveLength(1)
  })

  it('streams doctor-patient turns and updates the follow-up coach before completion', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount(VoiceRecorderMock, {
        props: {
          patient: {
            fixture_id: 'IM-001', specialty: '内科-内分泌代谢', scenario: '糖尿病复诊',
            patient_id: 'MOCK-IM-001', encounter_id: 'ENC-IM-001', name: '王某某', gender: '女', age: 58,
            chief_complaint: '血糖控制不佳，口渴多饮2周', allergy: '无已知药物过敏',
            facts: { medications: ['二甲双胍'], exams: ['眼底：NPDR轻度'] },
          },
        },
      })
      await wrapper.get('.recorder-actions .primary').trigger('click')
      expect(wrapper.text()).toContain('AI 追问提示')
      expect(wrapper.text()).toContain('医生')
      await vi.advanceTimersByTimeAsync(2200)
      expect(wrapper.text()).toContain('患者')
      expect(wrapper.text()).toContain('血糖控制不佳，口渴多饮2周')
      expect(wrapper.text()).toContain('下一句建议')
      await vi.advanceTimersByTimeAsync(7500)
      expect(wrapper.emitted('complete')).toHaveLength(1)
      expect(wrapper.text()).toContain('问诊对话已完成')
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports the original compact conversation layout inside the doctor agent', () => {
    const wrapper = mount(VoiceRecorderMock, { props: { compact: true } })
    expect(wrapper.find('.sidebar-conversation').exists()).toBe(true)
    expect(wrapper.find('.sidebar-followup-coach').exists()).toBe(true)
    expect(wrapper.find('.voice-live-layout').exists()).toBe(false)
  })

  it('adds a structured supplemental observation without skipping scripted dialogue', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount(VoiceRecorderMock, { props: { compact: true, autostart: true } })
      await wrapper.vm.$nextTick()
      await wrapper.get('.observation-toggle').trigger('click')
      expect(wrapper.find('.supplemental-observation-panel').exists()).toBe(true)
      await wrapper.get('.observation-option').trigger('click')
      expect(wrapper.text()).toContain('【补充观察】')
      expect(wrapper.emitted('observation')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(9000)
      expect(wrapper.emitted('complete')).toHaveLength(1)
      expect(wrapper.emitted('complete')?.[0]?.[0]).toHaveLength(1)
      expect(wrapper.findAll('.sidebar-conversation-turn')).toHaveLength(9)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows speaker, confidence and correction controls for voice transcript', async () => {
    const wrapper = mount(VoiceInterviewResult, {
      props: { content: { recording: { duration_seconds: 24 }, transcript_segments: [
        { segment_id: 'S1', speaker: 'patient', started_at_seconds: 3, text: '头晕', confidence: 0.72 },
      ], structured_history: { chief_complaint: '头晕' }, clarifications: ['发生时间'] } },
    })
    expect(wrapper.text()).toContain('低置信 72%')
    await wrapper.get('button').trigger('click')
    expect(wrapper.find('input').exists()).toBe(true)
  })

  it('supports paragraph-level record adoption and mock write-back', async () => {
    const wrapper = mount(RecordDraftResult, { props: { content: {
      sections: [{ section_id: 'chief', title: '主诉', ai_text: '头晕2天', status: 'generated', source_refs: ['E1'] }],
      validation: { score: 72, message: '需复核', issues: ['体格检查待补充'] },
    } } })
    await wrapper.get('.section-actions .primary').trigger('click')
    expect(wrapper.text()).toContain('accepted')
    await wrapper.get('.writeback-bar button').trigger('click')
    expect(wrapper.emitted('writeback')).toHaveLength(1)
  })

  it('supports differential diagnosis decisions without auto-confirming', async () => {
    const wrapper = mount(DifferentialResult, { props: { content: { candidates: [{
      candidate_id: 'D1', name: '异位妊娠待排', priority: 'must_not_miss', supporting_evidence: [{ text: '腹痛出血' }],
      opposing_evidence: ['未获得'], missing_information: ['生命体征'], uncertainty: '需医生判断',
    }] } } })
    await wrapper.get('.differential-title-row button').trigger('click')
    expect(wrapper.text()).toContain('已确认')
  })

  it('maintains one primary diagnosis and emits mock write-back', async () => {
    const wrapper = mount(DiagnosisManagementResult, { props: { content: {
      diagnoses: [
        { diagnosis_id: 'D1', name: '诊断一', status: 'provisional', is_primary: true, source: 'AI', consistency: 'consistent', icd_code: '待确认' },
        { diagnosis_id: 'D2', name: '诊断二', status: 'rule_out', is_primary: false, source: 'AI', consistency: 'consistent', icd_code: '待确认' },
      ], validation: { issues: ['编码待确认'] },
    } } })
    await wrapper.findAll('.diagnosis-row button')[2].trigger('click')
    expect(wrapper.findAll('.diagnosis-row button.primary')).toHaveLength(1)
    await wrapper.get('.writeback-bar button').trigger('click')
    expect(wrapper.emitted('writeback')).toHaveLength(1)
  })

  it('creates a visibly simulated comorbidity action instead of claiming execution', async () => {
    const wrapper = mount(ComorbidityResult, { props: { content: { conditions: [{
      problem_id: 'C1', name: '糖尿病', group: 'current_relevant', control_status: 'unknown', relevance: '影响愈合',
      care_gaps: ['近期 HbA1c'], interactions: [], risk_links: [],
    }] } } })
    await wrapper.get('.comorbidity-card button.primary').trigger('click')
    expect(wrapper.text()).toContain('已创建随访草稿')
    expect(wrapper.text()).toContain('待医生确认')
  })

  it('distinguishes red urgent risks from yellow moderate risks', () => {
    const task: any = {
      task_id: 'RISK-1', status: 'ready', result: { task_type: 'risk_management', result_type: 'risk_alert', content: { alerts: [
        { risk_id: 'R1', severity: 'critical', status: 'new', title: '脑梗死复发风险', evidence: ['发病3天内为复发高峰'], recommended_action: '立即启动二级预防', due_label: '立即' },
        { risk_id: 'R2', severity: 'warning', status: 'acknowledged', title: '血糖失控预警', evidence: ['HbA1c 7.8%'], recommended_action: '本次就诊内调整方案', due_label: '本次就诊内' },
      ] } },
    }
    const wrapper = mount(RiskManagementResult, { props: { task } })
    expect(wrapper.text()).toContain('红色·紧急')
    expect(wrapper.text()).toContain('黄色·中度')
    expect(wrapper.text()).toContain('红色必须处置并阻断')
  })

  it('opens and closes one risk detail without expanding every risk', async () => {
    const task: any = {
      task_id: 'RISK-DETAIL-1', status: 'ready', result: {
        data_cutoff_at: '2026-08-29T15:30:00+08:00',
        task_type: 'risk_management', result_type: 'risk_alert', content: { alerts: [
          {
            risk_id: 'R1', severity: 'critical', status: 'new', title: '脑梗死复发风险',
            evidence: ['急性脑梗死', '既往 TIA'], recommended_action: '立即启动二级预防', due_label: '立即',
            source: '安全规则 + 风险管理智能体', category: '专病与诊疗安全',
            impact: '未闭环前阻断病历与诊断关键提交', assessment_refs: ['专病风险评估'],
            skill_refs: ['并发症风险筛查'],
          },
          { risk_id: 'R2', severity: 'warning', status: 'new', title: '血糖失控预警', evidence: ['HbA1c 7.8%'], recommended_action: '本次就诊内调整方案' },
        ] },
      },
    }
    const wrapper = mount(RiskManagementResult, { props: { task } })
    expect(wrapper.find('.risk-detail-panel').exists()).toBe(false)
    await wrapper.findAll('.risk-advice-link')[0].trigger('click')
    expect(wrapper.findAll('.risk-detail-panel')).toHaveLength(1)
    expect(wrapper.text()).toContain('关键证据')
    expect(wrapper.text()).toContain('安全规则 + 风险管理智能体')
    expect(wrapper.text()).toContain('专项评估可以发现或关联风险')
    await wrapper.findAll('.risk-advice-link')[0].trigger('click')
    expect(wrapper.find('.risk-detail-panel').exists()).toBe(false)
  })

  it('keeps all specialty assessment groups collapsed until the doctor expands one', async () => {
    const wrapper = mount(SpecialtyAssessmentPanel)
    expect(wrapper.text()).toContain('诊疗质控助手')
    expect(wrapper.text()).toContain('患者服务助手')
    expect(wrapper.text()).toContain('运营管理助手')
    expect(wrapper.text()).toContain('临床科研助手')
    expect(wrapper.text()).toContain('临床教学助手')
    expect(wrapper.findAll('.assessment-item')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('危急值闭环管理')
    expect(wrapper.text()).not.toContain('帮助医师与患者科学认识预后')
    await wrapper.findAll('.assessment-group-title')[0].trigger('click')
    expect(wrapper.findAll('.assessment-item')).toHaveLength(7)
    expect(wrapper.text()).toContain('危急值闭环管理')
    await wrapper.findAll('.assessment-item')[1].trigger('click')
    expect(wrapper.text()).toContain('早期识别高危患者')
    await wrapper.findAll('.assessment-group-title')[0].trigger('click')
    expect(wrapper.findAll('.assessment-item')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('早期识别高危患者')
  })

  it('emits the risk alert cross-link only for a must-not-miss diagnosis', async () => {
    const wrapper = mount(DifferentialResult, { props: { content: { candidates: [
      {
        candidate_id: 'D1', name: '异位妊娠破裂', priority: 'must_not_miss', supporting_evidence: [{ text: '停经、腹痛、阴道流血' }],
        opposing_evidence: ['未获得'], missing_information: ['生命体征'], uncertainty: '需医生判断', risk_links: ['GYN-R01'],
      },
      {
        candidate_id: 'D2', name: '先兆流产', priority: 'possible', supporting_evidence: [{ text: '停经、流血' }],
        opposing_evidence: [], missing_information: [], uncertainty: '需医生判断', risk_links: [],
      },
    ] } } })
    expect(wrapper.findAll('.differential-risk-link')).toHaveLength(1)
    await wrapper.get('.differential-risk-link').trigger('click')
    expect(wrapper.emitted('risk-alert')?.[0]).toEqual([['GYN-R01']])
  })
})
