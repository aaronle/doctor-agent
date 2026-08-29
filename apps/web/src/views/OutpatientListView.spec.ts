import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import OutpatientListView from './OutpatientListView.vue'
import type { PatientListItem } from '../api'

const PATIENTS: PatientListItem[] = [
  {
    id: 'P001', name: '王某某', gender: '女', age: 58, visit_type: '复诊', dept: '内分泌科',
    doctor: '李医生', visit_date: '2026-06-17', chief_complaint: '血糖控制不佳，口渴多饮 2 周',
    primary_diagnosis: '2型糖尿病', risk_level: '高风险',
  },
  {
    id: 'P002', name: '张某', gender: '男', age: 45, visit_type: '初诊', dept: '心内科',
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
    expect(cards[0].find('.patient-name').text()).toBe('王某某')
    expect(cards[0].find('.patient-meta').text()).toContain('58岁')
    expect(cards[0].find('.card-complaint').text()).toContain('血糖控制不佳')
  })

  it('按关键词过滤', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PATIENTS), { status: 200 })))
    const wrapper = await renderView()

    await wrapper.find('.toolbar-left input').setValue('胸闷')
    expect(wrapper.findAll('.patient-card')).toHaveLength(1)
    expect(wrapper.find('.patient-name').text()).toBe('张某')
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
