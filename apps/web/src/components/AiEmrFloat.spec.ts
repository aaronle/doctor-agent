import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { mount } from '@vue/test-utils'
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

/** 组件挂载时会拉专项评估目录，其余接口按需返回空壳 */
function stubFetch(quality?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
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
  return wrapper
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

  it('只关抽屉、面板还开着 → 不出浮动按钮，靠面板上的 ‹ › 唤回', async () => {
    const wrapper = await renderFloat()
    await wrapper.find('.tips-close').trigger('click')

    // 原件实测就是这个行为：面板边缘的 toggle 已经能唤回抽屉，
    // 这时再挂一个浮动按钮属于凭空加 UI。
    expect(wrapper.find('.ai-float-btn').exists()).toBe(false)
    expect(wrapper.find('.solo-tips-open-btn').exists()).toBe(false)

    const toggle = wrapper.find('.panel-tips-toggle')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')
    expect(wrapper.find('.tips-drawer').exists()).toBe(true)
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
    useWorkstation(pinia).patientId = 'P001'
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
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
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.qc-item').exists()).toBe(false)
  })

  it('审阅是记录一次确认，不是把遗漏抹掉', async () => {
    const wrapper = await openQc()
    await wrapper.find('.rc-side-more').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.qc-reviewed-btn').exists()).toBe(true))
    await wrapper.find('.qc-reviewed-btn').trigger('click')
    await wrapper.vm.$nextTick()

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
    useWorkstation(pinia).patientId = 'P001'
    await vi.waitFor(() => expect(wrapper.find('.ai-emr-root').exists()).toBe(true))
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
