import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import PreVisitCard from './PreVisitCard.vue'

/**
 * 医生端看到的「患者候诊时填的」。
 *
 * 这张卡要同时说清三件事：**填了什么**、**什么时候填的**、
 * **哪一项还需要医生确认**。少了第三件，患者那次采集就等于白做 ——
 * 因为它按设计不会自动改档案（患者自报不等于医生问过）。
 */

const ANSWERS = {
  patient_id: 'P009',
  source: 'patient',
  submitted_at: '2026-06-22T00:14:00+00:00',
  needs_confirmation: true,
  answers: {
    chief_complaint: { choices: ['阴道出血'], text: '' },
    duration: { choice: '1–4 周' },
    allergy: { choice: '有', text: '青霉素' },
    lmp: { date: '2026-05-28' },
    obstetric: { pair: ['1', '1'] },
  },
}

function stub(body: unknown = ANSWERS) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })))
}
const render = async () => {
  const w = mount(PreVisitCard, { props: { patientId: 'P009' } })
  await vi.waitFor(() => expect(w.text()).not.toContain('读取中'))
  return w
}

afterEach(() => vi.unstubAllGlobals())

describe('预问诊卡片', () => {
  it('把答案翻译成医生看得懂的说法', async () => {
    // 患者端问的是「上一次月经是哪天开始的」，医生端要显示成「末次月经」——
    // 同一件事，两边各说各的行话，中间由这张卡翻译
    stub(); const w = await render()
    expect(w.text()).toContain('末次月经')
    expect(w.text()).toContain('2026-05-28')
    expect(w.text()).toContain('孕 1 产 1')
  })

  it('**过敏项标「待确认」** —— 它按设计不会自动改档案', async () => {
    stub(); const w = await render()
    const allergy = w.find('.pvc-row.needs-confirm')
    expect(allergy.exists()).toBe(true)
    expect(allergy.text()).toContain('青霉素')
    expect(allergy.text()).toContain('待确认')
  })

  it('写明是患者自己填的，以及什么时候填的', async () => {
    stub(); const w = await render()
    expect(w.text()).toContain('患者自填')
    expect(w.find('.pvc-time').text()).toBeTruthy()
  })

  it('没填过时整张卡不渲染 —— 空壳只会占地方', async () => {
    stub({ patient_id: 'P009', source: '', answers: {}, submitted_at: '', needs_confirmation: false })
    const w = await render()
    expect(w.find('.pvc').exists()).toBe(false)
  })

  it('未作答的题不显示 —— 列一堆「—」会让人以为患者敷衍了事', async () => {
    /*
     * **数据里必须真的有空答案**，否则这条用例是空过的：
     * 第一版只喂了一条已答的题，过滤器无事可做，
     * 把整个 `.filter()` 删掉照样绿。变异验证当场抓出来。
     */
    stub({
      ...ANSWERS,
      answers: {
        duration: { choice: '今天' },
        lmp: {},                       // 跳过没填
        cycle_regular: { choice: '' }, // 点了又取消
        obstetric: { pair: ['', ''] }, // 两格都空
      },
    })
    const w = await render()
    expect(w.findAll('.pvc-row')).toHaveLength(1)
    expect(w.text()).not.toContain('末次月经')
  })
})
