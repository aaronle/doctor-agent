import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { router } from './router'
import { DEFAULT_DOCTOR, useSession } from './stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('路由 · 一期无登录', () => {
  it('根路径直接进候诊列表，不再经过登录页', async () => {
    await router.push('/')
    await router.isReady()
    expect(router.currentRoute.value.path).toBe('/outpatient/list')
  })

  it('老书签 /login 重定向到候诊列表，而不是 404', async () => {
    // 演示链接可能已经发出去了，硬 404 比重定向糟
    await router.push('/login')
    expect(router.currentRoute.value.path).toBe('/outpatient/list')
  })

  it('路由表里不再有 Login 这个命名路由', () => {
    expect(router.getRoutes().map((r) => r.name).filter(Boolean)).not.toContain('Login')
  })

  it('未登录也能直达工作站 —— 没有鉴权守卫了', async () => {
    await router.push('/outpatient/P001')
    expect(router.currentRoute.value.path).toBe('/outpatient/P001')
  })

  it('控制台仍然可直达（演示阶段有意公开）', async () => {
    await router.push('/admin')
    expect(router.currentRoute.value.path).toBe('/admin')
  })

  it('交付平台可直达，与控制台同口径', async () => {
    await router.push('/delivery')
    expect(router.currentRoute.value.path).toBe('/delivery')
    expect(document.title).toContain('交付平台')
  })

  it('交付平台不占用 V4.3 定义的五个医生端页面', () => {
    // /delivery 与 /admin 一样，是面向研发与调优的页面。
    // 一旦挂到 /outpatient/* 下面，还原度与类名覆盖率两道闸就会开始比它 ——
    // 而它压根不在 V4.3 原件里，比出来的「缺失」全是噪声。
    const doctorPages = router.getRoutes()
      .map((r) => r.path)
      .filter((p) => p.startsWith('/outpatient'))
    expect(doctorPages).not.toContain('/delivery')
    expect(doctorPages.some((p) => p.includes('delivery'))).toBe(false)
  })

  it('页面标题跟着路由走', async () => {
    await router.push('/outpatient/manage')
    expect(document.title).toContain('患者管理')
  })
})

describe('会话 store', () => {
  it('没有存过名字时给默认接诊医生 —— 页头不能空着', () => {
    sessionStorage.clear()
    expect(useSession().doctorName).toBe(DEFAULT_DOCTOR)
  })

  it('setDoctor 落 sessionStorage，空串回落默认值', () => {
    const session = useSession()
    session.setDoctor('李医生')
    expect(session.doctorName).toBe('李医生')
    expect(sessionStorage.getItem('doctor-agent.session')).toBe('李医生')

    session.setDoctor('')
    expect(session.doctorName).toBe(DEFAULT_DOCTOR)
  })

  it('不再暴露 login / logout —— 没有登录态可言', () => {
    const session = useSession() as unknown as Record<string, unknown>
    expect(session.login).toBeUndefined()
    expect(session.logout).toBeUndefined()
    expect(session.loggedIn).toBeUndefined()
  })
})
