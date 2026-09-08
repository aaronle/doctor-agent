import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import MobilePreVisit from './MobilePreVisit.vue'
import { stubMatchMedia } from './testFixtures'

/**
 * 预问诊（患者端）。
 *
 * 这一条路上**只有患者自己的信息**：没有诊断、没有检验、没有风险。
 * 测试盯的是三件事 —— 登录两项都要、题目按科室来、以及
 * 「患者自报的过敏史要标成待医生确认」。
 */

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:p(.*)', component: { template: '<div/>' } }],
})

const QUESTIONS = {
  patient_id: 'P009',
  dept_name: '妇科',
  common: [
    { key: 'chief_complaint', label: '这次主要哪里不舒服？', type: 'multi_text', options: ['肚子疼', '其他'] },
    { key: 'allergy', label: '有没有对药物过敏？', type: 'single_text', options: ['有', '没有', '不确定'], text_when: '有',
      notice: '你填的会给医生参考，但医生还会再问一次并确认后才写进病历。' },
  ],
  dept: [
    { key: 'lmp', label: '上一次月经是哪天开始的？', hint: '医生问的「末次月经」就是这个。', type: 'date', options: ['记不清了'] },
  ],
}

function stubFetch(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if (u.includes('/api/previsit/login')) {
      if (overrides.loginFails) return json({ detail: '病人号与姓名对不上，请核对挂号单' }, 404)
      return json({ patient_id: 'P009', name: '郑某某', dept: '妇科', visit_date: '2026-06-22', submitted: false })
    }
    if (u.includes('/api/previsit/questions')) return json(QUESTIONS)
    if (u.includes('/api/previsit/answers') && init?.method === 'POST') {
      ;(overrides.posted as unknown[])?.push(JSON.parse(String(init.body)))
      return json({ ok: true, count: 3 })
    }
    return json({})
  }))
}

async function render() {
  stubMatchMedia(true)
  const wrapper = mount(MobilePreVisit, {
    global: { plugins: [createPinia(), router, ElementPlus] },
    attachTo: document.body,
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

async function login(wrapper: VueWrapper) {
  await wrapper.findAll('.pv-input')[0].setValue('P009')
  await wrapper.findAll('.pv-input')[1].setValue('郑某某')
  await wrapper.find('.pv-primary').trigger('click')
  await vi.waitFor(() => expect(wrapper.find('.pv-question').exists()).toBe(true))
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('预问诊 · 登录', () => {
  it('两项都填了才让下一步', async () => {
    stubFetch(); const wrapper = await render()
    expect(wrapper.find('.pv-primary').attributes('disabled')).toBeDefined()
    await wrapper.findAll('.pv-input')[0].setValue('P009')
    expect(wrapper.find('.pv-primary').attributes('disabled')).toBeDefined()
    await wrapper.findAll('.pv-input')[1].setValue('郑某某')
    expect(wrapper.find('.pv-primary').attributes('disabled')).toBeUndefined()
  })

  it('**对不上时不说是哪一项错了** —— 原样转述服务端那一句', async () => {
    stubFetch({ loginFails: true }); const wrapper = await render()
    await wrapper.findAll('.pv-input')[0].setValue('P009')
    await wrapper.findAll('.pv-input')[1].setValue('王某某')
    await wrapper.find('.pv-primary').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.pv-error').exists()).toBe(true))
    const msg = wrapper.find('.pv-error').text()
    expect(msg).toContain('对不上')
    for (const leak of ['姓名错误', '患者不存在', '无此患者']) expect(msg).not.toContain(leak)
  })
})

describe('预问诊 · 问题', () => {
  it('通用题与专科题都渲染，并标出这是哪个科室的', async () => {
    stubFetch(); const wrapper = await render(); await login(wrapper)
    expect(wrapper.findAll('.pv-question')).toHaveLength(3)
    expect(wrapper.text()).toContain('妇科')
  })

  it('提示语原样显示 —— 「医生问的末次月经就是这个」是给患者的翻译', async () => {
    stubFetch(); const wrapper = await render(); await login(wrapper)
    expect(wrapper.text()).toContain('医生问的「末次月经」就是这个')
  })

  it('过敏题选「有」才出输入框 —— 选「没有」还留个框会让人以为必须填点什么', async () => {
    stubFetch(); const wrapper = await render(); await login(wrapper)
    const q = wrapper.findAll('.pv-question')[1]
    expect(q.find('.pv-followup').exists()).toBe(false)
    await q.findAll('.pv-chip')[0].trigger('click')   // 「有」
    expect(q.find('.pv-followup').exists()).toBe(true)
    await q.findAll('.pv-chip')[1].trigger('click')   // 「没有」
    expect(q.find('.pv-followup').exists()).toBe(false)
  })

  it('**过敏题必须显示「医生还会再问一次」** —— 不说清楚，患者会以为填了就算数', async () => {
    stubFetch(); const wrapper = await render(); await login(wrapper)
    expect(wrapper.text()).toContain('医生还会再问一次')
  })
})

describe('预问诊 · 这条路上不该有的东西', () => {
  it('整屏没有任何临床字眼', async () => {
    // 患者端只填自己的情况。诊断、检验、风险出现在这里就是越界
    stubFetch(); const wrapper = await render(); await login(wrapper)
    const text = wrapper.text()
    for (const word of ['鉴别诊断', '危急值', '高风险', '化验', '检验结果', '血红蛋白', 'ICD']) {
      expect(text).not.toContain(word)
    }
  })

  it('提交时带上姓名 —— 只带病人号就能替别人填', async () => {
    const posted: unknown[] = []
    stubFetch({ posted }); const wrapper = await render(); await login(wrapper)
    await wrapper.findAll('.pv-question')[1].findAll('.pv-chip')[1].trigger('click')
    await wrapper.find('.pv-submit').trigger('click')
    await vi.waitFor(() => expect(posted.length).toBe(1))
    expect((posted[0] as { name: string }).name).toBe('郑某某')
  })
})
