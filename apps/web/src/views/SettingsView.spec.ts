import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import SettingsView from './SettingsView.vue'
import MobileSettings from '../mobile/MobileSettings.vue'
import { stubMatchMedia } from '../mobile/testFixtures'
import { FALLBACK_DEFAULTS } from '../composables/usePreferences'

/**
 * 个人配置页。桌面与移动共用一份状态，所以两边的用例放在一起。
 *
 * 盯的是**这个界面存在的理由**能不能兑现：
 *   - 改动即时生效，没有「保存」按钮；
 *   - 色调预览里必须有风险条 —— 它是「状态色不随主题变」的当场证据；
 *   - 「完全关闭」的说明必须写清楚它不影响危急值；
 *   - 移动端**不出现**「工作区布局」整组。
 *
 * 这一页不在 V4.3 原件里，两道界面闸不比对它，只能靠这些用例守。
 */

vi.mock('../api', () => ({
  fetchPreferenceOptions: vi.fn(),
  fetchPreferences: vi.fn(),
  savePreferences: vi.fn(),
  resetPreferences: vi.fn(),
}))

const api = await import('../api')

const OPTIONS = {
  version: 1,
  themes: ['default', 'eyecare', 'contrast'],
  font_levels: ['small', 'normal', 'large', 'xlarge'],
  follow_up_modes: ['auto', 'always', 'manual', 'off'],
  window_bounds: { panel_width: [260, 560] as [number, number] },
  defaults: FALLBACK_DEFAULTS,
}

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:p(.*)', component: { template: '<div/>' } }],
})

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  vi.mocked(api.fetchPreferenceOptions).mockResolvedValue(OPTIONS)
  vi.mocked(api.fetchPreferences).mockResolvedValue({
    actor: '张医生',
    prefs: { ...FALLBACK_DEFAULTS },
  })
  vi.mocked(api.savePreferences).mockImplementation(async (_a, patch) => ({
    ok: true,
    actor: '张医生',
    prefs: { ...FALLBACK_DEFAULTS, ...patch, windows: { ...(patch.windows ?? {}) } },
  }))
})

async function render(mobile = false) {
  stubMatchMedia(mobile)
  const wrapper = mount(mobile ? MobileSettings : SettingsView, {
    global: { plugins: [createPinia(), router, ElementPlus] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

describe('配置页 · 桌面', () => {
  it('三个分组都在：外观 / 医生智能体 / 工作区布局', async () => {
    const text = (await render()).text()
    expect(text).toContain('外观')
    expect(text).toContain('医生智能体')
    expect(text).toContain('工作区布局')
  })

  it('**没有「保存」按钮** —— 偏好是低风险可逆的单人操作，加一步确认是多余的', async () => {
    const wrapper = await render()
    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels.some((t) => t.includes('保存'))).toBe(false)
  })

  it('点一下色调就落库，不等任何确认', async () => {
    const wrapper = await render()
    const eyecare = wrapper.findAll('.tone-option').find((b) => b.text().includes('护眼'))
    await eyecare!.trigger('click')
    await flushPromises()
    expect(api.savePreferences).toHaveBeenCalledWith('张医生', { theme: 'eyecare' })
  })

  it('预览区里必须有风险条 —— 它是「状态色不随主题变」的当场证据', async () => {
    // 三个色块不足以让人判断换完长什么样，更说明不了红色不会跟着变。
    // 哪天有人把这块删了，医生就没法在切换前确认危急值仍是红的。
    const wrapper = await render()
    const risk = wrapper.find('.preview-risk')
    expect(risk.exists()).toBe(true)
    expect(risk.text()).toContain('红色·紧急')
  })

  it('AI 追问四档齐全，且「完全关闭」写明不影响危急值', async () => {
    const wrapper = await render()
    const items = wrapper.findAll('.radio-item').map((n) => n.text())
    expect(items.length).toBe(4)
    expect(items.join()).toContain('不发起模型调用')
    expect(wrapper.find('.safety-note').text()).toContain('不能选择不看危急值')
  })

  it('没记住布局时「恢复默认布局」是禁用的', async () => {
    const wrapper = await render()
    const btn = wrapper.findAll('.ghost-btn').find((b) => b.text().includes('恢复默认布局'))
    expect(btn!.attributes('disabled')).toBeDefined()
  })

  it('枚举来自后端：多一档主题就多一个选项', async () => {
    vi.mocked(api.fetchPreferenceOptions).mockResolvedValue({
      ...OPTIONS,
      themes: ['default', 'eyecare', 'contrast', 'dark'],
    })
    const wrapper = await render()
    expect(wrapper.findAll('.tone-option').length).toBe(4)
  })
})

describe('配置页 · 移动端是另一套 IA', () => {
  it('≤768px 挂载的是移动端组件，不是桌面的重排', async () => {
    const wrapper = await render(true)
    expect(wrapper.find('.ms-page').exists()).toBe(true)
    expect(wrapper.find('.settings-page').exists()).toBe(false)
  })

  it('**不显示「工作区布局」整组** —— 手机上没有可拖拽浮窗', async () => {
    const wrapper = await render(true)
    expect(wrapper.text()).not.toContain('记住浮窗尺寸与位置')
    // 但要解释一句，免得医生到处找
    expect(wrapper.text()).toContain('可在电脑上重置')
  })

  it('一级是列表，点进去才选 —— 不把三档平铺在首屏', async () => {
    const wrapper = await render(true)
    expect(wrapper.findAll('.ms-cell').length).toBeGreaterThan(0)
    expect(wrapper.find('.ms-swatch').exists()).toBe(false)

    const cell = wrapper.findAll('.ms-cell').find((c) => c.text().includes('界面色调'))
    await cell!.trigger('click')
    expect(wrapper.findAll('.ms-swatch').length).toBe(3)
  })

  it('色调二级页也有风险条预览', async () => {
    const wrapper = await render(true)
    const cell = wrapper.findAll('.ms-cell').find((c) => c.text().includes('界面色调'))
    await cell!.trigger('click')
    expect(wrapper.find('.ms-risk').text()).toContain('状态色不随主题变')
  })
})

describe('配置页 · 后端不可达仍可用', () => {
  it('拉取失败时页面照常打开，并明确提示本机仍有效', async () => {
    vi.mocked(api.fetchPreferences).mockRejectedValue(new Error('Failed to fetch'))
    const wrapper = await render()
    expect(wrapper.find('.settings-card').exists()).toBe(true)
    expect(wrapper.find('.sync-warn').exists()).toBe(true)
  })
})
