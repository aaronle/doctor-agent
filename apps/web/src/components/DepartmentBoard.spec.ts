import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DepartmentBoard from './DepartmentBoard.vue'

/**
 * 科室看板：诊疗进度 × 风险。
 *
 * 产品定义要求区分**三样**：看过的、没看过的、**做完检查但报告没回的**；
 * 以及**有风险的**与**没风险的普通病人**。
 */

const BOARD = {
  total: 4, done: 1, pending_report: 1, needs_attention: 2,
  rows: [
    { patient_id: 'P008', name: '孙某某', age: 68, gender: '女', dept: '骨科',
      chief_complaint: '双膝疼痛', progress: 'not_started', pending_exams: 0, in_queue: true,
      risk_tier: 'critical', open_red: 1, open_warn: 4, red_names: ['过敏冲突'],
      allergy_status: 'confirmed', allergies: ['头孢'] },
    { patient_id: 'P005', name: '刘某某', age: 52, gender: '女', dept: '内分泌科',
      chief_complaint: '血糖控制不佳', progress: 'pending_report', pending_exams: 2, in_queue: true,
      risk_tier: 'warning', open_red: 0, open_warn: 1, red_names: [],
      allergy_status: 'unknown', allergies: [] },
    { patient_id: 'P003', name: '李某某', age: 32, gender: '女', dept: '内分泌科',
      chief_complaint: '甲亢复诊', progress: 'interviewed', pending_exams: 0, in_queue: true,
      risk_tier: 'ordinary', open_red: 0, open_warn: 0, red_names: [],
      allergy_status: 'denied', allergies: [] },
    { patient_id: 'P006', name: '赵某某', age: 72, gender: '男', dept: '神经内科',
      chief_complaint: '右侧肢体无力', progress: 'done', pending_exams: 0, in_queue: false,
      risk_tier: 'ordinary', open_red: 0, open_warn: 0, red_names: [],
      allergy_status: 'denied', allergies: [] },
  ],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(BOARD), { status: 200 })))
})

async function board() {
  const w = mount(DepartmentBoard)
  await vi.waitFor(() => expect(w.findAll('.db-table tbody tr').length).toBeGreaterThan(0))
  return w
}

describe('科室看板 · 诊疗进度', () => {
  it('**「待报告」独立成一档**，既不是没看过也不是已完成', async () => {
    // 医生已经开了单、做了判断，但结论还下不了。合并进任何一边，
    // 就看不出「这个人还欠我一个报告」。
    const w = await board()
    const cell = w.findAll('.db-progress').find((s) => s.text() === '待报告')
    expect(cell).toBeTruthy()
    expect(cell!.classes()).toContain('pending_report')
    expect(w.text()).toContain('2 项未回')
  })

  it('四种进度都有对应文案，不出现裸的英文枚举', async () => {
    const w = await board()
    const texts = w.findAll('.db-progress').map((s) => s.text())
    expect(texts).toEqual(expect.arrayContaining(['未接诊', '待报告', '已问诊', '已完成']))
    expect(texts.join('')).not.toMatch(/not_started|pending_report|interviewed|done/)
  })

  it('**已完成的也要在** —— 关键词是「回顾」，只看队列就回顾不了今天', async () => {
    const w = await board()
    expect(w.text()).toContain('赵某某')
  })
})

describe('科室看板 · 风险', () => {
  it('普通病人**明确标成「普通」**，不是留空', async () => {
    // 只标危险的，医生仍要逐个确认「这个是真没事还是我漏看了」
    const w = await board()
    expect(w.findAll('.db-tier.ordinary').length).toBe(2)
    expect(w.findAll('.db-tier.ordinary')[0].text()).toBe('普通')
  })

  it('危急的点出是哪一条，不只给一个色块', async () => {
    const w = await board()
    expect(w.find('.db-red').text()).toContain('过敏冲突')
  })

  it('过敏三态：确认给红标带过敏原、未采集给黄标、否认不给标', async () => {
    const w = await board()
    const badges = w.findAll('.db-allergy')
    expect(badges[0].text()).toContain('头孢')
    expect(badges[1].classes()).toContain('unknown')
    expect(badges).toHaveLength(2)          // 两位 denied 的不给标
  })
})

describe('科室看板 · 「该我处理」', () => {
  it('这个数排第一且最大 —— 医生第一眼看的就是它', async () => {
    const w = await board()
    const first = w.findAll('.db-stat')[0]
    expect(first.classes()).toContain('attention')
    expect(first.text()).toContain('2')
  })

  it('点它只看该处理的：已完成的和普通的都收起来', async () => {
    const w = await board()
    await w.find('.db-stat.attention').trigger('click')

    const names = w.findAll('.db-who b').map((b) => b.text())
    expect(names).toEqual(['孙某某', '刘某某'])
  })

  it('筛完一个不剩时说人话，不是空表', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ...BOARD, needs_attention: 0, rows: [BOARD.rows[3]] }), { status: 200 })))
    const w = await board()
    await w.find('.db-stat.attention').trigger('click')

    expect(w.find('.db-empty').text()).toContain('红线都闭环了')
  })
})

describe('科室看板 · 接诊', () => {
  it('点「接诊」把患者 id 抛出去', async () => {
    const w = await board()
    await w.findAll('.db-open')[0].trigger('click')
    expect(w.emitted('open')?.[0]).toEqual(['P008'])
  })
})
