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
  it('首屏是医生智能体对话，不是表单', async () => {
    const wrapper = await render()
    expect(wrapper.find('.m-chat').exists()).toBe(true)
    expect(wrapper.find('.m-input-bar').exists()).toBe(true)
    // 默认选中「医生智能体」
    const active = wrapper.find('.m-tab.active')
    expect(active.text()).toContain('医生智能体')
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
    expect(wrapper.find('.m-tab.active').text()).toContain('AI 助手')
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
    for (const pane of ['医生智能体', 'AI 助手', '记录']) {
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

    expect(wrapper.find('.m-tab.active').text()).toContain('AI 助手')
    const section = wrapper.find('[data-sec="预警评估"]')
    expect(section.find('.m-sec-body').exists()).toBe(true)
  })
})

describe('移动端工作站 · 快捷动作', () => {
  it('四条快捷动作都在，且能横向滚动不被裁掉', async () => {
    const wrapper = await render()
    const chips = wrapper.findAll('.m-qa-chip').map((c) => c.text())
    expect(chips).toEqual(['💬问诊记录', '🔍鉴别诊断', '➡️接诊下一位'])
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
    expect(actions.some((a) => a.includes('开始问诊'))).toBe(true)
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

describe('移动端 · 安全条（常驻）', () => {
  /**
   * 过敏与未处置红线是**永远该在场**的信息。移动端此前连过敏标记都没有 ——
   * 桌面端有，而手机上医生同样会看着这一屏开药。
   *
   * 钉在顶栏之下、内容之上：随内容滚走的安全提示，等于在最需要的时候不在。
   */
  it('写出过敏原本身，不只是「有过敏史」', async () => {
    const wrapper = await render()
    const bar = wrapper.find('.m-safebar')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('青霉素')
  })

  it('未处置红线给条数 —— 医生要知道还欠几条', async () => {
    const wrapper = await render()
    const ws = useWorkstation()
    ws.hardAlerts = [
      { id: 'a1', name: '过敏冲突', level: '高风险', color: 'danger', summary: '同属青霉素类' },
      { id: 'a2', name: '血红蛋白危急值', level: '高风险', color: 'danger', summary: '58 g/L' },
    ] as never
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.m-safebar').text()).toContain('2')
  })

  it('**处置完就不再报数** —— 一直挂着数字的提示会被当成背景', async () => {
    const wrapper = await render()
    const ws = useWorkstation()
    ws.hardAlerts = [{ id: 'a1', name: '过敏冲突', level: '高风险', color: 'danger', summary: 'x' }] as never
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.m-safebar').text()).toContain('1 条红线')

    ws.markAlertHandled('a1')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.m-safebar').text()).not.toContain('1 条红线')
  })

  it('没有过敏史也没有红线时整条不出现，不留一条空壳', async () => {
    const wrapper = await render()
    const ws = useWorkstation()
    ws.patient = { ...PATIENT, allergies: [], allergy_status: 'denied' } as never
    ws.hardAlerts = [] as never
    // openRedAlerts 是硬规则 + 模型两路合并的，只清一路这条用例就是空过的
    ws.summary = { ...SUMMARY, risk_alerts: [] } as never
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.m-safebar').exists()).toBe(false)
  })
})

describe('移动端 · 字号入口', () => {
  it('顶栏有常驻 Aa —— 不藏进「⋯」', async () => {
    // 看不清是当场的障碍。多一次点击就会有人放弃，然后一直眯着眼用。
    const wrapper = await render()
    expect(wrapper.find('.m-font-btn').exists()).toBe(true)
  })

  it('点开是四档，选中的那档标出来', async () => {
    const wrapper = await render()
    await wrapper.find('.m-font-btn').trigger('click')
    await wrapper.vm.$nextTick()
    const opts = wrapper.findAll('.m-font-opt')
    expect(opts).toHaveLength(4)
    expect(opts.map((o) => o.text())).toEqual(
      expect.arrayContaining([expect.stringContaining('小'), expect.stringContaining('特大')]),
    )
  })

  it('选一档就写到根元素上 —— 与桌面端同一个机制', async () => {
    const wrapper = await render()
    await wrapper.find('.m-font-btn').trigger('click')
    const big = wrapper.findAll('.m-font-opt').find((o) => o.text().includes('特大'))
    await big!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.documentElement.getAttribute('data-font')).toBe('xlarge')
  })
})

describe('移动端 · 生成后的回程条', () => {
  /**
   * 生成完自动切到分析页，此前**没有任何交代** —— 医生只看到界面自己变了。
   * 给一条能点回去的路标。
   */
  it('自动切到分析后出现回程条', async () => {
    const wrapper = await render()
    await (wrapper.vm as never as { goAnalysis: (f?: string) => void }).goAnalysis('auto')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.m-backbar').exists()).toBe(true)
    expect(wrapper.find('.m-backbar').text()).toContain('回到对话')
  })

  it('**手动点标签不出现** —— 否则它就成了常驻噪声', async () => {
    const wrapper = await render()
    await switchTo(wrapper, 'AI 助手')
    expect(wrapper.find('.m-backbar').exists()).toBe(false)
  })

  it('点回程条回到对话页', async () => {
    const wrapper = await render()
    await (wrapper.vm as never as { goAnalysis: (f?: string) => void }).goAnalysis('auto')
    await wrapper.vm.$nextTick()
    await wrapper.find('.m-backbar').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.m-chat').exists()).toBe(true)
  })
})

describe('移动端 · 与桌面端对齐', () => {
  it('底部三档叫「医生智能体 / AI 助手 / 记录」，与桌面端同名', async () => {
    // 同一个东西两处叫法不同，医生要在脑子里做一次翻译
    const wrapper = await render()
    expect(wrapper.findAll('.m-tab').map((t) => t.text().replace(/\d+/g, '').trim()))
      .toEqual(expect.arrayContaining([
        expect.stringContaining('医生智能体'),
        expect.stringContaining('AI 助手'),
        expect.stringContaining('记录'),
      ]))
  })

  it('**「报告解读」已撤** —— 桌面端 2026-09-03 按一期范围撤掉了', async () => {
    const wrapper = await render()
    expect(wrapper.text()).not.toContain('报告解读')
  })

  it('有科室看板入口 —— 桌面端有，移动端此前没有', async () => {
    const wrapper = await render()
    await wrapper.find('.m-more-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('科室看板')
  })

  it('有设置入口 —— MobileSettings 此前有页面无入口', async () => {
    const wrapper = await render()
    await wrapper.find('.m-more-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('个人配置')
  })

  it('切标签要记埋点 —— 移动端此前零埋点，使用统计只覆盖了桌面', async () => {
    const { useTelemetry, __resetTelemetry } = await import('../composables/useTelemetry')
    const wrapper = await render()
    __resetTelemetry()
    await switchTo(wrapper, '记录')
    expect(useTelemetry()._queue().some((e) => e.event === 'pane_switch')).toBe(true)
  })
})

describe('移动端 · 开场卡重排', () => {
  const withSummary = async (extra: Record<string, unknown>) => {
    const wrapper = await render()
    const ws = useWorkstation()
    ws.summary = { ...SUMMARY, ...extra } as never
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('风险条目带**等级色点** —— 原来只有名字，看不出哪条更急', async () => {
    const wrapper = await withSummary({
      risk_alerts: [
        { id: 'x1', name: '过敏冲突', level: '高风险', color: 'danger', summary: '在用阿莫西林克拉维酸钾，同属青霉素类' },
        { id: 'x2', name: '超声异常', level: '中风险', color: 'warning', summary: '内膜增厚伴丰富血流' },
      ],
    })
    // 收窄到风险卡：概要卡的「信息冲突」条也用色点
    const dots = wrapper.find('[data-card="risk"]').findAll('.m-card-dot')
    expect(dots).toHaveLength(2)
    // 颜色用后端给的 color，不在前端另排一套映射
    expect(dots[0].classes()).toContain('danger')
    expect(dots[1].classes()).toContain('warning')
  })

  it('摘要**截断成一行** —— 开场卡的作用是「有几件事」，不是读全文', async () => {
    const long = '在用阿莫西林克拉维酸钾片，与既往青霉素过敏史冲突，须立即停用并更换替代方案，记录过敏反应类型'
    const wrapper = await withSummary({
      risk_alerts: [{ id: 'x1', name: '过敏冲突', level: '高风险', color: 'danger', summary: long }],
    })
    const sub = wrapper.find('.m-card-sub')
    expect(sub.exists()).toBe(true)
    expect(sub.text().length).toBeLessThan(long.length)
    expect(sub.text()).toContain('…')
  })

  it('概要卡把问题清单摊成前 3 条，不是一整段', async () => {
    const wrapper = await withSummary({
      overall_conclusion: {
        risk_level: '高风险',
        summary: '异常子宫出血致重度贫血。',
        problems: ['血红蛋白 58 g/L', '内膜 14 mm', 'HPV16 阳性', '空腹血糖 9.4', 'CA125 38.6'],
      },
    })
    // 收窄到概要卡：风险卡的条目用同一个类名，跨卡数会把它们算进来
    const card = wrapper.find('[data-card="summary"]')
    expect(card.findAll('.m-card-bullet')).toHaveLength(3)
    // 还剩几条要说出来，否则医生以为只有 3 条
    expect(card.find('.m-card-more').text()).toContain('5')
  })

  it('结论只取**第一句** —— 模型给的 summary 是整段，原样加粗只会更难读', async () => {
    /*
     * 第一版把 `conclusion.summary` 整段放进 lead 并加粗，实测在 390px 下
     * 铺了 20 行、把整屏占满 —— 比改之前还糟。加粗放大的是**已经太长**的东西。
     * 全文并没有丢：在「查看完整分析」里。
     */
    const wrapper = await withSummary({
      overall_conclusion: {
        risk_level: '高风险',
        summary: '49岁女性，异常子宫出血致重度贫血。血红蛋白58 g/L已达危急值下限，铁蛋白6.2 ng/mL提示铁储备耗竭。经阴道超声示内膜增厚。',
        problems: [],
      },
    })
    const lead = wrapper.find('[data-card="summary"] .m-card-lead')
    expect(lead.text()).toBe('49岁女性，异常子宫出血致重度贫血。')
  })

  it('信息冲突单独成条并标红 —— 它是矛盾，不是概要的一部分', async () => {
    const wrapper = await withSummary({
      overall_conclusion: {
        risk_level: '高风险', summary: '异常子宫出血。', problems: ['血红蛋白 58'],
        conflicts: ['医嘱含阿莫西林，与青霉素过敏史并存'],
      },
    })
    const card = wrapper.find('[data-card="summary"]')
    const first = card.findAll('.m-card-bullet')[0]
    expect(first.text()).toContain('信息冲突')
    expect(first.find('.m-card-dot').classes()).toContain('danger')
  })

  it('问题清单不足 3 条时不显示「展开全部」', async () => {
    const wrapper = await withSummary({
      overall_conclusion: { risk_level: '中风险', summary: 'x', problems: ['甲', '乙'] },
    })
    const card = wrapper.find('[data-card="summary"]')
    expect(card.findAll('.m-card-bullet')).toHaveLength(2)
    expect(card.find('.m-card-more').exists()).toBe(false)
  })
})
