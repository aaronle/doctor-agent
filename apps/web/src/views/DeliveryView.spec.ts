import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import DeliveryView from './DeliveryView.vue'
import MobileDelivery from '../mobile/MobileDelivery.vue'
import { stubMatchMedia } from '../mobile/testFixtures'

/**
 * 交付平台。桌面与移动共用一份状态，所以两边的用例放在一起。
 *
 * 盯的是**这个界面存在的理由**能不能兑现：
 *   - 两条线并排、不合并；
 *   - 通过率不脱离分母；
 *   - 部署不假装是平台执行的；
 *   - 「回滚了」和「点了回滚」不是一回事；
 *   - 平台自己挂了要与流水线挂了区分开。
 */

const FEATURE_RUN = {
  run_key: 'feature-5fa39e1-clean',
  lane: 'feature',
  title: '5fa39e1  fix(llm): 换 Sonnet 5 挖出的三个 bug',
  subtitle: '分支 main',
  status: 'deployed',
  stages: [
    { name: '改动', status: 'passed', detail: '9 个文件', elapsed_ms: 0 },
    { name: '类型与单测', status: 'passed', detail: '212 passed · 164 passed', elapsed_ms: 5200 },
    { name: '构建', status: 'passed', detail: 'dist 1.90 MB', elapsed_ms: 9000 },
    { name: '契约导出', status: 'passed', detail: 'OpenAPI 59 路径', elapsed_ms: 400 },
    { name: '界面还原度', status: 'passed', detail: '146 元素 · 差异 0', elapsed_ms: 252000 },
    { name: '类名覆盖率', status: 'passed', detail: '八页零缺失', elapsed_ms: 228000 },
    { name: '部署', status: 'running', detail: 'docker build', elapsed_ms: 372000 },
  ],
  meta: {
    commit: '5fa39e1',
    branch: 'main',
    subject: 'fix(llm): 换 Sonnet 5 挖出的三个 bug',
    dirty_files: 9,
    gates: [
      { key: 'typecheck', label: '类型检查', stage: '类型与单测', ok: true, detail: 'vue-tsc 通过 · 0 error', elapsed_ms: 20000 },
      { key: 'test:web', label: '前端单测', stage: '类型与单测', ok: true, detail: '212 passed', elapsed_ms: 3400 },
      { key: 'coverage', label: '类名覆盖率', stage: '类名覆盖率', ok: true, detail: '八页零缺失', elapsed_ms: 228000 },
    ],
    log: [
      ['02:38', 'ERROR: agentscope requires mcp<1.28', 'err'],
      ['02:38', '→ 已锁 mcp==1.27.1', 'fix'],
      ['06:12', ' doctor-agent  Built', 'ok'],
    ],
  },
  started_at: '2026-09-02T14:11:00Z',
  updated_at: '2026-09-02T14:20:00Z',
}

const AGENT_RUN = {
  run_key: 'risk@abc123',
  lane: 'agent',
  title: '风险管理 · 岗位层 Prompt v4 草稿',
  subtitle: '对比基线 v3',
  status: 'blocked',
  stages: [
    { name: '改动', status: 'passed', detail: '', elapsed_ms: 0 },
    { name: '装配自检', status: 'passed', detail: '', elapsed_ms: 800 },
    { name: '并排对比', status: 'passed', detail: '', elapsed_ms: 41000 },
    { name: '回归集', status: 'failed', detail: '10/13', elapsed_ms: 92000 },
    { name: '发布', status: 'idle', detail: '', elapsed_ms: 0 },
  ],
  meta: {
    pass_rate: { passed: 10, total: 13 },
    regressions: [
      { case: '危急值必须逐条标来源', reason: '三条风险里有一条没写来源，硬规则与模型判定分不开' },
      { case: '未问诊不写否认', reason: '输出里出现「否认胸痛」，本次问诊没问过这一项' },
    ],
  },
  started_at: '2026-09-02T11:00:00Z',
  updated_at: '2026-09-02T11:04:00Z',
}

const PIPELINES = {
  lanes: { feature: FEATURE_RUN, agent: AGENT_RUN },
  deploy_executor: 'local',
  deploy_note: '平台负责触发与观测，不持有生产凭据；部署仍走开发机的 SSH + rsync + docker。',
}

const RELEASES = {
  items: [
    {
      kind: 'feature', ref: '5fa39e1', title: '5fa39e1 换 Sonnet 5 挖出的三个 bug',
      detail: '212 前端 + 164 后端', status: 'current', at: '2026-09-02T14:20:00Z',
      can_rollback: false, meta: {},
    },
    {
      kind: 'agent', ref: '7', title: '风险管理 · 岗位层 Prompt v3',
      detail: '回归集 13/13', status: 'superseded', at: '2026-09-02T11:40:00Z',
      can_rollback: true, meta: { agent_key: 'risk', version: 'v3', model_tier: 'clinical_fast' },
    },
    {
      kind: 'feature', ref: 'b196ddc', title: 'b196ddc 问诊门禁三处漏洞',
      detail: '客观数据拆出独立端点', status: 'superseded', at: '2026-09-01T22:30:00Z',
      can_rollback: true, meta: {},
    },
  ],
  rollback_semantics: {
    feature: '换镜像 tag 重建容器，几十秒。平台不持有生产凭据，只给出命令。',
    agent: '把某个历史版本重新置为 published，下一次调用即生效，不重启、不换镜像。',
  },
}

const PRODUCTION = {
  from_image: {
    release: '0.3.0-mvp', commit: '5fa39e1', image: 'doctor-agent:0.3.0-mvp',
    released_at: '2026-09-02T14:20:00Z', runtime_mode: 'live', write_back_mode: 'local',
    model_fast: 'claude-sonnet-5', model_smart: 'claude-sonnet-5',
    model_orchestration: 'claude-sonnet-5', ai: 'configured', timeout_ms: 90000,
  },
  from_database: {
    agents: [
      { agent_key: 'risk', label: '风险管理', version: 'v3', model_tier: 'clinical_fast', published_at: '2026-09-02T11:40:00Z', source: 'database' },
      { agent_key: 'record', label: '病历生成', version: '—', model_tier: '—', published_at: null, source: 'code_default' },
    ],
    datasets_enabled: 3,
    datasets_disabled: 2,
  },
  note: '镜像栏换镜像才会变；数据库栏不重启即可变。',
  at: '2026-09-02T14:31:00Z',
}

function stubFetch(overrides: Record<string, unknown> = {}) {
  const mock = vi.fn(async (url: string) => {
    const u = String(url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    for (const [fragment, body] of Object.entries(overrides)) {
      if (u.includes(fragment)) {
        return body instanceof Response ? body.clone() : json(body)
      }
    }
    if (u.includes('/api/delivery/pipelines')) return json(PIPELINES)
    if (u.includes('/api/delivery/releases')) return json(RELEASES)
    if (u.includes('/api/delivery/production')) return json(PRODUCTION)
    if (u.includes('/rollback')) return json({ ok: true })
    return json({})
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:p(.*)', component: { template: '<div/>' } }],
})

async function render(mobile = false, overrides: Record<string, unknown> = {}) {
  stubMatchMedia(mobile)
  const mock = stubFetch(overrides)
  const wrapper = mount(mobile ? MobileDelivery : DeliveryView, {
    global: { plugins: [createPinia(), router, ElementPlus] },
    attachTo: document.body,
  })
  // 三个接口是 Promise.all 一起发的。只等 nextTick 不够 —— 它推进的是渲染队列，
  // 不是这条 promise 链；等不到就会拿着还没填的 null 去断言，报出来的错还长得像
  // 「接口没返数据」。等 fetch 都发出去，再 flush 整条微任务链。
  await vi.waitFor(() => expect(mock.mock.calls.length).toBeGreaterThanOrEqual(3))
  await flushPromises()
  await flushPromises()
  return { wrapper, mock }
}

async function goTab(wrapper: VueWrapper, label: string) {
  const sel = wrapper.findAll('.delivery-tab').length ? '.delivery-tab' : '.md-tab'
  await wrapper.findAll(sel).find((t) => t.text().includes(label))!.trigger('click')
  await wrapper.vm.$nextTick()
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------- 桌面

describe('交付平台 · 两条线并排', () => {
  it('看板同屏显示功能线与智能体线，各自独立判定', async () => {
    const { wrapper } = await render()
    const lanes = wrapper.findAll('.lane-card')
    expect(lanes).toHaveLength(2)
    expect(lanes[0].text()).toContain('功能线')
    expect(lanes[1].text()).toContain('智能体线')
    // 同一时刻一条在跑、一条被挡 —— 合并成一条流水线就表达不出这个状态
    expect(lanes[0].text()).toContain('deployed')
    expect(lanes[1].text()).toContain('blocked')
  })

  it('两条线的阶段各不相同：功能线有构建，智能体线有回归集', async () => {
    const { wrapper } = await render()
    const [feature, agent] = wrapper.findAll('.lane-card')
    expect(feature.text()).toContain('构建')
    expect(feature.text()).not.toContain('回归集')
    expect(agent.text()).toContain('回归集')
    expect(agent.text()).not.toContain('契约导出')
  })

  it('通过率必须带分母，不显示光秃秃的百分比', async () => {
    const { wrapper } = await render()
    const agent = wrapper.findAll('.lane-card')[1]
    expect(agent.text()).toContain('10/13')
    // 13 条的 77% 和 130 条的 77% 是两回事
    expect(agent.text()).not.toMatch(/\b77\s*%/)
  })

  it('未开始的阶段照样列出来，让人看得出后面还有几关', async () => {
    const { wrapper } = await render()
    const agent = wrapper.findAll('.lane-card')[1]
    const idle = agent.findAll('.stage-row.tone-idle')
    expect(idle.length).toBeGreaterThan(0)
    expect(idle.map((r) => r.text()).join()).toContain('发布')
  })
})

describe('交付平台 · 功能制品', () => {
  it('门禁逐项展开，比看板的粗粒度阶段更细', async () => {
    const { wrapper } = await render()
    await goTab(wrapper, '功能制品')
    const gates = wrapper.findAll('.gate-row')
    expect(gates.length).toBe(3)
    expect(gates[0].text()).toContain('类型检查')
    expect(gates[1].text()).toContain('212 passed')
  })

  it('两道界面闸的分工写在界面上，不只写在文档里', async () => {
    const { wrapper } = await render()
    await goTab(wrapper, '功能制品')
    const text = wrapper.text()
    expect(text).toContain('还原度')
    expect(text).toContain('类名覆盖率')
    expect(text).toContain('整块漏做')
  })

  it('构建日志保留上一轮真踩过的错误行，并按语气着色', async () => {
    const { wrapper } = await render()
    await goTab(wrapper, '功能制品')
    expect(wrapper.find('.console').exists()).toBe(true)
    expect(wrapper.findAll('.log-err').length).toBe(1)
    expect(wrapper.findAll('.log-fix').length).toBe(1)
    expect(wrapper.find('.log-fix').text()).toContain('mcp==1.27.1')
  })
})

describe('交付平台 · 智能体制品', () => {
  it('回归集失败必须写清理由 —— 智能体的失败不自明', async () => {
    const { wrapper } = await render()
    await goTab(wrapper, '智能体制品')
    const rows = wrapper.findAll('.regression-row')
    expect(rows).toHaveLength(2)
    // 只给红叉没有用：为什么算失败才是能拿去改的东西
    expect(rows[0].find('.regression-reason').text()).toContain('没写来源')
    expect(rows[1].find('.regression-reason').text()).toContain('否认胸痛')
  })
})

describe('交付平台 · 发布历史', () => {
  it('两种制品混在同一条时间线上，按时间倒序', async () => {
    const { wrapper } = await render()
    await goTab(wrapper, '发布历史')
    const rows = wrapper.findAll('.release-row')
    expect(rows).toHaveLength(3)
    // 中间那条是智能体 —— 分成两个页签就看不出「谁先动的」
    expect(rows[1].text()).toContain('智能体')
    expect(rows[0].text()).toContain('当前生产')
  })

  it('当前生产那一条没有回滚按钮', async () => {
    const { wrapper } = await render()
    await goTab(wrapper, '发布历史')
    expect(wrapper.findAll('.release-row')[0].findAll('button')).toHaveLength(0)
  })

  it('回滚的两种含义都写出来，不让人以为是一回事', async () => {
    const { wrapper } = await render()
    await goTab(wrapper, '发布历史')
    const text = wrapper.find('.semantics').text()
    expect(text).toContain('换镜像')
    expect(text).toContain('不重启')
  })

  it('生产指纹分两栏：镜像 tag 只说明了一半', async () => {
    const { wrapper } = await render()
    await goTab(wrapper, '发布历史')
    const cols = wrapper.findAll('.fp-col')
    expect(cols).toHaveLength(2)
    expect(cols[0].text()).toContain('claude-sonnet-5')
    expect(cols[1].text()).toContain('风险管理')
  })

  it('没有 published 记录的岗位标成「代码兜底」，不假装有版本', async () => {
    const { wrapper } = await render()
    await goTab(wrapper, '发布历史')
    const marked = wrapper.find('.fp-code-default')
    expect(marked.exists()).toBe(true)
    expect(marked.text()).toContain('代码兜底')
  })

  it('智能体回滚走控制台既有路径，不另开一条改同一张表', async () => {
    const { wrapper, mock } = await render()
    await goTab(wrapper, '发布历史')
    const btn = wrapper.findAll('.release-row')[1].find('button')
    await btn.trigger('click')
    await vi.waitFor(() => expect(document.querySelector('.el-message-box')).toBeTruthy())

    const confirm = [...document.querySelectorAll('.el-message-box__btns button')]
      .find((b) => b.textContent?.includes('确认回滚')) as HTMLElement
    confirm.click()

    await vi.waitFor(() =>
      expect(mock.mock.calls.some(([u]) => String(u).includes('/api/admin/agents/risk/rollback/7'))).toBe(true),
    )
    // 不存在平行的 /api/delivery 回滚路径 —— 两条路径改同一张表，迟早有一条忘了改
    expect(mock.mock.calls.some(([u]) => String(u).includes('/api/delivery/releases/agent'))).toBe(false)
  })
})

describe('交付平台 · 诚实边界', () => {
  it('平台自己读取失败要与流水线失败区分开', async () => {
    const { wrapper } = await render(false, {
      '/api/delivery/pipelines': new Response('boom', { status: 500 }),
    })
    const err = wrapper.find('.delivery-error')
    expect(err.exists()).toBe(true)
    // 说清是平台的问题，别让人跑去查流水线
    expect(err.text()).toContain('不代表流水线的状态')
  })

  it('没有任何上报时不画空壳，而是告诉人怎么让它出现', async () => {
    const { wrapper } = await render(false, {
      '/api/delivery/pipelines': { lanes: { feature: null, agent: null }, deploy_executor: 'local', deploy_note: '' },
    })
    expect(wrapper.find('.lane-empty').text()).toContain('npm run verify')
  })
})

// ---------------------------------------------------------------- 移动端

describe('交付平台移动端', () => {
  it('底部四档，默认落在流水线', async () => {
    const { wrapper } = await render(true)
    expect(wrapper.findAll('.md-tab').map((t) => t.text().replace(/\s/g, '')))
      .toEqual(['📊流水线', '📦制品', '🕐历史', '🌐环境'])
    expect(wrapper.find('.md-tab.is-active').text()).toContain('流水线')
  })

  it('第一屏就写明只读，免得有人到处找编辑入口', async () => {
    const { wrapper } = await render(true)
    const note = wrapper.find('.md-note-blue').text()
    expect(note).toContain('回桌面')
    expect(note).toContain('改错了看不出来')
  })

  it('移动端不出现任何配置或 Prompt 编辑控件', async () => {
    const { wrapper } = await render(true)
    for (const tab of ['流水线', '制品', '历史', '环境']) {
      await goTab(wrapper, tab)
      expect(wrapper.findAll('textarea')).toHaveLength(0)
      expect(wrapper.findAll('input')).toHaveLength(0)
    }
  })

  it('保留回滚 —— 那是出事时最需要在手机上做的一件事', async () => {
    const { wrapper } = await render(true)
    await goTab(wrapper, '历史')
    const btns = wrapper.findAll('.md-btn')
    expect(btns.length).toBeGreaterThan(0)
    expect(btns[0].text()).toContain('回滚')
  })

  it('功能制品回滚在手机上不假装能执行', async () => {
    const { wrapper, mock } = await render(true)
    await goTab(wrapper, '历史')
    // 第三条是 superseded 的功能制品
    const featureBtn = wrapper.findAll('.md-card')
      .find((c) => c.text().includes('b196ddc'))!
      .find('.md-btn')
    await featureBtn.trigger('click')
    await vi.waitFor(() => expect(document.querySelector('.el-message-box')).toBeTruthy())
    expect(document.querySelector('.el-message-box')!.textContent).toContain('不持有生产凭据')
    expect(mock.mock.calls.some(([u]) => String(u).includes('rollback'))).toBe(false)
  })

  it('环境页把两栏都摆出来，包括代码兜底的标注', async () => {
    const { wrapper } = await render(true)
    await goTab(wrapper, '环境')
    expect(wrapper.text()).toContain('来自镜像')
    expect(wrapper.text()).toContain('来自数据库')
    expect(wrapper.find('.md-code-default').text()).toContain('代码兜底')
  })

  it('环境页说明部署不是平台执行的', async () => {
    const { wrapper } = await render(true)
    await goTab(wrapper, '环境')
    expect(wrapper.text()).toContain('不持有生产凭据')
  })
})

describe('交付平台 · 通过率的颜色', () => {
  it('全过了标绿，不标成看着像出事的橙色', async () => {
    const { wrapper } = await render(false, {
      '/api/delivery/pipelines': {
        ...PIPELINES,
        lanes: {
          feature: FEATURE_RUN,
          agent: { ...AGENT_RUN, status: 'passed', meta: { ...AGENT_RUN.meta, pass_rate: { passed: 13, total: 13 }, regressions: [] } },
        },
      },
    })
    const rate = wrapper.findAll('.lane-card')[1].find('.lane-rate')
    expect(rate.text()).toContain('13/13')
    expect(rate.classes()).toContain('is-clean')
  })

  it('没全过就不标绿 —— 分母照样带着', async () => {
    const { wrapper } = await render()
    const rate = wrapper.findAll('.lane-card')[1].find('.lane-rate')
    expect(rate.text()).toContain('10/13')
    expect(rate.classes()).not.toContain('is-clean')
  })
})
