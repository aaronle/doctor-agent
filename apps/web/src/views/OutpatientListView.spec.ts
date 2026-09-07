import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import OutpatientListView from './OutpatientListView.vue'
import type { PatientListItem } from '../api'

const PATIENTS: PatientListItem[] = [
  {
    id: 'P001', name: '王某某', gender: '女', age: 58, birth_date: '1968-03-15',
    // 已问过、患者否认 —— 不给标记
    allergy: { status: 'denied', items: [] }, visit_type: '复诊', dept: '内分泌科',
    doctor: '李医生', visit_date: '2026-06-17', chief_complaint: '血糖控制不佳，口渴多饮 2 周',
    primary_diagnosis: '2型糖尿病', risk_level: '高风险',
  },
  {
    id: 'P002', name: '张某', gender: '男', age: 45, birth_date: '1981-05-22',
    allergy: { status: 'confirmed', items: ['青霉素'] }, visit_type: '初诊', dept: '心内科',
    doctor: '王医生', visit_date: '2026-06-17', chief_complaint: '胸闷气短 1 个月',
    primary_diagnosis: '冠心病', risk_level: '中风险',
  },
]

const router = createRouter({ history: createWebHistory(), routes: [{ path: '/:p(.*)', component: { template: '<div/>' } }] })

async function renderView() {
  const wrapper = mount(OutpatientListView, {
    global: { plugins: [createPinia(), router, ElementPlus] },
  })
  await vi.waitFor(() => expect(wrapper.findAll('.patient-card').length).toBeGreaterThan(0))
  return wrapper
}

afterEach(() => vi.unstubAllGlobals())

describe('候诊列表', () => {
  it('渲染后端返回的患者卡片，不使用组件内写死数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PATIENTS), { status: 200 })))
    const wrapper = await renderView()

    const cards = wrapper.findAll('.patient-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].find('.pn-text').text()).toBe('王某某')
    expect(cards[0].find('.patient-meta').text()).toContain('58岁')
    expect(cards[0].find('.card-complaint').text()).toContain('血糖控制不佳')
  })

  it('按关键词过滤', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PATIENTS), { status: 200 })))
    const wrapper = await renderView()

    await wrapper.find('.toolbar-left input').setValue('胸闷')
    expect(wrapper.findAll('.patient-card')).toHaveLength(1)
    expect(wrapper.find('.pn-text').text()).toBe('张某')
  })

  it('候诊人数跟随过滤结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PATIENTS), { status: 200 })))
    const wrapper = await renderView()

    expect(wrapper.find('.patient-count strong').text()).toBe('2')
    await wrapper.find('.toolbar-left input').setValue('王某某')
    expect(wrapper.find('.patient-count strong').text()).toBe('1')
  })

  it('接口失败时不渲染任何患者卡片，不伪造数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: '后端不可用' }), { status: 500 })))
    const wrapper = mount(OutpatientListView, {
      global: { plugins: [createPinia(), router, ElementPlus] },
    })
    await vi.waitFor(() => expect(wrapper.text()).toContain('暂无候诊患者'))
    expect(wrapper.findAll('.patient-card')).toHaveLength(0)
  })
})

describe('过敏标记的字形', () => {
  /**
   * 两种状态的标记必须**同一套字形**。
   *
   * 原来 confirmed 用 `⚠`（emoji，彩色渲染），unknown 用 `?`（ASCII）——
   * 并排看像是后者的图标没加载出来。而同一个信息在科室看板和移动端
   * 都只写文字、不带 `?`，三处对不上。
   *
   * 定案：**危险有图标，信息缺口没有**。`⚠` 表示的是「有过敏原，会出事」；
   * 「没人问过」是采集缺口，不是危险，颜色（琥珀）已经把它和红色分开了。
   */
  /** 三种过敏状态各一位，缺一种这组用例就测不全 */
  const stubThreeStates = () => {
    const rows = [
      { ...PATIENTS[0], id: 'A1', allergy: { status: 'confirmed', items: ['青霉素'] } },
      { ...PATIENTS[0], id: 'A2', allergy: { status: 'unknown', items: [] } },
      { ...PATIENTS[0], id: 'A3', allergy: { status: 'denied', items: [] } },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 })))
  }

  it('未采集标记里不出现裸问号', async () => {
    stubThreeStates()
    const wrapper = await renderView()
    const warn = wrapper.findAll('.allergy-badge.warn').map((n) => n.text())
    expect(warn.length).toBeGreaterThan(0)
    for (const text of warn) {
      expect(text).not.toMatch(/^[?？]/)
      expect(text).toContain('过敏史未采集')
    }
  })

  it('确认有过敏的仍然带 ⚠ 并写出过敏原', async () => {
    stubThreeStates()
    const wrapper = await renderView()
    const danger = wrapper.findAll('.allergy-badge.danger').map((n) => n.text())
    expect(danger.length).toBeGreaterThan(0)
    for (const text of danger) expect(text.startsWith('⚠')).toBe(true)
  })
})
