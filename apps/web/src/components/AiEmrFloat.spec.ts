import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import AiEmrFloat from './AiEmrFloat.vue'
import { useWorkstation } from '../stores/workstation'

/** ＋ 菜单五项的原文与图标，顺序即 V4.3 顺序，不可改 */
const PLUS_ITEMS = [
  ['📎', '上传文件'],
  ['🖼', '上传图片'],
  ['💬', '常用提示词'],
  ['👥', '患者管理'],
  ['⚡', '技能管理'],
]

/** 常用提示词五条原文，逐字取自 V4.3，不可改写 */
const PROMPTS = [
  '请根据检查结果给出初步诊断',
  '请分析患者的用药风险',
  '请评估该患者的并发症风险',
  '请生成门诊随访计划',
  '请解读最近一次血糖报告',
]

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
    const wrapper = await renderFloat()
    expect(wrapper.find('.ai-float-btn').exists()).toBe(false)
    expect(wrapper.find('.solo-tips-open-btn').exists()).toBe(false)
  })

  it('只关抽屉、面板还开着 → 不出浮动按钮，靠医生智能体里的开关卡片唤回', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tips-close').trigger('click')

    // 面板里的开关卡片已经能唤回抽屉，这时再挂一个浮动按钮属于凭空加 UI。
    expect(wrapper.find('.ai-float-btn').exists()).toBe(false)
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

  it('抽屉和面板都关 → 显示圆形 AI 钮', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tips-close').trigger('click')
    await wrapper.find('.panel-close').trigger('click')

    const round = wrapper.find('.ai-float-btn')
    expect(round.exists()).toBe(true)
    expect(round.find('.float-icon').text()).toBe('AI')
    expect(round.find('.float-ready-dot').exists()).toBe(true)
    expect(wrapper.find('.solo-tips-open-btn').exists()).toBe(false)
  })

  it('点唤出按钮能把抽屉找回来 —— 否则关掉就是死路', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tips-close').trigger('click')
    await wrapper.find('.panel-close').trigger('click')
    expect(wrapper.find('.tips-drawer').exists()).toBe(false)

    await wrapper.find('.ai-float-btn').trigger('click')
    expect(wrapper.find('.tips-drawer').exists()).toBe(true)
    // 唤回后按钮自己让位
    expect(wrapper.find('.ai-float-btn').exists()).toBe(false)
  })
})

describe('＋ 菜单', () => {
  it('默认收起，点 ＋ 才展开', async () => {
    const wrapper = await renderFloat()
    expect(wrapper.find('.plus-menu').exists()).toBe(false)

    await wrapper.find('.tb-plus-btn').trigger('click')
    expect(wrapper.find('.plus-menu').exists()).toBe(true)
  })

  it('五项的顺序、文案与图标都按原件', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tb-plus-btn').trigger('click')

    const items = wrapper.findAll('.plus-menu .pm-item')
    expect(items).toHaveLength(PLUS_ITEMS.length)
    PLUS_ITEMS.forEach(([icon, label], i) => {
      expect(items[i].text()).toContain(icon)
      expect(items[i].text()).toContain(label)
    })
  })

  it('二级菜单要点一下才出来，五条提示词逐字对齐原件', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tb-plus-btn').trigger('click')
    expect(wrapper.find('.pm-prompts').exists()).toBe(false)

    await wrapper.find('.pm-submenu-trigger').trigger('click')
    const prompts = wrapper.findAll('.pm-prompt-item')
    expect(prompts.map((p) => p.text())).toEqual(PROMPTS)
  })

  it('再点一次收起二级菜单', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tb-plus-btn').trigger('click')
    await wrapper.find('.pm-submenu-trigger').trigger('click')
    expect(wrapper.find('.pm-prompts').exists()).toBe(true)

    await wrapper.find('.pm-submenu-trigger').trigger('click')
    expect(wrapper.find('.pm-prompts').exists()).toBe(false)
  })

  it('选中提示词后菜单关闭，文本进入输入框', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tb-plus-btn').trigger('click')
    await wrapper.find('.pm-submenu-trigger').trigger('click')
    await wrapper.findAll('.pm-prompt-item')[1].trigger('click')

    expect(wrapper.find('.plus-menu').exists()).toBe(false)
    expect((wrapper.find('.chat-textarea-wrap textarea').element as HTMLTextAreaElement).value)
      .toBe('请分析患者的用药风险')
  })

  it('「患者管理」跳路由而不是在浮层里开页面', async () => {
    const wrapper = await renderFloat()
    const push = vi.spyOn(router, 'push')
    await wrapper.find('.tb-plus-btn').trigger('click')
    await wrapper.findAll('.plus-menu .pm-item')[3].trigger('click')

    expect(push).toHaveBeenCalledWith('/outpatient/manage')
  })

  it('上传只回显不落存储 —— 一期不接收真实患者文件', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tb-plus-btn').trigger('click')
    await wrapper.findAll('.plus-menu .pm-item')[0].trigger('click')

    // 不得因为「上传」向后端发任何请求
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.every((c) => !String(c[0]).includes('upload'))).toBe(true)
  })

  it('点页面别处收起菜单，点菜单自身不收起', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tb-plus-btn').trigger('click')
    expect(wrapper.find('.plus-menu').exists()).toBe(true)

    // 点菜单内部不该把自己关掉 —— 否则二级菜单永远展不开
    await wrapper.find('.plus-menu').trigger('click')
    expect(wrapper.find('.plus-menu').exists()).toBe(true)

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.plus-menu').exists()).toBe(false)
  })

  it('重开菜单时二级菜单回到收起态', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tb-plus-btn').trigger('click')
    await wrapper.find('.pm-submenu-trigger').trigger('click')
    expect(wrapper.find('.pm-prompts').exists()).toBe(true)

    await wrapper.find('.tb-plus-btn').trigger('click')   // 收起
    await wrapper.find('.tb-plus-btn').trigger('click')   // 再展开
    expect(wrapper.find('.plus-menu').exists()).toBe(true)
    expect(wrapper.find('.pm-prompts').exists()).toBe(false)
  })
})

describe('技能管理', () => {
  it('从 ＋ 菜单打开，带原件的说明文案', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tb-plus-btn').trigger('click')
    await wrapper.findAll('.plus-menu .pm-item')[4].trigger('click')
    await vi.waitFor(() => expect(document.querySelector('.skill-manage-dialog')).toBeTruthy())

    const dialog = document.querySelector('.skill-manage-dialog')!
    expect(dialog.querySelector('.sm-hint')!.textContent).toContain(
      '维护个性化 Skills，启用后可在侧栏与 Copilot「/」菜单中使用',
    )
  })

  it('新建技能才展开表单，名称是必填', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tb-plus-btn').trigger('click')
    await wrapper.findAll('.plus-menu .pm-item')[4].trigger('click')
    await vi.waitFor(() => expect(document.querySelector('.skill-manage-dialog')).toBeTruthy())

    expect(document.querySelector('.sm-form-card')).toBeFalsy()

    const newBtn = [...document.querySelectorAll('.sm-toolbar button')]
      .find((b) => b.textContent?.includes('新建技能')) as HTMLButtonElement
    newBtn.click()
    await vi.waitFor(() => expect(document.querySelector('.sm-form-card')).toBeTruthy())

    expect(document.querySelector('.sm-form-title')!.textContent).toContain('新建技能')
    expect(document.querySelector('.sm-form input')!.getAttribute('placeholder')).toBe('如：糖尿病足筛查')
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

describe('AI 助手收起时的空状态', () => {
  /**
   * HIS 门面撤掉之后，AI 助手收起时它原来占的位置是整个页面最大的一块。
   * 空着会让人以为「页面没加载完」—— 而那正是这次改动最容易造成的观感事故。
   */
  it('收起时给一张说明卡，不是一片空白', async () => {
    stubFetch()
    const wrapper = mount(AiEmrFloat, {
      global: { plugins: [createPinia(), router, ElementPlus] },
      attachTo: document.body,
    })
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))

    const holder = wrapper.find('.assistant-placeholder')
    expect(holder.exists()).toBe(true)
    // 讲清「为什么现在没有结论」，而不只是一句「暂无数据」
    expect(holder.text()).toContain('由这一场问诊推导')
    // 两条出路都在
    const actions = holder.findAll('button').map((b) => b.text()).join('|')
    expect(actions).toContain('开始问诊')
    // 红线不受门禁这件事要说出来，否则医生会以为什么都没有
    expect(holder.text()).toContain('硬规则红色风险不受此门禁')
  })

  it('展开后空状态让位给抽屉 —— 两者互斥，不叠在一起', async () => {
    const wrapper = await renderFloat()
    expect(wrapper.find('.tips-drawer').exists()).toBe(true)
    expect(wrapper.find('.assistant-placeholder').exists()).toBe(false)
  })
})

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
