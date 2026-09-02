import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import WorkstationView from './WorkstationView.vue'
import { useWorkstation } from '../stores/workstation'

/** 两条异常检验 + 一条异常检查，覆盖 lab / exam 两种类型 */
const PATIENT = {
  id: 'P001', name: '王某某', gender: '女', age: 58, visit_type: '复诊', dept: '内分泌科',
  doctor: '李医生', visit_date: '2026-06-17', chief_complaint: '血糖控制不佳',
  primary_diagnosis: '2型糖尿病', risk_level: '高风险',
  birth_date: '1968-03-15', allergy: { status: 'unknown' as const, items: [] },
  id_no: '', phone: '', is_return_visit: true, pre_consultation_done: true,
  nutrition_screening_score: 1,
  lab_results: [
    { name: '空腹血糖', value: '8.5', unit: 'mmol/L', ref: '<7.0', abnormal: true, diff_note: '较上次上升 0.7' },
    { name: '糖化血红蛋白', value: '8.6', unit: '%', ref: '<7.0', abnormal: true },
    { name: '血钾', value: '4.1', unit: 'mmol/L', ref: '3.5-5.5', abnormal: false },
  ],
  orders: [],
}

const SUMMARY = {
  overall_conclusion: {}, treatment_effectiveness: {},
  risk_assessments: [], risk_alerts: [], recommended_orders: [],
  examinations: [{ id: 'e1', name: '双眼底照相', abnormal: true, result: '双眼NPDR轻度', conclusion: '异常: NPDR 轻度' }],
  todos: [], dialog_script: [], record_nodes: {}, record_content: {},
    handled_alerts: [],
  is_return_visit: true, pre_consultation_done: true,
  suspected_diagnoses: [], differential_diagnosis: {}, visit_history: [],
  comorbidity: { detected: false, conditions: [] }, timeline: [],
  _meta: { degraded_agents: [], hard_rule_alerts: 0, model_conflicts: [], cached: false },
}

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:p(.*)', component: { template: '<div/>' } }],
})

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/his/patient/')) return new Response(JSON.stringify(PATIENT), { status: 200 })
      if (u.includes('report-summary')) return new Response(JSON.stringify(SUMMARY), { status: 200 })
      if (u.includes('assessment')) return new Response(JSON.stringify({ categories: [] }), { status: 200 })
      if (u.includes('/api/his/patients')) return new Response(JSON.stringify([PATIENT]), { status: 200 })
      if (u.includes('drugs')) return new Response(JSON.stringify([]), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }),
  )
}

async function render() {
  stubFetch()
  await router.push('/outpatient/P001')
  const pinia = createPinia()
  const wrapper = mount(WorkstationView, {
    global: { plugins: [pinia, router, ElementPlus] },
    attachTo: document.body,
  })
  // 直接注入 store：selectPatient 走真实加载链路，测试里只需要这两份数据到位
  const ws = useWorkstation(pinia)
  ws.patientId = 'P001'
  ws.patient = PATIENT as never
  ws.summary = SUMMARY as never
  // 等页头出现即可。原来等的是 `.result-list-item`（阳性结果列表），
  // 那个面板 2026-09-02 随 HIS 门面一起撤了 —— 等一个永远不会出现的东西，
  // 每条用例都会挂在超时上，而报错长得像「整个工作站没渲染」。
  await vi.waitFor(() => expect(wrapper.find('.his-header').exists()).toBe(true))
  return wrapper
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('HIS 门面已整块撤掉', () => {
  /**
   * 这套界面复刻的是 V4.3 演示件，不是北大国际医院的真实 HIS，而链接会被
   * 转发出去 —— 一个长得像 HIS 的页面很容易让人以为「已经和院内系统打通了」。
   *
   * 所以 2026-09-02 把仿真的 HIS 数据展示整块拿掉：左侧患者头像栏、
   * 门诊病历表单、医嘱面板、阳性结果、转诊 / 住院。
   *
   * **病历没有消失** —— AI 助手里本来就有自己那一份（「病历 AI 生成」那一栏），
   * 它才是 AI 草稿的落点与「确认后写回」的发生地。撤掉的是那份仿真展示。
   */
  it('不再渲染任何模拟 HIS 的面板', async () => {
    const wrapper = await render()
    for (const gone of [
      '.workstation-body', '.sidebar', '.his-record-panel', '.his-orders-panel',
      '.record-form-scroll', '.diagnosis-section',
    ]) {
      expect(wrapper.find(gone).exists(), `${gone} 还在`).toBe(false)
    }
  })

  it('页头常驻「未接入院内 HIS」标识，且不可关闭', async () => {
    // 这不是提示，是声明：看页面的人第一眼就该知道这不是院内系统。
    const wrapper = await render()
    const badge = wrapper.find('.demo-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('未接入任何院内 HIS')
    // 没有任何关闭它的控件
    expect(badge.find('button').exists()).toBe(false)
  })

  it('转诊 / 住院这类模拟 HIS 的动作不再提供', async () => {
    const wrapper = await render()
    const labels = wrapper.findAll('button').map((b) => b.text()).join('|')
    expect(labels).not.toContain('转诊')
    expect(labels).not.toContain('住院')
  })
})

describe('候诊栏健壮性', () => {
  it('队列里某位患者缺名字，不该让整个工作站白屏', async () => {
    // Vue 的渲染 throw 不是局部失败，是整棵树不渲染 ——
    // 渲染函数里一句 item.name.charAt(0) 就足以让整页空白。
    //
    // 原来这条靠 `.sa-avatar`（左侧患者头像栏）来验，那一栏已随 HIS 门面撤掉。
    // 关切没变，所以留着这条，只是改成不依赖已删元素：脏数据进 store 之后，
    // 页面骨架仍在、页头仍在。
    const wrapper = await render()
    const ws = useWorkstation()
    ws.queue = [{ id: 'P001', name: '王某某' }, { id: 'PX', dept: '内科' }] as never

    await wrapper.vm.$nextTick()
    expect(wrapper.find('.workstation-page').exists()).toBe(true)
    expect(wrapper.find('.his-header').exists()).toBe(true)
  })
})

describe('硬规则红线横幅', () => {
  /**
   * 它不跟 AI 分析一起锁在问诊门禁后面 —— 让医生在不知道血钾 6.8 的情况下
   * 问完一整轮，是不能接受的。
   */
  it('未问诊、分析还锁着时，红线照样显示', async () => {
    const wrapper = await render()
    const ws = useWorkstation()
    ws.visit = { patient_id: 'P001', interview_done: false, analysis_unlocked: false, unlocked_by: '', unlocked_at: '' } as never
    ws.hardAlerts = [{ id: 'k', name: '血钾 6.8 mmol/L', level: '高风险', color: '#e6191a', summary: '危急值' }] as never
    await wrapper.vm.$nextTick()

    const banner = wrapper.find('.redline-banner')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('血钾 6.8')
    expect(banner.text()).toContain('不依赖模型与问诊')
  })

  it('处置完就收起 —— 留着一条已闭环的红线只会让人麻木', async () => {
    const wrapper = await render()
    const ws = useWorkstation()
    ws.hardAlerts = [{ id: 'k', name: '血钾 6.8 mmol/L', level: '高风险', color: '#e6191a', summary: '' }] as never
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.redline-banner').exists()).toBe(true)

    ws.markAlertHandled('k')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.redline-banner').exists()).toBe(false)
  })

  it('没有红线时不占位', async () => {
    const wrapper = await render()
    expect(wrapper.find('.redline-banner').exists()).toBe(false)
  })

  it('「逐条处置」发事件切到预警评估，不另开一套处置入口', async () => {
    const wrapper = await render()
    const ws = useWorkstation()
    ws.hardAlerts = [{ id: 'k', name: '血钾 6.8', level: '高风险', color: '#e6191a', summary: '' }] as never
    await wrapper.vm.$nextTick()

    const seen: string[] = []
    const onTab = (e: Event) => seen.push((e as CustomEvent).detail as string)
    window.addEventListener('da:open-tab', onTab)
    await wrapper.find('.redline-banner button').trigger('click')
    window.removeEventListener('da:open-tab', onTab)

    expect(seen).toEqual(['预警评估'])
  })
})
