import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import AiEmrFloat from './AiEmrFloat.vue'

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

/** 组件挂载时会拉专项评估目录，其余接口按需返回空壳 */
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('assessment')) {
        return new Response(JSON.stringify({ categories: [] }), { status: 200 })
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
