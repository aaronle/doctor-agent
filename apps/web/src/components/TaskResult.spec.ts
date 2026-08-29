import { mount } from '@vue/test-utils'

import type { AgentTask, CardViewModel } from '../types'
import TaskResult from './TaskResult.vue'

function task(status: string, content: Record<string, unknown>, badges: CardViewModel['badges'] = []): AgentTask {
  return {
    task_id: 'task-test',
    status,
    event_url: '/events/task-test',
    result_version: 1,
    events: [],
    result: {
      task_id: 'task-test',
      task_type: 'condition_summary',
      result_type: status === 'needs_clarification' ? 'clarification_request' : 'condition_summary',
      status,
      subject: { patient_id: 'P1', encounter_id: 'E1' },
      generated_at: '2026-08-28T08:00:00+08:00',
      data_cutoff_at: '2026-08-28T08:00:00+08:00',
      runtime: { mode: 'mock', agent_id: 'mock-condition', agent_version: '0.1.0' },
      content,
      evidence_refs: [],
      missing_data: [],
      conflicts: [],
      safety: { severity: 'info', requires_acknowledgement: false, blocking: status === 'needs_clarification' },
      allowed_actions: ['retry'],
      trace_id: 'trace-test',
    },
    card: {
      card_id: 'card-test',
      task_id: 'task-test',
      component: 'test',
      title: 'AI 病情概况',
      status,
      badges,
      meta: {},
      sections: [],
      evidence_actions: [],
      primary_actions: [],
      secondary_actions: [],
    },
  }
}

describe('TaskResult terminal states', () => {
  it('renders blocking clarification instead of leaving the task in loading state', () => {
    const wrapper = mount(TaskResult, {
      props: {
        taskType: 'condition_summary',
        task: task('needs_clarification', {
          reason: '缺少影响安全判断的关键信息',
          questions: [
            { question_id: 'Q1', text: '请补充过敏史', blocking: true },
            { question_id: 'Q2', text: '请补充既往用药', blocking: false },
          ],
        }),
      },
    })

    expect(wrapper.text()).toContain('需要补充信息')
    expect(wrapper.text()).not.toContain('智能体正在执行')
    expect(wrapper.findAll('.clarification-card label')).toHaveLength(2)
  })

  it('shows the degraded result badge on a usable result', () => {
    const wrapper = mount(TaskResult, {
      props: {
        taskType: 'condition_summary',
        task: task('degraded', { summary: '依据有限，以下内容需重点复核。', problems: [], timeline_changes: [] }, [
          { type: 'status', label: '降级结果', level: 'yellow' },
        ]),
      },
    })

    expect(wrapper.text()).toContain('降级结果')
    expect(wrapper.text()).toContain('依据有限')
  })

  it('offers a safe retry path after a runtime failure', async () => {
    const failedTask = task('failed', {})
    failedTask.result = null
    failedTask.card = null
    const wrapper = mount(TaskResult, { props: { taskType: 'condition_summary', task: failedTask } })

    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('未展示任何未经校验的临床内容')
    expect(wrapper.emitted('action')).toEqual([['retry']])
  })

  it('renders risk workflow states as doctor-facing Chinese labels', () => {
    const riskTask = task('ready', {})
    riskTask.result!.task_type = 'risk_management'
    riskTask.result!.result_type = 'risk_alert'
    riskTask.result!.content = {
      alerts: [
        {
          risk_id: 'R1',
          severity: 'critical',
          status: 'action_in_progress',
          title: '疑似马尾综合征',
          evidence: ['新发排尿困难'],
          recommended_action: '立即核实并记录处置',
        },
      ],
    }
    const wrapper = mount(TaskResult, { props: { taskType: 'risk_management', task: riskTask } })

    expect(wrapper.text()).toContain('处置中')
    expect(wrapper.text()).not.toContain('action_in_progress')
  })
})
