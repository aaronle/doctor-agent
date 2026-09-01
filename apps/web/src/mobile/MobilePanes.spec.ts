import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'
import type { Component } from 'vue'

import MobileAnalysis from './MobileAnalysis.vue'
import MobileOutpatientList from './MobileOutpatientList.vue'
import MobilePatientManage from './MobilePatientManage.vue'
import MobileRecords from './MobileRecords.vue'
import { PATIENT, SUMMARY, UNLOCKED_VISIT, stubFetch, stubMatchMedia } from './testFixtures'
import { useWorkstation } from '../stores/workstation'

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:p(.*)', component: { template: '<div/>' } }],
})

function mountPane(component: Component, props: Record<string, unknown> = {}): VueWrapper {
  stubMatchMedia(true)
  stubFetch()
  const pinia = createPinia()
  const wrapper = mount(component, {
    props,
    global: { plugins: [pinia, router, ElementPlus] },
    attachTo: document.body,
  }) as unknown as VueWrapper
  const ws = useWorkstation(pinia)
  ws.patientId = 'P001'
  ws.patient = PATIENT as never
  ws.summary = SUMMARY as never
  // 多数用例测的是解锁后的呈现；锁定态另有专门的 describe
  ws.visit = UNLOCKED_VISIT as never
  ws.objective = { examinations: SUMMARY.examinations, timeline: SUMMARY.timeline } as never
  return wrapper
}

/** 展开某一折叠段 */
async function openSection(wrapper: VueWrapper, title: string) {
  const section = wrapper.find(`[data-sec="${title}"]`)
  if (!section.find('.m-sec-body').exists()) {
    await section.find('.m-sec-head').trigger('click')
  }
  return wrapper.find(`[data-sec="${title}"]`)
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('分析页', () => {
  it('八块 AI 产出全在，一块不少', async () => {
    const wrapper = mountPane(MobileAnalysis)
    await wrapper.vm.$nextTick()
    const titles = wrapper.findAll('.m-sec-title').map((t) => t.text())
    expect(titles).toEqual([
      '病情概要', '鉴别诊断', '预警评估', '共病管理', '专项评估', '阳性结果', '处置建议', '病历质控',
    ])
  })

  it('默认只展开病情概要，其余七块收着 —— 首屏是一张带条数的目录', async () => {
    const wrapper = mountPane(MobileAnalysis)
    await wrapper.vm.$nextTick()
    const bodies = wrapper.findAll('.m-sec-body')
    expect(bodies).toHaveLength(1)
    expect(wrapper.find('[data-sec="病情概要"]').find('.m-sec-body').exists()).toBe(true)
  })

  it('概要里的问题清单与疗效评估默认收着，展开才铺开', async () => {
    // 实测这两段合起来能有二十行，铺开的话后面七块要滚三屏才看得见
    const wrapper = mountPane(MobileAnalysis)
    await wrapper.vm.$nextTick()
    const section = wrapper.find('[data-sec="病情概要"]')
    expect(section.text()).not.toContain('血糖控制不佳')
    expect(section.text()).not.toContain('现方案控制不足')

    await section.findAll('.m-cbtn').find((b) => b.text().includes('问题清单'))!.trigger('click')
    expect(wrapper.find('[data-sec="病情概要"]').text()).toContain('血糖控制不佳')

    await wrapper.find('[data-sec="病情概要"]').findAll('.m-cbtn').find((b) => b.text() === '疗效评估')!.trigger('click')
    expect(wrapper.find('[data-sec="病情概要"]').text()).toContain('现方案控制不足')
  })

  it('角标显示各块条数', async () => {
    const wrapper = mountPane(MobileAnalysis)
    await wrapper.vm.$nextTick()
    const badge = (title: string) =>
      wrapper.find(`[data-sec="${title}"]`).find('.m-sec-badge').text()
    expect(badge('鉴别诊断')).toBe('2')
    expect(badge('预警评估')).toBe('1')
    expect(badge('共病管理')).toBe('1')
    expect(badge('阳性结果')).toBe('2')
  })

  it('鉴别诊断把 ICD 与置信度另起一行，不跟诊断名挤一行', async () => {
    const wrapper = mountPane(MobileAnalysis)
    await wrapper.vm.$nextTick()
    const section = await openSection(wrapper, '鉴别诊断')
    const item = section.findAll('.m-item')[0]
    expect(item.find('.m-row-strong').text()).toContain('2型糖尿病（血糖控制不佳）')
    expect(item.find('.m-row-sub').text()).toContain('E11.9')
    expect(item.find('.m-row-sub').text()).toContain('90%')
  })

  it('风险色点用后端给的颜色，不在前端另排一套映射', async () => {
    const wrapper = mountPane(MobileAnalysis)
    await wrapper.vm.$nextTick()
    const section = await openSection(wrapper, '预警评估')
    const dot = section.find('.m-dot')
    expect(dot.attributes('style')).toContain('rgb(245, 158, 11)')
  })

  it('阳性结果只列异常项，检查在前检验在后', async () => {
    const wrapper = mountPane(MobileAnalysis)
    await wrapper.vm.$nextTick()
    const section = await openSection(wrapper, '阳性结果')
    const items = section.findAll('.m-item')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('检查')
    expect(items[0].text()).toContain('双眼底照相')
    expect(items[1].text()).toContain('空腹血糖')
    // 血钾正常，不该进来
    expect(section.text()).not.toContain('血钾')
  })

  it('处置建议明说「开立请去工作站」，不给按钮', async () => {
    const wrapper = mountPane(MobileAnalysis)
    await wrapper.vm.$nextTick()
    const section = await openSection(wrapper, '处置建议')
    expect(section.text()).toContain('开立医嘱与检查请在门诊工作站完成')
    expect(section.findAll('button').filter((b) => b.text().includes('开立'))).toHaveLength(0)
  })

  it('专项评估与病历质控走接口，不在前端写死', async () => {
    const wrapper = mountPane(MobileAnalysis)
    // mountPane 内部会重新 stub fetch，所以要取挂载后生效的那一个
    const fetchMock = vi.mocked(globalThis.fetch)
    await wrapper.vm.$nextTick()
    await vi.waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes('assessment-catalog'))).toBe(true)
      expect(urls.some((u) => u.includes('record/quality'))).toBe(true)
    })
  })

  it('focus 传进来时把对应那块展开', async () => {
    const wrapper = mountPane(MobileAnalysis, { focus: '病历质控' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-sec="病历质控"]').find('.m-sec-body').exists()).toBe(true)
  })
})

describe('记录页', () => {
  it('五个分段齐全，默认落在病历', async () => {
    const wrapper = mountPane(MobileRecords)
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.m-seg-item').map((s) => s.text())).toEqual([
      '病历', '医嘱', '检查检验', '时间轴', '健康档案',
    ])
    expect(wrapper.find('.m-seg-item.active').text()).toBe('病历')
  })

  it('病历用纯文本呈现，不做成输入框', async () => {
    const wrapper = mountPane(MobileRecords)
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.m-field-value').length).toBeGreaterThan(0)
    expect(wrapper.findAll('textarea')).toHaveLength(0)
    expect(wrapper.findAll('input')).toHaveLength(0)
  })

  it('体征取患者主档拼成一行，不铺八个输入框', async () => {
    const wrapper = mountPane(MobileRecords)
    await wrapper.vm.$nextTick()
    const vitals = wrapper.findAll('.m-field-card').find((c) => c.text().includes('体征'))
    expect(vitals!.text()).toContain('BMI 26.1')
    expect(vitals!.text()).toContain('血压 142/88 mmHg')
  })

  it('血压已自带单位时不再拼一次 —— 种子里两种写法都有', async () => {
    const wrapper = mountPane(MobileRecords)
    const ws = useWorkstation()
    ws.patient = { ...PATIENT, vitals: { ...PATIENT.vitals, bp: '142/88 mmHg' } } as never
    await wrapper.vm.$nextTick()

    const vitals = wrapper.findAll('.m-field-card').find((c) => c.text().includes('体征'))
    expect(vitals!.text()).toContain('血压 142/88 mmHg')
    expect(vitals!.text()).not.toContain('mmHgmmHg')
  })

  it('「检查检验」段同时给已做的检查与检验', async () => {
    const wrapper = mountPane(MobileRecords, { segment: '检查检验' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('双眼底照相')
    expect(wrapper.text()).toContain('空腹血糖')
    // 正常项也要列出来 —— 这一段是完整记录，不是阳性结果
    expect(wrapper.text()).toContain('血钾')
  })

  it('时间轴显示本次就诊的真实动作', async () => {
    const wrapper = mountPane(MobileRecords, { segment: '时间轴' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('开始接诊')
    expect(wrapper.text()).toContain('2026-06-17 09:12')
  })

  it('健康档案给基本信息与既往就诊', async () => {
    const wrapper = mountPane(MobileRecords, { segment: '健康档案' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('青霉素')
    expect(wrapper.text()).toContain('2026-03-11')
  })
})

describe('候诊列表（移动端）', () => {
  const props = { patients: [PATIENT], loading: false, doctorName: '李医生', today: '2026/6/17' }

  it('按钮叫「接诊」不叫「进入工作站」 —— 点进去是只读对话页', async () => {
    stubMatchMedia(true)
    const wrapper = mount(MobileOutpatientList, {
      props, global: { plugins: [createPinia(), router, ElementPlus] },
    })
    const labels = wrapper.findAll('.m-btn.primary').map((b) => b.text())
    expect(labels).toContain('接诊')
    expect(wrapper.text()).not.toContain('进入工作站')
  })

  it('筛选收进抽屉，页头不被挤成三行', async () => {
    stubMatchMedia(true)
    const wrapper = mount(MobileOutpatientList, {
      props, global: { plugins: [createPinia(), router, ElementPlus] },
    })
    expect(wrapper.find('.m-sheet').exists()).toBe(false)
    await wrapper.findAll('.m-btn').find((b) => b.text().includes('筛选'))!.trigger('click')
    expect(wrapper.find('.m-sheet').exists()).toBe(true)
  })

  it('关键词过滤生效', async () => {
    stubMatchMedia(true)
    const wrapper = mount(MobileOutpatientList, {
      props: { ...props, patients: [PATIENT, { ...PATIENT, id: 'P002', name: '张某' }] },
      global: { plugins: [createPinia(), router, ElementPlus] },
    })
    expect(wrapper.findAll('.m-pcard')).toHaveLength(2)
    await wrapper.find('.m-search').setValue('张某')
    expect(wrapper.findAll('.m-pcard')).toHaveLength(1)
  })
})

describe('患者管理（移动端）', () => {
  const rows = [
    { ...PATIENT, in_queue: true, reminded: false },
    { ...PATIENT, id: 'P003', name: '赵某某', risk_level: '高风险', in_queue: false, reminded: true },
  ]

  function mountManage() {
    stubMatchMedia(true)
    return mount(MobilePatientManage, {
      props: { rows, loading: false },
      global: { plugins: [createPinia(), router, ElementPlus] },
    })
  }

  it('表格换成卡片 —— 九列在 390px 里够不着', () => {
    const wrapper = mountManage()
    expect(wrapper.findAll('table')).toHaveLength(0)
    expect(wrapper.findAll('.m-pcard')).toHaveLength(2)
  })

  it('四张统计卡按 2 列排', () => {
    const wrapper = mountManage()
    const stats = wrapper.findAll('.m-stat')
    expect(stats.map((s) => s.find('.m-stat-label').text())).toEqual(['在管患者', '今日候诊', '高风险', '已提醒'])
  })

  it('提醒与重新接诊保留 —— 它们写的是本系统状态，不落 HIS/EMR', async () => {
    const wrapper = mountManage()
    const done = wrapper.findAll('.m-pcard')[1]
    expect(done.text()).toContain('已完成')

    await done.findAll('.m-btn.link').find((b) => b.text() === '提醒')!.trigger('click')
    expect(wrapper.emitted('remind')?.[0]).toEqual([['P003']])

    await done.findAll('.m-btn.link').find((b) => b.text() === '重新接诊')!.trigger('click')
    expect(wrapper.emitted('requeue')?.[0]).toEqual(['P003'])
  })

  it('候诊中的患者不给「重新接诊」——它是给已出队的退路', () => {
    const wrapper = mountManage()
    const waiting = wrapper.findAll('.m-pcard')[0]
    expect(waiting.findAll('.m-btn.link').map((b) => b.text())).not.toContain('重新接诊')
  })

  it('高风险未提醒时给一键提醒', async () => {
    const wrapper = mountManage()
    await wrapper.find('.m-alert .m-btn.primary').trigger('click')
    expect(wrapper.emitted('remind')?.[0]).toEqual([['P001']])
  })
})
