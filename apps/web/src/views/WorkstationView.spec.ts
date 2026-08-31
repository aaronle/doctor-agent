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
  await vi.waitFor(() => expect(wrapper.findAll('.result-list-item').length).toBeGreaterThan(0))
  return wrapper
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('阳性结果', () => {
  it('只列异常项，检查在前检验在后', async () => {
    const wrapper = await render()
    const items = wrapper.findAll('.result-list-item')

    // 血钾正常，不该进来
    expect(items).toHaveLength(3)
    expect(items[0].find('.rli-badge').text()).toBe('检查')
    expect(items[1].find('.rli-badge').text()).toBe('检验')
    expect(wrapper.text()).not.toContain('血钾')
  })

  it('标题显示条数', async () => {
    const wrapper = await render()
    expect(wrapper.find('.rp-title').text()).toContain('阳性结果 (3)')
  })

  it('点一条展开该条详情，列表让位', async () => {
    const wrapper = await render()
    expect(wrapper.find('.result-detail').exists()).toBe(false)

    await wrapper.findAll('.result-list-item')[1].trigger('click')

    const detail = wrapper.find('.result-detail')
    expect(detail.exists()).toBe(true)
    expect(detail.find('.rd-type').text()).toContain('检验结果')
    // detail 是「值 单位（参考: x）」，不是简单重复名称
    expect(detail.find('.rd-content').text()).toContain('8.5')
    expect(detail.find('.rd-content').text()).toContain('<7.0')
    expect(wrapper.find('.result-list').exists()).toBe(false)
  })

  it('展开后标题换成该条名称，并给出返回入口', async () => {
    const wrapper = await render()
    await wrapper.findAll('.result-list-item')[1].trigger('click')

    expect(wrapper.find('.rp-title').text()).toContain('空腹血糖')
    expect(wrapper.find('.rp-title').text()).not.toContain('阳性结果')

    const back = wrapper.findAll('button').find((b) => b.text().includes('查看全部'))
    expect(back, '展开后必须能回到列表，否则等于把其余结果藏死了').toBeTruthy()
    await back!.trigger('click')
    expect(wrapper.find('.result-detail').exists()).toBe(false)
    expect(wrapper.findAll('.result-list-item')).toHaveLength(3)
  })

  it('回列表后点另一条，显示的是新那条而不是上一条', async () => {
    // 注：展开后列表被详情顶掉，所以「再点同一条收起」这条路在原件里也走不通，
    // 回列表只能靠「查看全部」。真正要防的是详情没换、还留着上一条。
    const wrapper = await render()
    await wrapper.findAll('.result-list-item')[0].trigger('click')
    expect(wrapper.find('.rd-content').text()).toContain('NPDR')

    await wrapper.findAll('button').find((b) => b.text().includes('查看全部'))!.trigger('click')
    await wrapper.findAll('.result-list-item')[1].trigger('click')
    expect(wrapper.find('.rd-content').text()).toContain('8.5')
    expect(wrapper.find('.rd-content').text()).not.toContain('NPDR')
  })

  it('换患者时收起展开态，不把上一位的结果留在面板里', async () => {
    const wrapper = await render()
    await wrapper.findAll('.result-list-item')[0].trigger('click')
    expect(wrapper.find('.result-detail').exists()).toBe(true)

    useWorkstation().patientId = 'P002'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.result-detail').exists()).toBe(false)
  })

  it('异常结论标红，正常不标', async () => {
    const wrapper = await render()
    // 双眼底照相的结论含「异常」
    await wrapper.findAll('.result-list-item')[0].trigger('click')
    expect(wrapper.find('.rd-extra').classes()).toContain('abnormal')
  })

  it('无异常时给空态，不出空列表', async () => {
    stubFetch()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/api/his/patient/')) {
          return new Response(JSON.stringify({ ...PATIENT, lab_results: [] }), { status: 200 })
        }
        if (u.includes('report-summary')) {
          return new Response(JSON.stringify({ ...SUMMARY, examinations: [] }), { status: 200 })
        }
        if (u.includes('/api/his/patients')) return new Response(JSON.stringify([PATIENT]), { status: 200 })
        return new Response(JSON.stringify({ categories: [] }), { status: 200 })
      }),
    )
    const pinia = createPinia()
    const wrapper = mount(WorkstationView, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    const ws = useWorkstation(pinia)
    ws.patientId = 'P001'
    ws.patient = { ...PATIENT, lab_results: [] } as never
    ws.summary = { ...SUMMARY, examinations: [] } as never
    await vi.waitFor(() => expect(wrapper.find('.result-panel').exists()).toBe(true))

    expect(wrapper.find('.no-abnormal').exists()).toBe(true)
    expect(wrapper.findAll('.result-list-item')).toHaveLength(0)
  })
})

describe('候诊栏健壮性', () => {
  it('队列里某位患者缺名字，不该让整个工作站白屏', async () => {
    // 渲染函数里一句 item.name.charAt(0) 就能做到这件事 ——
    // Vue 的渲染throw 不是局部失败，是整棵树不渲染。
    const wrapper = await render()
    const ws = useWorkstation()
    ws.queue = [{ id: 'P001', name: '王某某' }, { id: 'PX', dept: '内科' }] as never

    await wrapper.vm.$nextTick()
    expect(wrapper.find('.workstation-page').exists()).toBe(true)
    expect(wrapper.findAll('.sa-avatar')).toHaveLength(2)
  })
})
