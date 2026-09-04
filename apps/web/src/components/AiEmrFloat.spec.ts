import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import AiEmrFloat from './AiEmrFloat.vue'
import { useWorkstation } from '../stores/workstation'

/*
 * 「＋ 菜单」与「技能管理」两组测试 2026-09-03 删除 —— 功能已按一期范围整块撤掉。
 *
 * **功能下线要连着测试一起删。** 留着的话它们会一直红，然后被人加 skip，
 * 而一个 skip 掉的测试和没有测试是一回事，只是更容易骗过「全绿」这个印象。
 *
 * 连带删掉的还有只服务于这两组的 `PLUS_ITEMS` / `PROMPTS` 两个常量 ——
 * 一份「五项文案不可改」的清单，在没有任何用例读它之后，就只是看起来还有人管。
 */

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:p(.*)', component: { template: '<div/>' } }],
})

/** 两条质控遗漏：一条红线（error），一条未采集（warning） */
const GAPS = [
  {
    field: '既往史', field_key: 'past_history', issue: '：出现「否认」但问诊中未涉及',
    text: '既往史：出现「否认」但问诊中未涉及', level: 'danger', status: '须核实', type: 'error',
  },
  {
    field: '个人史', field_key: 'personal_history', issue: '尚未采集',
    text: '个人史尚未采集', level: 'warn', status: '建议补充', type: 'warning',
  },
]

/** 已解锁的就诊状态。绝大多数用例测的是解锁后的界面，前置就是「问诊已完成」。 */
export const UNLOCKED_VISIT = {
  patient_id: 'P001', interview_done: true, analysis_unlocked: true,
  unlocked_by: 'interview', unlocked_at: '2026-09-01T09:00:00Z',
}

/** 组件挂载时会拉专项评估目录，其余接口按需返回空壳 */
function stubFetch(quality?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('visit-state')) {
        return new Response(JSON.stringify(UNLOCKED_VISIT), { status: 200 })
      }
      if (String(url).includes('red-alerts')) {
        return new Response(
          JSON.stringify({ patient_id: 'P001', alerts: [], handled_alerts: [], open_count: 0 }),
          { status: 200 },
        )
      }
      if (String(url).includes('assessment')) {
        return new Response(JSON.stringify({ categories: [] }), { status: 200 })
      }
      // 点「生成」会走 report-summary。**桩必须带 `_meta`** —— 真接口每条路径都带，
      // 回一个 `{}` 等于在测一个线上不存在的形状，反倒把真问题盖住。
      if (String(url).includes('report-summary')) {
        return new Response(
          JSON.stringify({ patient_id: 'P001', _meta: { degraded_agents: [] } }),
          { status: 200 },
        )
      }
      if (String(url).includes('record/quality')) {
        return new Response(
          JSON.stringify(quality ?? { completeness: 60, metrics: [], gaps: GAPS }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }),
  )
}

async function renderFloat() {
  stubFetch()
  const wrapper = mount(AiEmrFloat, {
    global: { plugins: [createPinia(), router, ElementPlus] },
    attachTo: document.body,
  })
  await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
  await expandAssistant(wrapper)
  return wrapper
}

/**
 * AI 助手默认是**收起**的（2026-09-02：一进来只有医生智能体）。
 * 绝大多数用例断言的是抽屉里的内容，所以挂载后统一先把它展开。
 *
 * 用真实的开关按钮而不是直接改内部状态 —— 那个按钮本身就是这次要保证的东西，
 * 绕过它的话，哪天开关坏了这批用例照样全绿。
 */
async function expandAssistant(wrapper: VueWrapper) {
  const toggle = wrapper.find('.assistant-handle')
  if (toggle.exists() && !wrapper.find('.tips-drawer').exists()) {
    await toggle.trigger('click')
    await wrapper.vm.$nextTick()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('浮层重新唤出', () => {
  it('抽屉开着时不显示任何唤出按钮', async () => {
    // 判据是**面板开着**（卡通是面板的收起态），不是「抽屉开着」——
    // 后者是原件圆钮的条件，那个钮还的是抽屉。
    const wrapper = await renderFloat()
    expect(wrapper.find('.assistant-panel').exists()).toBe(true)
    expect(wrapper.find('.mascot').exists()).toBe(false)
    expect(wrapper.find('.solo-tips-open-btn').exists()).toBe(false)
  })

  it('只关抽屉、面板还开着 → 不出浮动按钮，靠医生智能体里的开关卡片唤回', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tips-close').trigger('click')

    // 面板里的把手已经能唤回抽屉，这时再挂一个浮动入口属于凭空加 UI。
    expect(wrapper.find('.mascot').exists()).toBe(false)
    expect(wrapper.find('.solo-tips-open-btn').exists()).toBe(false)

    // 2026-09-03：开关从整块卡片改成面板左边线中间的抽屉把手。
    //
    // 那张卡片占三行、还带一段说明文字 —— 把「一个开关」做成了首屏最大的一块内容，
    // 医生每次进来先读三行，读完才发现它只是个展开按钮。把手靠**位置**表达
    // 「这边能拉开」，是抽屉的通用形态，不需要文字解释。
    const toggle = wrapper.find('.assistant-handle')
    expect(toggle.exists()).toBe(true)
    expect(toggle.classes()).not.toContain('expanded')
    // 没有文字了，可读性靠 aria-label / title 承担 —— 屏幕阅读器和悬停提示都要有
    expect(toggle.attributes('aria-label')).toContain('AI 助手')

    await toggle.trigger('click')
    expect(wrapper.find('.tips-drawer').exists()).toBe(true)
    expect(wrapper.find('.assistant-handle').classes()).toContain('expanded')
  })

  it('一进来 AI 助手是收起的 —— 问诊前不该先把结论摆出来', async () => {
    // 病历、鉴别诊断、风险、共病都由这一场问诊推导。问诊前先给结论，
    // 会让医生把「模型基于旧资料的猜测」当成本次判断 —— 那正是问诊门禁
    // 存在的理由，界面不该反过来把门禁的结论提前展示。
    stubFetch()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [createPinia(), router, ElementPlus] },
      attachTo: document.body,
    })
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))

    expect(wrapper.find('.tips-drawer').exists()).toBe(false)
    const toggle = wrapper.find('.assistant-handle')
    expect(toggle.exists()).toBe(true)
    // 收起态箭头指向左边 —— 指的是「抽屉会从这边拉出来」
    expect(toggle.text()).toContain('‹')
  })

  it('抽屉和面板都关 → 缩成 D1 卡通（2026-09-03 替掉「AI」圆钮）', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tips-close').trigger('click')
    await wrapper.find('.panel-close').trigger('click')

    const mascot = wrapper.find('.mascot')
    expect(mascot.exists()).toBe(true)
    // 换掉的是长相不是职责：位置沿用原件圆钮的 right:24 / bottom:32
    expect(mascot.findAll('.mascot-eye')).toHaveLength(2)
    expect(wrapper.find('.ai-float-btn').exists()).toBe(false)
    expect(wrapper.find('.solo-tips-open-btn').exists()).toBe(false)
  })

  it('**AI 助手开着时关面板，卡通照样出来** —— 否则面板就回不来了', async () => {
    // 实测过的一条死路：抽屉展开着关面板 —— 面板没了、卡通不出（原件的条件是
    // 「抽屉与面板都关」）、把手又长在面板内壁上跟着一起没了，
    // 页面上没有任何东西能把面板点回来。
    //
    // 根因是照抄了原件的显示条件：原件那个圆钮还的是**抽屉**，抽屉开着时
    // 它确实没事可做；而这只卡通还的是**面板**，条件必须跟着「它还什么」走。
    const wrapper = await renderFloat()
    expect(wrapper.find('.tips-drawer').exists()).toBe(true)

    await wrapper.find('.panel-close').trigger('click')

    expect(wrapper.find('.assistant-panel').exists()).toBe(false)
    expect(wrapper.find('.mascot').exists()).toBe(true)

    // 而且点了真能回来
    await wrapper.find('.mascot').trigger('click')
    expect(wrapper.find('.assistant-panel').exists()).toBe(true)
  })

  it('缩小键的**字形是「—」不是「×」** —— 靠 tooltip 补救的语义等于没有', async () => {
    // 提这个功能的人自己没找到入口，两次问「怎么缩小」。
    // 之前是 ×（只靠 title 说明它其实是最小化）—— 不够：
    // × 读起来就是「关掉」，没人会点它来「缩小」。
    const wrapper = await renderFloat()
    const btn = wrapper.find('.panel-close')
    expect(btn.text()).toBe('—')
    expect(btn.text()).not.toContain('×')
    expect(btn.attributes('title')).toContain('卡通')
    expect(btn.attributes('aria-label')).toContain('卡通')
  })

  it('医生智能体**没有第二个「彻底关掉」**', async () => {
    // 两个按钮做同一件事只会让人犹豫点哪个；真做一个「关了就没」的，
    // 就又造出一条回不来的死路 —— 这个项目已经踩过两次。
    //
    // 判据是「只有一个关闭类按钮」，**不是「只有一个按钮」** ——
    // 第一版那么写，后来加了字号按钮 Aa 就无辜变红了。
    // 按本意写的用例才不会拦住正常的功能新增。
    const wrapper = await renderFloat()
    const buttons = wrapper.findAll('.panel-header-actions .el-button')

    expect(wrapper.findAll('.panel-close')).toHaveLength(1)
    expect(buttons.filter((b) => b.text() === '×')).toHaveLength(0)
  })

  it('点卡通把**医生智能体面板**找回来，不是打开 AI 助手', async () => {
    // 原件那个圆钮点下去只开抽屉。照搬会留一条死路：
    // 面板关着、把手长在面板内壁上，抽屉开起来之后**面板再也回不来**。
    // 缩起来的是面板，点开就该还面板。
    const wrapper = await renderFloat()
    await wrapper.find('.tips-close').trigger('click')
    await wrapper.find('.panel-close').trigger('click')
    expect(wrapper.find('.assistant-panel').exists()).toBe(false)

    await wrapper.find('.mascot').trigger('click')
    expect(wrapper.find('.assistant-panel').exists()).toBe(true)
    // 面板回来了，把手也跟着回来 —— 抽屉从此有路可走
    expect(wrapper.find('.assistant-handle').exists()).toBe(true)
    // 卡通自己让位
    expect(wrapper.find('.mascot').exists()).toBe(false)
  })
})

describe('病历质控提醒', () => {
  /**
   * 质控挂在「病历管理」标签页。
   * 必须先给 store 一个 patientId —— refreshQuality 没有患者就直接返回，
   * 不设的话 quality 永远是 null，测的就是个空壳。
   */
  async function openQc(quality?: unknown) {
    stubFetch(quality)
    const pinia = createPinia()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    // 这些用例不走 selectPatient，store 里的 visit 一直是 null，
    // 受门禁的三页会整页让位给锁定卡，里面的元素取不到。
    useWorkstation(pinia).visit = UNLOCKED_VISIT as never
    useWorkstation(pinia).patientId = 'P001'
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
  await expandAssistant(wrapper)
    await wrapper.findAll('.ttab').find((t) => t.text().includes('病历管理'))!.trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.rc-risk-list').exists()).toBe(true))
    return wrapper
  }

  it('默认只给摘要，明细要点「查看全部」才展开', async () => {
    const wrapper = await openQc()
    expect(wrapper.find('.qc-item').exists()).toBe(false)

    await wrapper.find('.rc-side-more').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('.qc-item').length).toBeGreaterThan(0))
  })

  it('按 type 分图标 —— 红线和建议不能长一个样', async () => {
    const wrapper = await openQc()
    await wrapper.find('.rc-side-more').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('.qc-item').length).toBe(2))

    const items = wrapper.findAll('.qc-item')
    expect(items[0].classes()).toContain('error')
    expect(items[0].find('.qc-icon').text()).toBe('❌')
    expect(items[1].classes()).toContain('warning')
    expect(items[1].find('.qc-icon').text()).toBe('⚠️')
  })

  it('字段名单独成段，便于一眼定位是哪一段有问题', async () => {
    const wrapper = await openQc()
    await wrapper.find('.rc-side-more').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('.qc-item').length).toBe(2))

    const first = wrapper.findAll('.qc-item')[0]
    expect(first.find('.qc-field').text()).toBe('【既往史】')
    expect(first.find('.qc-issue').text()).toContain('否认')
  })

  it('点一条能跳到对应那一段病历', async () => {
    const wrapper = await openQc()
    await wrapper.find('.rc-side-more').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('.qc-item').length).toBe(2))

    await wrapper.findAll('.qc-item')[1].trigger('click')
    await wrapper.vm.$nextTick()

    // 落点是那一段的病历节点（已有的 data-record-node），并被标记为聚焦
    const target = wrapper.find('[data-record-node="personal_history"]')
    expect(target.exists()).toBe(true)
    expect(target.classes()).toContain('focused')

    // 高亮必须真的有样式撑着 —— 只挂个类名不配 CSS，点了等于没反应。
    // 这个坑真踩过：类挂上了、测试绿了，公网上点下去纹丝不动。
    const css = readFileSync(resolve(__dirname, '../styles/AiEmrFloat.scoped.css'), 'utf-8')
    expect(css).toContain('.record-node.focused')
  })

  it('「我已审阅质控提醒」只在明细展开时出现，点完提醒收起', async () => {
    const wrapper = await openQc()
    const label = '我已审阅质控提醒'
    expect(wrapper.text()).not.toContain(label)

    await wrapper.find('.rc-side-more').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.qc-reviewed-btn').exists()).toBe(true))
    expect(wrapper.find('.qc-reviewed-btn').text()).toContain(label)

    await wrapper.find('.qc-reviewed-btn').trigger('click')
    // 现在要先落库再收起 —— 没留痕就不该表现为「已完成」，所以是异步的
    await vi.waitFor(() => expect(wrapper.find('.qc-item').exists()).toBe(false))
  })

  it('审阅是记录一次确认，不是把遗漏抹掉', async () => {
    const wrapper = await openQc()
    await wrapper.find('.rc-side-more').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.qc-reviewed-btn').exists()).toBe(true))
    await wrapper.find('.qc-reviewed-btn').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.qc-item').exists()).toBe(false))

    // 遗漏本身仍在 —— 审阅只代表医生看过，不代表病历改好了。
    // 抹掉它等于用一次点击把红线消音。
    expect(wrapper.findAll('.rc-risk-row').length).toBeGreaterThan(0)
    expect(wrapper.text()).toContain('既往史')
  })

  it('没有遗漏时不出「查看全部」明细', async () => {
    const wrapper = await openQc({ completeness: 100, metrics: [], gaps: [] })
    await wrapper.find('.rc-side-more').trigger('click')
    expect(wrapper.find('.qc-item').exists()).toBe(false)
    expect(wrapper.find('.qc-reviewed-btn').exists()).toBe(false)
  })
})

describe('诊断命令接进界面', () => {
  async function open() {
    stubFetch()
    const pinia = createPinia()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    // 这些用例不走 selectPatient，store 里的 visit 一直是 null，
    // 受门禁的三页会整页让位给锁定卡，里面的元素取不到。
    useWorkstation(pinia).visit = UNLOCKED_VISIT as never
    useWorkstation(pinia).patientId = 'P001'
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
  await expandAssistant(wrapper)
    await wrapper.findAll('.ttab').find((t) => t.text().includes('诊断管理'))!.trigger('click')
    return wrapper
  }

  /** 在 Copilot 输入框里打一条命令并发出 */
  async function type(wrapper: Awaited<ReturnType<typeof open>>, text: string) {
    await wrapper.find('.chat-textarea-wrap textarea').setValue(text)
    await wrapper.find('.float-send-btn').trigger('click')
    await wrapper.vm.$nextTick()
  }

  it('手打添加的诊断要出现在列表里，否则医生以为没生效', async () => {
    const wrapper = await open()
    await type(wrapper, '添加诊断：急性胃肠炎 K52.9')

    const names = wrapper.findAll('.suspected-item .susp-name').map((n) => n.text())
    expect(names).toContain('急性胃肠炎')
  })

  it('命令不发请求给模型 —— 结果必须确定', async () => {
    const wrapper = await open()
    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length
    await type(wrapper, '添加诊断：肺炎')

    const after = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(after.slice(before).every((c) => !String(c[0]).includes('copilot/chat'))).toBe(true)
  })

  it('普通提问照常交给模型，不被命令层吞掉', async () => {
    const wrapper = await open()
    await type(wrapper, '这个患者要不要抗凝')
    await vi.waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      expect(calls.some((c) => String(c[0]).includes('copilot/chat'))).toBe(true)
    })
  })
})

describe('临床知识库', () => {
  const KB_HITS = [
    { key: 'dd_chest_pain', title: '胸闷胸痛鉴别', keywords: ['胸闷', '胸痛'] },
    { key: 'blood_rt', title: '血常规解读', keywords: ['血常规'] },
  ]

  function stubKb(hits = KB_HITS) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('assessment')) return new Response(JSON.stringify({ categories: [] }), { status: 200 })
        if (u.includes('/knowledge/')) {
          return new Response(
            JSON.stringify({ key: 'blood_rt', title: '血常规解读', content: '<h3>参考范围</h3><table><tr><td>WBC</td></tr></table>' }),
            { status: 200 },
          )
        }
        if (u.includes('/knowledge')) return new Response(JSON.stringify({ items: hits }), { status: 200 })
        if (u.includes('copilot/chat')) {
          return new Response('data: {"type":"token","token":"患者胸闷，建议查血常规"}\n\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        }
        return new Response(JSON.stringify({}), { status: 200 })
      }),
    )
  }

  async function ask(hits = KB_HITS) {
    stubKb(hits)
    const pinia = createPinia()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    // 这些用例不走 selectPatient，store 里的 visit 一直是 null，
    // 受门禁的三页会整页让位给锁定卡，里面的元素取不到。
    useWorkstation(pinia).visit = UNLOCKED_VISIT as never
    useWorkstation(pinia).patientId = 'P001'
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
  await expandAssistant(wrapper)
    await wrapper.find('.chat-textarea-wrap textarea').setValue('这个患者的胸闷怎么看')
    await wrapper.find('.float-send-btn').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('.kb-link').length).toBeGreaterThan(0))
    return wrapper
  }

  it('回复旁挂出命中的相关条目', async () => {
    const wrapper = await ask()
    const links = wrapper.findAll('.kb-link')
    expect(links.map((l) => l.text())).toEqual(['胸闷胸痛鉴别', '血常规解读'])
  })

  it('没命中就不挂 —— 挂七条不相关的比不挂更干扰', async () => {
    stubKb([])
    const pinia = createPinia()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    // 这些用例不走 selectPatient，store 里的 visit 一直是 null，
    // 受门禁的三页会整页让位给锁定卡，里面的元素取不到。
    useWorkstation(pinia).visit = UNLOCKED_VISIT as never
    useWorkstation(pinia).patientId = 'P001'
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
  await expandAssistant(wrapper)
    await wrapper.find('.chat-textarea-wrap textarea').setValue('今天天气不错')
    await wrapper.find('.float-send-btn').trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('.msg-bubble').length).toBeGreaterThan(0))

    expect(wrapper.find('.kb-link').exists()).toBe(false)
  })

  it('点条目打开弹窗并渲染正文', async () => {
    const wrapper = await ask()
    await wrapper.findAll('.kb-link')[1].trigger('click')
    // 正文按需拉取，要等它回来 —— 只等弹窗出现会断言在「加载中」上
    await vi.waitFor(() => expect(document.querySelector('.kb-dialog .kb-body')).toBeTruthy())

    const dialog = document.querySelector('.kb-dialog')!
    expect(dialog.textContent).toContain('参考范围')
    // 正文是结构化 HTML，必须渲染成表格而不是把标签当文字显示
    expect(dialog.querySelector('table')).toBeTruthy()
    expect(dialog.textContent).not.toContain('<table')
  })

  it('条目正文按需拉取，列表阶段不拉正文', async () => {
    const wrapper = await ask()
    const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls().some((c) => String(c[0]).includes('/knowledge/'))).toBe(false)

    await wrapper.findAll('.kb-link')[0].trigger('click')
    await vi.waitFor(() => expect(calls().some((c) => String(c[0]).includes('/knowledge/'))).toBe(true))
  })
})

describe('预警评估 · 风险色点与动作', () => {
  const RISKS = [
    { id: 'r1', name: '血糖控制不达标', level: '高风险', color: 'danger', summary: 's', evidence: 'e', suggestion: 'g' },
    { id: 'r2', name: '心肌缺血风险', level: '中风险', color: 'warning', summary: 's', evidence: 'e', suggestion: 'g' },
    { id: 'r3', name: '低风险项', level: '低风险', color: 'info', summary: 's', evidence: 'e', suggestion: 'g' },
  ]

  async function openRisk() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('assessment')) return new Response(JSON.stringify({ categories: [] }), { status: 200 })
        // 这一场就诊已解锁：改成状态机之后，selectPatient 不再自动跑 report-summary，
        // 只有解锁过的才会把分析拿回来。这几条测的是预警评估的渲染，前置就是「已解锁」。
        if (u.includes('visit-state')) {
          return new Response(
            JSON.stringify({ patient_id: 'P001', interview_done: true, analysis_unlocked: true, unlocked_by: 'interview', unlocked_at: '' }),
            { status: 200 },
          )
        }
        if (u.includes('red-alerts')) {
          return new Response(JSON.stringify({ patient_id: 'P001', alerts: [], handled_alerts: [], open_count: 0 }), { status: 200 })
        }
        if (u.includes('report-summary')) {
          return new Response(JSON.stringify({ risk_assessments: RISKS, risk_alerts: [], todos: [], _meta: {} }), { status: 200 })
        }
        return new Response(JSON.stringify({}), { status: 200 })
      }),
    )
    const pinia = createPinia()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    // 这些用例不走 selectPatient，store 里的 visit 一直是 null，
    // 受门禁的三页会整页让位给锁定卡，里面的元素取不到。
    useWorkstation(pinia).visit = UNLOCKED_VISIT as never
    await useWorkstation(pinia).selectPatient('P001')
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
  await expandAssistant(wrapper)
    await wrapper.findAll('.ttab').find((t) => t.text().includes('预警评估'))!.trigger('click')
    await vi.waitFor(() => expect(wrapper.findAll('.risk-card').length).toBe(3))
    return wrapper
  }

  it('色点按等级上色 —— 原件靠内联背景，只渲染空 span 等于看不见', async () => {
    const wrapper = await openRisk()
    const dots = wrapper.findAll('.risk-dot')
    expect(dots).toHaveLength(3)
    // 取自原件 DOM 的三档内联色
    expect(dots[0].attributes('style')).toContain('rgb(230, 25, 26)')
    expect(dots[1].attributes('style')).toContain('rgb(230, 162, 60)')
    expect(dots[2].attributes('style')).toContain('rgb(144, 147, 153)')
  })

  it('每条风险都带「大模型解读」与「↗」两个动作', async () => {
    const wrapper = await openRisk()
    const first = wrapper.findAll('.risk-card')[0]
    const labels = first.findAll('.risk-actions button').map((b) => b.text())
    expect(labels).toContain('大模型解读')
    expect(labels).toContain('↗')
  })

  it('「↗」带原件的 title 提示', async () => {
    const wrapper = await openRisk()
    const arrow = wrapper.findAll('.risk-actions button').find((b) => b.text() === '↗')
    expect(arrow?.attributes('title')).toBe('在 Copilot 中放大展示')
  })

  it('只有高风险才出「处置」—— 处置是红线闭环，不该给中低风险', async () => {
    const wrapper = await openRisk()
    const cards = wrapper.findAll('.risk-card')
    expect(cards[0].text()).toContain('处置')
    expect(cards[1].findAll('.risk-actions button').map((b) => b.text())).not.toContain('处置')
  })
})

describe('专项评估默认态', () => {
  const CATALOG = {
    categories: [
      {
        name: '诊疗质控助手',
        count: 2,
        items: [
          { name: '诊断预后分析', level: 'danger', desc: '说明一', default_expanded: true },
          { name: '院感风险监测', level: 'warning', desc: '说明二' },
        ],
      },
      { name: '患者服务助手', count: 1, items: [{ name: '随访计划', level: 'info', desc: '说明三' }] },
    ],
  }

  async function open() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('assessment')) return new Response(JSON.stringify(CATALOG), { status: 200 })
        return new Response(JSON.stringify({}), { status: 200 })
      }),
    )
    const pinia = createPinia()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    // 专项评估在「智慧诊疗」页，那一页受问诊门禁
    useWorkstation(pinia).visit = UNLOCKED_VISIT as never
    await expandAssistant(wrapper)
    await vi.waitFor(() => expect(wrapper.findAll('.ka-cat-header').length).toBe(2))
    return wrapper
  }

  it('叫「专项评估小助手」', async () => {
    const wrapper = await open()
    expect(wrapper.find('.ka-title').text()).toBe('专项评估小助手')
  })

  it('分类默认全折叠 —— 一期只做目录展示，铺开会把下面的内容挤没', async () => {
    // 有意偏离 V4.3（原件默认全展开）。33 项都还没 Agent 化，先当索引用。
    const wrapper = await open()
    expect(wrapper.findAll('.ka-cat-header')).toHaveLength(2)
    expect(wrapper.findAll('.ka-list')).toHaveLength(0)
    expect(wrapper.findAll('.ka-card')).toHaveLength(0)
  })

  it('点开分类才出条目，展开态本身仍与原件一致', async () => {
    const wrapper = await open()
    await wrapper.findAll('.ka-cat-header')[0].trigger('click')
    expect(wrapper.findAll('.ka-list')).toHaveLength(1)

    // 标了 default_expanded 的条目连说明一起展开，其余折叠 ——
    // 分类折叠只是把这一层盖住了，不该顺手改掉里面的层次。
    const cards = wrapper.findAll('.ka-card')
    expect(cards[0].classes()).not.toContain('collapsed')
    expect(cards[0].text()).toContain('说明一')
    expect(cards[1].classes()).toContain('collapsed')
    expect(cards[1].text()).not.toContain('说明二')
  })

  it('出厂目录里一项都不默认展开 —— 展开的说明会把首屏吃掉一大截', () => {
    // 有意偏离 V4.3：原件默认展开「诊断预后分析」「专病风险评估」两条说明，
    // 实测医生要往下翻才看得到其余 31 项。机制保留，只是数据里不标。
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../api/app/data/assessment_catalog.json'), 'utf-8'),
    )
    const expanded = catalog.categories.flatMap((c: { items: { name: string; default_expanded?: boolean }[] }) =>
      c.items.filter((i) => i.default_expanded).map((i) => i.name),
    )
    expect(expanded, '出厂目录不该有默认展开项').toEqual([])
  })

  it('默认展开哪几项由后端目录决定，不写死在组件里', async () => {
    // 组件禁止写死临床数据：改默认态应该只改后端目录，不改代码。
    // 直接读组件源码断言 —— 否则这条测试测不到任何东西。
    const src = readFileSync(resolve(__dirname, 'AiEmrFloat.vue'), 'utf-8')
    for (const name of ['诊断预后分析', '专病风险评估', '院感风险监测']) {
      expect(src, `组件里不该出现评估条目名「${name}」`).not.toContain(name)
    }
    expect(src).toContain('default_expanded')
  })
})

describe('问诊门禁', () => {
  const LOCKED_VISIT = {
    patient_id: 'P001', interview_done: false, analysis_unlocked: false,
    unlocked_by: '', unlocked_at: '',
  }

  async function openLocked(visit: unknown = LOCKED_VISIT) {
    stubFetch()
    const pinia = createPinia()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    useWorkstation(pinia).visit = visit as never
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
  await expandAssistant(wrapper)
    return wrapper
  }

  const goTab = async (wrapper: ReturnType<typeof mount>, tab: string) => {
    await wrapper.findAll('.ttab').find((t) => t.text().includes(tab))!.trigger('click')
    await wrapper.vm.$nextTick()
  }

  it('未问诊时，模型推断的四页锁着', async () => {
    const wrapper = await openLocked()
    const locked = wrapper.findAll('.ttab.locked').map((t) => t.text().replace('🔒', ''))
    expect(locked).toEqual(['智慧诊疗', '病历管理', '诊断管理', '共病管理'])
  })

  it('客观数据那四页不锁 —— 尤其预警评估', async () => {
    // 让医生在不知道危急值的情况下问完一整轮，是不能接受的
    const wrapper = await openLocked()
    const all = wrapper.findAll('.ttab').map((t) => t.text().replace('🔒', ''))
    const locked = new Set(wrapper.findAll('.ttab.locked').map((t) => t.text().replace('🔒', '')))
    for (const tab of ['预警评估', '医嘱管理', '健康档案', '时间轴']) {
      expect(all).toContain(tab)
      expect(locked.has(tab), `${tab} 不该被锁`).toBe(false)
    }
  })

  it('锁着的页整页让位给说明卡，不显示空面板', async () => {
    // 空面板会让医生以为「分析跑失败了」，而不是「还没到时候」
    const wrapper = await openLocked()
    expect(wrapper.find('.gate-pane').exists()).toBe(true)
    expect(wrapper.find('.condition-overview-card').exists()).toBe(false)
    expect(wrapper.find('.gate-title').text()).toContain('待问诊后生成')
  })

  it('说明卡写清为什么锁，并给两条出路', async () => {
    const wrapper = await openLocked()
    const text = wrapper.find('.gate-card').text()
    expect(text).toContain('基于本次问诊')
    expect(text).toContain('锚定')
    const labels = wrapper.find('.gate-actions').findAll('button').map((b) => b.text())
    // 2026-09-03 文案改为「开始问诊」：一期没有语音识别，写「语音」会让医生
    // 以为要对着说话。实际形态是文本框（系统语音输入法或直接打字）。
    expect(labels.some((l) => l.includes('开始问诊'))).toBe(true)
    expect(labels.some((l) => l.includes('语音'))).toBe(false)
    expect(labels.some((l) => l.includes('跳过问诊'))).toBe(true)
  })

  it('标签页不消失，只压暗 —— 消失会让人以为系统没这功能', async () => {
    const wrapper = await openLocked()
    expect(wrapper.findAll('.ttab')).toHaveLength(8)
  })

  it('切到不受门禁的页，正常显示内容而不是锁定卡', async () => {
    const wrapper = await openLocked()
    await goTab(wrapper, '时间轴')
    expect(wrapper.find('.gate-pane').exists()).toBe(false)
  })

  it('问诊解锁后标「已按本次问诊生成」', async () => {
    const wrapper = await openLocked(UNLOCKED_VISIT)
    expect(wrapper.find('.gate-pane').exists()).toBe(false)
    const banner = wrapper.find('.gate-banner')
    expect(banner.text()).toContain('已按本次问诊生成')
    expect(banner.classes()).not.toContain('skipped')
  })

  it('跳过解锁后必须如实标「未含问诊」', async () => {
    // 否则医生会以为这份分析听过患者说话
    const wrapper = await openLocked({
      patient_id: 'P001', interview_done: false, analysis_unlocked: true,
      unlocked_by: 'skipped', unlocked_at: '2026-09-01T09:00:00Z',
    })
    const banner = wrapper.find('.gate-banner')
    expect(banner.text()).toContain('未含问诊')
    expect(banner.classes()).toContain('skipped')
  })

  it('来源横幅只挂在受门禁的四页上 —— 客观数据没有「含不含问诊」之分', async () => {
    const wrapper = await openLocked(UNLOCKED_VISIT)
    await goTab(wrapper, '时间轴')
    expect(wrapper.find('.gate-banner').exists()).toBe(false)
  })
})

describe('风险名按等级着色', () => {
  /**
   * 这个映射原本由还原度门禁守着。但 `.ra-card-name` 的颜色绑在 `risk.color` 上，
   * 而风险等级是**模型判的** —— 2026-09-02 换到 Sonnet 5 后同一个病例的首条风险
   * 由高风险变中风险，颜色红变橙，门禁把内容差异报成了还原度差异。
   *
   * 那条比对已按选择器豁免 `color`，映射改由这里守：换个地方守，不是放掉。
   */
  const ALERTS = [
    { id: 'a1', name: '心肌缺血迹象', level: '高风险', color: 'danger', summary: 's' },
    { id: 'a2', name: '低血糖风险', level: '中风险', color: 'warning', summary: 's' },
  ]

  it('danger 用 .ra-name-danger，warning 用 .ra-name-warning', async () => {
    stubFetch()
    const pinia = createPinia()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    const ws = useWorkstation(pinia)
    ws.visit = UNLOCKED_VISIT as never
    ws.summary = { risk_assessments: ALERTS, risk_alerts: [], _meta: {} } as never
    await wrapper.vm.$nextTick()
    await expandAssistant(wrapper)

    const names = wrapper.findAll('.ra-card-name')
    expect(names).toHaveLength(2)
    expect(names[0].classes()).toContain('ra-name-danger')
    expect(names[1].classes()).toContain('ra-name-warning')
  })

  it('卡片底色跟着同一个判据走，不另起一套', async () => {
    stubFetch()
    const pinia = createPinia()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [pinia, router, ElementPlus] },
      attachTo: document.body,
    })
    const ws = useWorkstation(pinia)
    ws.visit = UNLOCKED_VISIT as never
    ws.summary = { risk_assessments: ALERTS, risk_alerts: [], _meta: {} } as never
    await wrapper.vm.$nextTick()
    await expandAssistant(wrapper)

    const cards = wrapper.findAll('.ra-card')
    expect(cards[0].classes()).toContain('ra-card-danger')
    expect(cards[1].classes()).toContain('ra-card-warning')
  })
})

/*
 * 「AI 助手收起时的空状态」一组测试 2026-09-03 删除 —— 那张说明卡整块撤了。
 *
 * 它讲的是「为什么现在还没有结论」，而八个标签页上的 🔒 与医生智能体里的
 * 门禁说明卡已经说过同一件事。同一个道理讲三遍，第三遍只是挡住底下的 HIS。
 */

// ================================================================ 患者信息行与过敏标记

/** 直接往 store 里放一位患者，绕开接口 —— 这批用例测的是渲染分支，不是取数 */
async function renderWithPatient(allergy: { status: string; items: string[] }) {
  stubFetch()
  const pinia = createPinia()
  const wrapper = mount(AiEmrFloat, {
    global: { plugins: [pinia, router, ElementPlus] },
    attachTo: document.body,
  })
  await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))

  const ws = useWorkstation()
  ws.patient = {
    id: 'P001', name: '王某某', gender: '女', age: 58,
    birth_date: '1968-03-15', allergy,
    visit_type: '复诊', dept: '内分泌科', doctor: '李医生', visit_date: '2026-06-17',
    chief_complaint: '血糖控制不佳', primary_diagnosis: '2型糖尿病', risk_level: '高风险',
    id_no: '', phone: '', is_return_visit: true, pre_consultation_done: true,
    nutrition_screening_score: 0,
  } as never
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('患者信息行', () => {
  it('一行显示完：性别 · 年龄 · 出生年月 · 就诊号', async () => {
    const wrapper = await renderWithPatient({ status: 'denied', items: [] })
    const meta = wrapper.find('.patient-tab-meta').text()
    expect(meta).toBe('女 · 58岁 · 1968-03 · P001')
  })

  it('出生年月只到月 —— 门诊核对身份用不到日，写全会把这一行挤爆', async () => {
    const wrapper = await renderWithPatient({ status: 'denied', items: [] })
    expect(wrapper.find('.patient-tab-meta').text()).not.toContain('1968-03-15')
  })

  it('身份证号不出现在界面上', async () => {
    const wrapper = await renderWithPatient({ status: 'denied', items: [] })
    expect(wrapper.text()).not.toMatch(/\d{17}[\dX]/)
  })
})

describe('浮窗调宽', () => {
  it('两个浮窗各有一条调宽边线', async () => {
    const wrapper = await renderFloat()
    expect(wrapper.findAll('.resize-edge')).toHaveLength(2)
  })

  it('边线要能被读屏软件认出来是分隔条 —— 它是纯图形，没有文字', async () => {
    const wrapper = await renderFloat()
    const edge = wrapper.find('.resize-edge')
    expect(edge.attributes('role')).toBe('separator')
    expect(edge.attributes('aria-orientation')).toBe('vertical')
    expect(edge.attributes('aria-label')).toContain('宽度')
  })

  it('**往左拖是变宽** —— 浮窗靠右停靠，左边线远离锚点就是变宽', async () => {
    const wrapper = await renderFloat()
    const edge = wrapper.findAll('.resize-edge')[1].element   // 医生智能体那条
    edge.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 900, clientY: 300 }))
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 820, clientY: 300 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 820, clientY: 300 }))
    await wrapper.vm.$nextTick()

    // 默认 300 + 拖走的 80
    expect(wrapper.find('.assistant-panel').attributes('style')).toContain('380px')
  })

  it('双击边线恢复默认宽度', async () => {
    const wrapper = await renderFloat()
    const edge = wrapper.findAll('.resize-edge')[1]
    edge.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 900, clientY: 300 }))
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 820, clientY: 300 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 820, clientY: 300 }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.assistant-panel').attributes('style')).toContain('380px')

    await edge.trigger('dblclick')
    // 回到「交给 CSS」而不是写死一个数
    expect(wrapper.find('.assistant-panel').attributes('style') ?? '').not.toContain('width')
  })
})

describe('过敏标记', () => {
  it('有过敏史 → 红标，并且写出过敏原是什么', async () => {
    const wrapper = await renderWithPatient({ status: 'confirmed', items: ['青霉素'] })
    const badge = wrapper.find('.allergy-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('danger')
    // 只写「有过敏」等于没说 —— 医生还得再点一次才知道是什么
    expect(badge.text()).toContain('青霉素')
  })

  it('多个过敏原 → 首个 + 计数，完整清单进 title', async () => {
    const wrapper = await renderWithPatient({ status: 'confirmed', items: ['青霉素', '磺胺', '头孢'] })
    const badge = wrapper.find('.allergy-badge')
    expect(badge.text()).toContain('青霉素')
    expect(badge.text()).toContain('+2')
    expect(badge.attributes('title')).toContain('磺胺')
  })

  it('已明确否认 → 不给任何标记，干净就是信息', async () => {
    const wrapper = await renderWithPatient({ status: 'denied', items: [] })
    expect(wrapper.find('.allergy-badge').exists()).toBe(false)
  })

  it('未采集 → 黄标，**不是无标记**', async () => {
    // 这是整件事的重点：「问过、没有」和「没人问过」不能显示成同一个样子。
    // 合并的话，医生看到的是「这个人不过敏」，而事实是从来没有人问过。
    const wrapper = await renderWithPatient({ status: 'unknown', items: [] })
    const badge = wrapper.find('.allergy-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('warn')
    expect(badge.text()).toContain('未采集')
  })

  it('红色只留给过敏 —— 原来那个红色的「语」标记必须消失', async () => {
    // 删它的理由有两条，任一条单独成立：
    // ① 一期没有任何语音识别（全仓零行 SpeechRecognition），它标的模式不存在；
    // ② 红色在本产品是临床风险语义（F06 明确禁止拿红色做别的用途）——
    //    医生扫到患者名字旁边的红色，第一反应是找风险。
    const wrapper = await renderWithPatient({ status: 'denied', items: [] })
    expect(wrapper.find('.mode-badge.voice').exists()).toBe(false)
    expect(wrapper.find('.copilot-tab-bar').text()).not.toContain('语')
  })
})

// ================================================================ 问诊按钮与提示浮框

describe('问诊按钮组', () => {
  it('继续与暂停是同一个按钮的两态，不是两个按钮', async () => {
    // 原先「继续问诊」在进行中被**禁用** —— 医生想停一下时没有出路，
    // 只能等它播完，或者点那个红色的「结束问诊」把整场终结掉。
    // 「我想停一下」和「我问完了」是完全不同的两个意图。
    const wrapper = await renderFloat()
    const bar = wrapper.find('.action-bar')
    expect(bar.exists()).toBe(true)
    // 任何时候都只有一个「继续/暂停」按钮，且从不禁用
    const toggles = bar.findAll('.ib-secondary')
    expect(toggles.length).toBeLessThanOrEqual(1)
    toggles.forEach((b) => expect(b.attributes('disabled')).toBeUndefined())
  })

  it('主操作只有一个：生成是实心，继续/暂停是描边', async () => {
    // 两个都实心、还不同色系（蓝 + 绿）时视觉权重一样重，
    // 医生要挨个读才知道该点哪个。
    const wrapper = await renderFloat()
    const bar = wrapper.find('.action-bar')
    if (!bar.findAll('.ib-primary').length) return   // 未进入问诊态时没有这组按钮
    expect(bar.find('.ib-primary').text()).toBe('生成')
    expect(bar.find('.ib-primary').classes()).toContain('el-button--primary')
  })
})

describe('工具栏（一期范围）', () => {
  it('「＋」整块撤掉 —— 里面五项没有一项是这一期交付的', async () => {
    const wrapper = await renderFloat()
    expect(wrapper.find('.tb-plus-btn').exists()).toBe(false)
    expect(wrapper.find('.plus-menu').exists()).toBe(false)
  })

  it('「报告解读」撤掉，「鉴别诊断」改名「科室看板」', async () => {
    const wrapper = await renderFloat()
    const labels = wrapper.findAll('.tb-action-btn').map((b) => b.text())
    expect(labels).not.toContain('报告解读')
    expect(labels).not.toContain('鉴别诊断')
    expect(labels).toContain('科室看板')
  })

  it('技能管理对话框一并删除 —— 它唯一的入口在「＋」里', async () => {
    // 撤「＋」时我先写了句「技能管理在别处有正经入口」，查了一遍发现那是错的：
    // 全仓只有那一个入口。留着就是打不开的死代码。
    const wrapper = await renderFloat()
    expect(wrapper.find('.skill-manage-dialog').exists()).toBe(false)
  })
})

describe('问诊提示浮框', () => {
  it('没有条目时一条都不显示 —— 绝不弹空框', async () => {
    // 这个功能 2026-09-02 撤过一次，理由是「一期没有临床知识库，做不准，
    // 对医生是干扰」。那条理由没有失效，所以「空则不弹」是它能回来的前提。
    const wrapper = await renderFloat()
    expect(wrapper.find('.hint-float').exists()).toBe(false)
  })

  it('措辞必须压住：是提示，不是必须问的清单', async () => {
    // 条目用问号结尾的问句、底部写明「供参考」——
    // 一个做不准的建议，语气越肯定伤害越大。
    const src = AiEmrFloat as unknown as { render?: unknown }
    expect(src).toBeTruthy()
    const wrapper = await renderFloat()
    // 浮框未显示时不该有任何祈使式文案残留在 DOM 里
    expect(wrapper.text()).not.toContain('必须追问')
  })
})

describe('降级不得伪装成建议', () => {
  it('问诊小结降级时，兜底文案不能当作追问提示弹出来', async () => {
    // 实跑抓到的：interview/complete 降级时 gaps 是本地规则写死的一句
    // 「模型通道不可用，本次问诊未生成结构化小结，请人工整理」——
    // 那是**错误信息**，不是追问建议。不拦的话医生会看到一条 💡 图标的提示
    // 写着「模型通道不可用」，比不给提示糟得多：它把一次故障伪装成了临床建议。
    const { useInterview } = await import('../composables/useInterview')
    const { api } = await import('../api')

    const spy = vi.spyOn(api, 'interviewComplete').mockResolvedValue({
      ok: true,
      degraded: true,
      analysis_gaps: ['模型通道不可用，本次问诊未生成结构化小结，请人工整理。'],
    } as never)

    const iv = useInterview(() => 'P001')
    iv.messages.value = [{ role: 'doctor', text: '最近怎么样？' }]
    await iv.persist()
    expect(iv.hints.value).toEqual([])

    // 反过来：没降级时正常收下
    spy.mockResolvedValue({ ok: true, degraded: false, analysis_gaps: ['夜尿次数有增多吗？'] } as never)
    await iv.persist()
    expect(iv.hints.value).toEqual(['夜尿次数有增多吗？'])
    spy.mockRestore()
  })
})
// ================================================ 问诊按钮组与提示浮框（走真实产品路径）

/**
 * 起一场问诊：桩掉 `interviewInit` 给两句脚本，点「开始问诊」。
 *
 * **不直接改 `voice.state`。** 组件里的 `useInterview` 是它自己 setup 时建的那一份，
 * 测试里再 `useInterview()` 一次拿到的是另一组 ref，改了组件根本看不见 ——
 * 何况「点开始问诊真的能进入 playing」本身就是这批用例要保证的东西之一。
 */
async function mountWithPatient() {
  stubFetch()
  const pinia = createPinia()
  const wrapper = mount(AiEmrFloat, {
    global: { plugins: [pinia, router, ElementPlus] },
    attachTo: document.body,
  })
  // `renderFloat()` 不设 patientId，而 `voice.start()` 没有患者直接 return ——
  // 用它起问诊会一路静默失败，测出来的是个空壳。
  useWorkstation(pinia).visit = UNLOCKED_VISIT as never
  useWorkstation(pinia).patientId = 'P001'
  await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
  await expandAssistant(wrapper)
  return wrapper
}

async function startInterview(wrapper: VueWrapper, gaps: string[] = []) {
  const { api } = await import('../api')
  vi.spyOn(api, 'interviewInit').mockResolvedValue({
    degraded: false,
    dialog: [
      { role: 'doctor', text: '最近哪里不舒服？' },
      { role: 'patient', text: '这两天胸口发闷。' },
      { role: 'doctor', text: '有多久了？' },
      { role: 'patient', text: '大概三天。' },
    ],
  } as never)
  // AI 追问提示：清单用 gaps 顶上，判定默认不划任何东西
  vi.spyOn(api, 'followUpPlan').mockResolvedValue({
    questions: gaps, provider: 'x', degraded: false,
  } as never)
  vi.spyOn(api, 'followUpCoverage').mockResolvedValue({
    covered: [], provider: 'x', degraded: false,
  } as never)
  vi.spyOn(api, 'interviewComplete').mockResolvedValue({
    ok: true, degraded: false, analysis_gaps: gaps,
  } as never)

  await wrapper.find('.action-bar .el-button').trigger('click')
  await vi.waitFor(() => expect(wrapper.find('.action-bar .ib-primary').exists()).toBe(true))
  return wrapper
}

describe('问诊按钮组 · 生成不结束问诊', () => {
  it('点生成之后问诊还在跑 —— 医生可以边问边看，不必为看一眼把问诊终结掉', async () => {
    // 改动前这个按钮叫「结束问诊」，把两件事绑死了：**想看看 AI 怎么说**
    // 和 **我问完了**。医生问三句想瞄一眼分析，就得先把问诊终结掉，
    // 要接着问还得再点一次「继续」。
    //
    // 判据取「暂停」这两个字：`finish()` 会把 state 置为 ended，
    // 那时按钮会变成「继续」。所以按钮还写着「暂停」= 问诊没被收掉。
    // 断言按钮**存在**是不够的 —— ended 态下它照样在。
    const wrapper = await mountWithPatient()
    await startInterview(wrapper)
    expect(wrapper.find('.action-bar .ib-secondary').text()).toBe('暂停')

    await wrapper.find('.action-bar .ib-primary').trigger('click')
    await vi.waitFor(() =>
      expect((wrapper.vm as unknown as { finishing: boolean }).finishing).toBe(false),
    )
    expect(wrapper.find('.action-bar .ib-secondary').text()).toBe('暂停')
  })

  it('暂停与继续是同一个按钮来回切，且从不禁用', async () => {
    const wrapper = await mountWithPatient()
    await startInterview(wrapper)
    const btn = () => wrapper.find('.action-bar .ib-secondary')

    expect(btn().text()).toBe('暂停')
    expect(btn().attributes('disabled')).toBeUndefined()
    await btn().trigger('click')
    expect(btn().text()).toBe('继续')
    await btn().trigger('click')
    expect(btn().text()).toBe('暂停')
    expect(btn().attributes('disabled')).toBeUndefined()
  })
})

describe('AI 追问提示浮框 · 三态与实时清单', () => {
  const THREE = ['夜尿次数有增多吗？', '胸闷与活动有关吗？', '家族里有心脏病史吗？']

  /** 起一场问诊，等浮框自动浮出（攒够 3 条对话） */
  async function withHints(questions: string[]) {
    const wrapper = await mountWithPatient()
    await startInterview(wrapper, questions)
    // 对话按 1.4s/条播，攒够 AUTO_OPEN_AFTER_MESSAGES 条要 4s 以上 ——
    // 用它的每条用例都要显式放宽超时（第三个参数），默认 5s 不够
    await vi.waitFor(
      () => expect(wrapper.find('.hint-float').exists()).toBe(true),
      { timeout: 12000 },
    )
    return wrapper
  }

  it('**攒够 3 条对话才自动浮出** —— 一开始就弹时一条都没划掉，像在催人', async () => {
    const wrapper = await mountWithPatient()
    await startInterview(wrapper, THREE)
    // 起手第一条刚播出来时不该有浮框
    expect(wrapper.find('.hint-float').exists()).toBe(false)
    await vi.waitFor(
      () => expect(wrapper.find('.hint-float').exists()).toBe(true),
      { timeout: 12000 },
    )
  }, 20000)

  it('缩小成胶囊后仍带条数 —— 缩小是「先放一边」，不是「看不见了」', async () => {
    const wrapper = await withHints(THREE)
    await wrapper.find('.hf-btn[title="缩小"]').trigger('click')

    expect(wrapper.find('.hint-float.mini').exists()).toBe(true)
    expect(wrapper.find('.hf-body').exists()).toBe(false)
    // 角标是**还没问**的条数，不是总数
    expect(wrapper.find('.hf-count').text()).toBe('3')
  }, 20000)

  it('胶囊点一下弹回展开态', async () => {
    const wrapper = await withHints(THREE)
    await wrapper.find('.hf-btn[title="缩小"]').trigger('click')
    await wrapper.find('.hf-pill').trigger('click')

    expect(wrapper.find('.hint-float.mini').exists()).toBe(false)
    expect(wrapper.findAll('.hf-item')).toHaveLength(3)
  }, 20000)

  it('关掉之后本轮不再自动弹 —— 否则对话一推进就弹回来，等于关不掉', async () => {
    const wrapper = await withHints(THREE)
    await wrapper.find('.hf-btn[title^="关闭"]').trigger('click')
    expect(wrapper.find('.hint-float').exists()).toBe(false)

    // 再走一次产品路径（点生成），它必须保持关着
    await wrapper.find('.action-bar .ib-primary').trigger('click')
    await vi.waitFor(() =>
      expect((wrapper.vm as unknown as { finishing: boolean }).finishing).toBe(false),
    )
    expect(wrapper.find('.hint-float').exists()).toBe(false)
  }, 20000)

  it('**已问到的划掉、留在底下**，不删除 —— 医生要能看见「问过了」', async () => {
    const { api } = await import('../api')
    const wrapper = await mountWithPatient()
    await startInterview(wrapper, THREE)
    vi.spyOn(api, 'followUpCoverage').mockResolvedValue({
      covered: [{ question: THREE[0], quote: '夜里要起来两三趟' }],
      provider: 'x', degraded: false,
    } as never)

    await vi.waitFor(
      () => expect(wrapper.find('.hf-done').exists()).toBe(true),
      { timeout: 12000 },
    )
    expect(wrapper.find('.hf-done-text').text()).toBe(THREE[0])
    // 划掉的不再占「还没问」的序号，但仍在 DOM 里
    expect(wrapper.findAll('.hf-item')).toHaveLength(2)
    // 原话挂在 title 上：医生想核对「凭什么算问到了」时能当场看到
    expect(wrapper.find('.hf-done').attributes('title')).toBe('夜里要起来两三趟')
  }, 20000)

  it('进度显示 已问到/总数', async () => {
    const wrapper = await withHints(THREE)
    expect(wrapper.find('.hf-progress').text()).toBe('0/3')
  }, 20000)

  it('措辞压住：底部写明「供参考」，不是一份必须问的清单', async () => {
    // 这个功能撤过一次，理由是「一期没有临床知识库，做不准，对医生是干扰」。
    // 那条理由没有失效 —— 一个做不准的建议，语气越肯定伤害越大。
    const wrapper = await withHints(THREE)
    expect(wrapper.find('.hf-foot').text()).toContain('供参考')
    expect(wrapper.find('.hint-float').text()).not.toContain('必须追问')
  }, 20000)
})

describe('AI 助手收起时不挡 HIS', () => {
  it('「待问诊后展开」占位卡必须没有 —— 它 flex:1 铺满整列，把 HIS 盖死了', async () => {
    // 这条不是审美问题：那张卡是实体块，医生点底下的 HIS 点不动。
    // 断言用类名而不是文案 —— 文案改一个字就漏过去了。
    const wrapper = await renderFloat()
    const handle = wrapper.find('.assistant-handle')
    if (handle.exists() && wrapper.find('.tips-drawer').exists()) {
      await handle.trigger('click')
      await wrapper.vm.$nextTick()
    }
    expect(wrapper.find('.assistant-placeholder').exists()).toBe(false)
    expect(wrapper.find('.assistant-toggle').exists()).toBe(false)
  })
})
