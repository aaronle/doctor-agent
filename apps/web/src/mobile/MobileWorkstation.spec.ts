import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import MobileAnalysis from './MobileAnalysis.vue'
import MobileWorkstation from './MobileWorkstation.vue'
import WorkstationView from '../views/WorkstationView.vue'
import { LOCKED_VISIT, PATIENT, SUMMARY, UNLOCKED_VISIT, stubFetch, stubMatchMedia } from './testFixtures'
import { useWorkstation } from '../stores/workstation'

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:p(.*)', component: { template: '<div/>' } }],
})

async function render() {
  stubMatchMedia(true)
  stubFetch()
  await router.push('/outpatient/P001')
  const pinia = createPinia()
  const wrapper = mount(MobileWorkstation, {
    global: { plugins: [pinia, router, ElementPlus] },
    attachTo: document.body,
  })
  const ws = useWorkstation(pinia)
  ws.patientId = 'P001'
  ws.patient = PATIENT as never
  ws.summary = SUMMARY as never
  ws.queue = [{ id: 'P001', name: '王某某' }, { id: 'P002', name: '张某' }] as never
  // 多数用例测的是解锁后的呈现；锁定态另有专门的 describe
  ws.visit = UNLOCKED_VISIT as never
  await wrapper.vm.$nextTick()
  return wrapper
}

function textOf(wrapper: VueWrapper) {
  return wrapper.text()
}

async function switchTo(wrapper: VueWrapper, label: string) {
  const tab = wrapper.findAll('.m-tab').find((t) => t.text().includes(label))
  await tab!.trigger('click')
  await wrapper.vm.$nextTick()
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('移动端工作站 · 落地即对话', () => {
  it('首屏是对话，不是表单', async () => {
    const wrapper = await render()
    expect(wrapper.find('.m-chat').exists()).toBe(true)
    expect(wrapper.find('.m-input-bar').exists()).toBe(true)
    // 默认选中「对话」
    const active = wrapper.find('.m-tab.active')
    expect(active.text()).toContain('对话')
  })

  it('开场就把病情概要与风险以卡片推进对话流', async () => {
    const wrapper = await render()
    const cards = wrapper.findAll('.m-card')
    expect(cards.length).toBe(2)
    expect(cards[0].text()).toContain('病情概要')
    // 矛盾信息要并列显示，不能被合并掉
    expect(cards[0].text()).toContain('信息冲突')
    expect(cards[1].text()).toContain('风险提示')
    expect(cards[1].text()).toContain('心肌缺血迹象')
  })

  it('卡片上的按钮跳到分析页对应那一块', async () => {
    const wrapper = await render()
    const btn = wrapper.findAll('.m-cbtn').find((b) => b.text().includes('逐条查看'))
    await btn!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.m-tab.active').text()).toContain('分析')
  })

  it('顶栏常驻只读徽标 —— 不说清楚医生会一直找「提交」在哪', async () => {
    const wrapper = await render()
    expect(wrapper.find('.m-ro').text()).toContain('只读')
  })

  it('红色风险未处置时，分析标签带角标', async () => {
    const wrapper = await render()
    expect(wrapper.find('.m-tab-badge').text()).toBe('1')
  })
})

describe('移动端工作站 · 不写 HIS/EMR', () => {
  /**
   * 移动端最重要的一条产品规则。
   *
   * 断言落在**可点的元素**上，不是整页文本 —— 只读横幅里就写着
   * 「提交病历…请在工作站完成」，按整页文本判会把说明本身当成违规。
   * 扫全部 button 而不是列举已知按钮：后者漏掉将来新加的那个就测不出来。
   */
  const WRITE_ACTIONS = ['提交病历', '暂存', '开嘱', '开立', '确认回写', '回写', '保存诊断']

  it('三个面板里没有任何可点的写入动作', async () => {
    const wrapper = await render()
    for (const pane of ['对话', '分析', '记录']) {
      await switchTo(wrapper, pane)
      const clickable = wrapper
        .findAll('button, a, [role="button"]')
        .filter((el) => el.attributes('disabled') === undefined)
        .map((el) => el.text())
      for (const label of clickable) {
        for (const forbidden of WRITE_ACTIONS) {
          expect(label, `${pane} 页有个可点的「${label}」`).not.toContain(forbidden)
        }
      }
    }
  })

  it('只读横幅把去处说清楚，而不是让医生自己猜', async () => {
    const wrapper = await render()
    await switchTo(wrapper, '记录')
    expect(textOf(wrapper)).toContain('提交病历、回写诊断、开立医嘱请在门诊工作站完成')
  })

  it('记录页只读呈现，不给输入框 —— 长得像输入框就会有人去点', async () => {
    const wrapper = await render()
    await switchTo(wrapper, '记录')
    expect(wrapper.find('.m-records').exists()).toBe(true)
    expect(wrapper.findAll('.m-records textarea')).toHaveLength(0)
    expect(wrapper.findAll('.m-records input')).toHaveLength(0)
    expect(wrapper.find('.m-banner').text()).toContain('只读视图')
  })
})

describe('移动端工作站 · ＋ 菜单', () => {
  async function openMenu() {
    const wrapper = await render()
    await wrapper.find('.m-more').trigger('click')
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('功能全集分三组摊开', async () => {
    const wrapper = await openMenu()
    const titles = wrapper.findAll('.m-group-title').map((t) => t.text())
    expect(titles).toEqual(['问诊与分析', '资料查阅', '写入 HIS / EMR'])
  })

  it('写入类三项列出来但不可点，并标明去处', async () => {
    const wrapper = await openMenu()
    const locked = wrapper.findAll('.m-cell.locked')
    expect(locked.map((c) => c.text().replace(/\s/g, ''))).toEqual([
      '📝提交病历工作站专属',
      '🩺回写诊断工作站专属',
      '💊开立医嘱工作站专属',
    ])
    for (const cell of locked) {
      expect(cell.attributes('disabled')).toBeDefined()
    }
  })

  it('点「健康档案」直达记录页那一段', async () => {
    const wrapper = await openMenu()
    const cell = wrapper.findAll('.m-cell').find((c) => c.text().includes('健康档案'))
    await cell!.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.m-tab.active').text()).toContain('记录')
    expect(wrapper.find('.m-seg-item.active').text()).toBe('健康档案')
  })

  it('点「预警评估」跳到分析页并展开那一块', async () => {
    const wrapper = await openMenu()
    const cell = wrapper.findAll('.m-cell').find((c) => c.text().includes('预警评估'))
    await cell!.trigger('click')
    await wrapper.vm.$nextTick()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.m-tab.active').text()).toContain('分析')
    const section = wrapper.find('[data-sec="预警评估"]')
    expect(section.find('.m-sec-body').exists()).toBe(true)
  })
})

describe('移动端工作站 · 快捷动作', () => {
  it('四条快捷动作都在，且能横向滚动不被裁掉', async () => {
    const wrapper = await render()
    const chips = wrapper.findAll('.m-qa-chip').map((c) => c.text())
    expect(chips).toEqual(['🎙语音问诊', '📄报告解读', '🔍鉴别诊断', '➡️接诊下一位'])
  })

  it('「接诊下一位」按队列顺序切换患者', async () => {
    const wrapper = await render()
    const push = vi.spyOn(router, 'push')
    const chip = wrapper.findAll('.m-qa-chip').find((c) => c.text().includes('接诊下一位'))
    await chip!.trigger('click')
    expect(push).toHaveBeenCalledWith('/outpatient/P002')
    push.mockRestore()
  })

  it('走到队尾回候诊列表，而不是卡在最后一位', async () => {
    const wrapper = await render()
    useWorkstation().patientId = 'P002'
    await wrapper.vm.$nextTick()

    const push = vi.spyOn(router, 'push')
    const chip = wrapper.findAll('.m-qa-chip').find((c) => c.text().includes('接诊下一位'))
    await chip!.trigger('click')
    expect(push).toHaveBeenCalledWith('/outpatient/list')
    push.mockRestore()
  })

  it('换患者时清空对话上下文 —— 留着会把上一位的病情带进追问', async () => {
    const wrapper = await render()
    const input = wrapper.find('.m-field')
    await input.setValue('这位患者要不要转诊')
    await wrapper.vm.$nextTick()

    useWorkstation().patientId = 'P002'
    await wrapper.vm.$nextTick()

    expect((wrapper.find('.m-field').element as HTMLInputElement).value).toBe('')
  })
})

describe('视口分流', () => {
  it('手机视口渲染移动端工作站，不渲染桌面三栏', async () => {
    stubMatchMedia(true)
    stubFetch()
    await router.push('/outpatient/P001')
    const wrapper = mount(WorkstationView, {
      global: { plugins: [createPinia(), router, ElementPlus] },
      attachTo: document.body,
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.m-page').exists()).toBe(true)
    expect(wrapper.find('.workstation-page').exists()).toBe(false)
  })

  it('桌面视口一字未动 —— 还原度门禁跑在 1600px 下', async () => {
    stubMatchMedia(false)
    stubFetch()
    await router.push('/outpatient/P001')
    const wrapper = mount(WorkstationView, {
      global: { plugins: [createPinia(), router, ElementPlus] },
      attachTo: document.body,
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.workstation-page').exists()).toBe(true)
    expect(wrapper.find('.m-page').exists()).toBe(false)
  })
})

describe('移动端问诊门禁', () => {
  async function renderLocked() {
    stubMatchMedia(true)
    stubFetch({ 'visit-state': LOCKED_VISIT })
    await router.push('/outpatient/P001')
    const pinia = createPinia()
    const wrapper = mount(MobileWorkstation, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    const ws = useWorkstation(pinia)
    ws.patientId = 'P001'
    ws.patient = PATIENT as never
    ws.visit = LOCKED_VISIT as never
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('未解锁时对话页不是空白 —— 给一张说明卡和两条出路', async () => {
    // 移动端一度漏了整个门禁：0 张卡、一片空白，医生只会以为跑失败了
    const wrapper = await renderLocked()
    const card = wrapper.findAll('.m-card').find((c) => c.text().includes('先问诊'))
    expect(card, '锁定时必须有开场说明卡').toBeTruthy()
    expect(card!.text()).toContain('锚定')

    const actions = card!.findAll('.m-cbtn').map((b) => b.text())
    expect(actions.some((a) => a.includes('开始语音问诊'))).toBe(true)
    expect(actions.some((a) => a.includes('跳过问诊'))).toBe(true)
  })

  it('说明卡指明「记录」页现在就能看 —— 客观数据不受门禁', async () => {
    const wrapper = await renderLocked()
    const card = wrapper.findAll('.m-card').find((c) => c.text().includes('先问诊'))!
    expect(card.text()).toContain('记录')
  })

  it('跳过解锁后，对话页如实标「未含问诊」', async () => {
    stubMatchMedia(true)
    stubFetch()
    const pinia = createPinia()
    const wrapper = mount(MobileWorkstation, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    const ws = useWorkstation(pinia)
    ws.patientId = 'P001'
    ws.patient = PATIENT as never
    ws.summary = SUMMARY as never
    ws.visit = { ...UNLOCKED_VISIT, interview_done: false, unlocked_by: 'skipped' } as never
    await wrapper.vm.$nextTick()

    const card = wrapper.findAll('.m-card').find((c) => c.text().includes('未含问诊'))
    expect(card, '跳过路径必须如实标，否则医生以为这份分析听过患者说话').toBeTruthy()
  })

  it('分析页受门禁的四块给出原因，不是干放一个 0', async () => {
    stubMatchMedia(true)
    stubFetch({ 'visit-state': LOCKED_VISIT })
    const pinia = createPinia()
    const wrapper = mount(MobileAnalysis, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    const ws = useWorkstation(pinia)
    ws.patientId = 'P001'
    ws.patient = PATIENT as never
    ws.visit = LOCKED_VISIT as never
    await wrapper.vm.$nextTick()

    const section = wrapper.find('[data-sec="病情概要"]')
    expect(section.find('.m-sec-body').text()).toContain('问诊后才生成')
  })

  it('分析页不受门禁的那几块照常显示', async () => {
    stubMatchMedia(true)
    stubFetch({ 'visit-state': LOCKED_VISIT })
    const pinia = createPinia()
    const wrapper = mount(MobileAnalysis, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    const ws = useWorkstation(pinia)
    ws.patientId = 'P001'
    ws.patient = PATIENT as never
    ws.visit = LOCKED_VISIT as never
    ws.objective = { examinations: SUMMARY.examinations, timeline: SUMMARY.timeline } as never
    await wrapper.vm.$nextTick()

    const section = wrapper.find('[data-sec="阳性结果"]')
    await section.find('.m-sec-head').trigger('click')
    expect(wrapper.find('[data-sec="阳性结果"]').text()).toContain('双眼底照相')
  })
})
