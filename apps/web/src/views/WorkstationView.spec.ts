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

describe('医嘱三子页', () => {
  it('角标计数：药品来自医嘱、检查来自检查记录、检验来自检验结果', async () => {
    const wrapper = await render()
    const badges = wrapper.findAll('.ostab-badge').map((b) => b.text())
    // PATIENT 有 0 条药品医嘱、SUMMARY 有 1 条检查、3 条检验
    expect(badges).toEqual(['0', '1', '3'])
  })

  it('「检查」页显示患者已做的检查，不是只显示新开的医嘱', async () => {
    // 早先这一页的数据源接成了「category === exam 的医嘱」，
    // 而种子医嘱都没有 category —— 于是患者明明做过心电图、眼底照相，
    // 这一页却永远是空的。
    const wrapper = await render()
    await wrapper.findAll('.ostab')[1].trigger('click')

    // 断言落在表格里，不是整页文本 —— 项目名在别处也出现，整页断言测不出东西
    const rows = wrapper.findAll('.el-table__body .cell').map((c) => c.text())
    expect(rows).toContain('双眼底照相')
    expect(rows).toContain('异常: NPDR 轻度')
  })

  it('「检查」页的列头按原件：检查项目 / 类型 / 日期 / 结论', async () => {
    const wrapper = await render()
    await wrapper.findAll('.ostab')[1].trigger('click')
    const heads = wrapper.findAll('.el-table__header th .cell').map((h) => h.text())
    expect(heads).toEqual(['检查项目', '类型', '日期', '结论'])
  })

  it('「检验」页首列是「指标名称」，与原件一致', async () => {
    const wrapper = await render()
    await wrapper.findAll('.ostab')[2].trigger('click')
    const heads = wrapper.findAll('.el-table__header th .cell').map((h) => h.text())
    expect(heads).toEqual(['指标名称', '结果', '参考', '趋势'])
  })

  it('新开的检查也进这一页，标为待出结果', async () => {
    const wrapper = await render()
    const ws = useWorkstation()
    ws.patient = {
      ...PATIENT,
      orders: [{ id: 'E001', name: '胸部CT', category: 'exam', exam_type: '检查', status: '新开' }],
    } as never
    await wrapper.vm.$nextTick()
    await wrapper.findAll('.ostab')[1].trigger('click')

    const rows = wrapper.findAll('.el-table__body .cell').map((c) => c.text())
    expect(rows).toContain('胸部CT')
    expect(rows).toContain('待出结果')
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
