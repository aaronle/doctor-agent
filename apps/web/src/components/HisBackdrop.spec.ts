import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import HisBackdrop from './HisBackdrop.vue'

const PATIENT = {
  id: 'P002', name: '张某', gender: '男', age: 45, birth_date: '1981-05-22',
  allergy: { status: 'confirmed' as const, items: ['青霉素'] },
  visit_type: '复诊', dept: '心内科', doctor: '王医生', visit_date: '2026-06-17',
  chief_complaint: '胸闷气短', primary_diagnosis: '冠心病', risk_level: '中风险',
  id_no: '', phone: '139****8002', is_return_visit: true,
  pre_consultation_done: true, nutrition_screening_score: 0,
} as never

const render = () => mount(HisBackdrop, { props: { patient: PATIENT } })

describe('HIS 门面', () => {
  it('「界面仿真 · 不可操作」标识必须在，且不在会被浮窗遮住的右侧', () => {
    // 这条是防误解的第二道保险（第一道是页头的「未接入任何院内 HIS」）。
    // 它一度挂在患者栏右下角 —— 那个位置正好被医生智能体浮窗盖住，
    // 而这条标识存在的全部意义就是被看见。
    const w = render()
    const badge = w.find('.hb-sim-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('仿真')
    // 在工具栏里（左侧），不是绝对定位到角落
    expect(w.find('.hb-toolbar .hb-sim-badge').exists()).toBe(true)
  })

  it('一个可编辑控件都没有 —— 这层是道具，不是能录入的系统', () => {
    // 用真的 input 会让人以为能录入，一敲字发现存不进去，比没有这层更糟。
    const w = render()
    expect(w.findAll('input')).toHaveLength(0)
    expect(w.findAll('textarea')).toHaveLength(0)
    expect(w.findAll('select')).toHaveLength(0)
  })

  it('医嘱分类页签切换会过滤表格', async () => {
    const w = render()
    const all = w.findAll('.hb-tbl.orders tbody tr').length
    expect(all).toBeGreaterThan(1)

    await w.findAll('.hb-tab').find((t) => t.text().startsWith('检验'))!.trigger('click')
    const filtered = w.findAll('.hb-tbl.orders tbody tr')
    expect(filtered.length).toBeLessThan(all)
    filtered.forEach((r) => expect(r.text()).toContain('检验'))
  })

  it('空分类给一句话，不是一张空白表', async () => {
    const w = render()
    await w.findAll('.hb-tab').find((t) => t.text().startsWith('其他'))!.trigger('click')
    expect(w.find('.hb-empty').text()).toContain('暂无医嘱')
  })

  it('医嘱按科室给对得上的内容 —— 心内科病人不该开眼科的药', () => {
    const text = render().find('.hb-tbl.orders').text()
    expect(text).toContain('阿司匹林')
    expect(text).toContain('心电图')
    expect(text).not.toContain('眼科')
  })

  it('患者信息取自真实档案，不是写死的假数据', () => {
    const t = render().text()
    expect(t).toContain('张某')
    expect(t).toContain('1981-05-22')
    expect(t).toContain('青霉素')
  })
})
