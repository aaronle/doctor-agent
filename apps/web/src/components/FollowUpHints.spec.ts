import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import FollowUpHints from './FollowUpHints.vue'

/** AI 追问提示浮框的显示规则。逻辑在 `useFollowUp.spec.ts`，这里只管渲染与交互。 */

const ITEMS = [
  { question: '疼多久了？', quote: '', done: false },
  { question: '有没有药物过敏？', quote: '用头孢起过疹子', done: true },
  { question: '夜里疼得醒吗？', quote: '', done: false },
]

function mountHints(minimized = false) {
  return mount(FollowUpHints, { props: { items: ITEMS, minimized }, attachTo: document.body })
}

describe('追问提示浮框 · 渲染', () => {
  it('没问的按序号列，已问到的划掉并留在底下', () => {
    const w = mountHints()
    expect(w.findAll('.hf-item')).toHaveLength(2)
    expect(w.findAll('.hf-done')).toHaveLength(1)
    // 已问到的**不删除** —— 医生要能看见「问过了」，那也是信息
    expect(w.find('.hf-done-text').text()).toBe('有没有药物过敏？')
  })

  it('已问到的把患者原话挂在 title 上 —— 医生要能核对凭什么算问到了', () => {
    const w = mountHints()
    expect(w.find('.hf-done').attributes('title')).toBe('用头孢起过疹子')
  })

  it('进度显示 已问到/总数', () => {
    expect(mountHints().find('.hf-progress').text()).toBe('1/3')
  })

  it('缩小态角标是**还没问**的条数，不是总数', () => {
    // 它要说的是「还欠几条」。写总数的话，全问完了角标还挂着一个 3。
    expect(mountHints(true).find('.hf-count').text()).toBe('2')
  })

  it('措辞压住：底部写明「供参考」', () => {
    // 这个功能撤过一次，理由是「做不准是干扰」——
    // 一个做不准的建议，语气越肯定伤害越大。
    expect(mountHints().find('.hf-foot').text()).toContain('供参考')
  })

  it('全问完时给一句话，不留空白', () => {
    const w = mount(FollowUpHints, {
      props: { items: ITEMS.map((i) => ({ ...i, done: true })), minimized: false },
    })
    expect(w.findAll('.hf-item')).toHaveLength(0)
    expect(w.find('.hf-allclear').exists()).toBe(true)
    // 全问完了角标就不该再挂着
    expect(w.find('.hf-count').exists()).toBe(false)
  })
})

describe('追问提示浮框 · 「下面还有」', () => {
  /** jsdom 没有布局，手动摆一个「装不下」的滚动容器 */
  function overflowing(w: ReturnType<typeof mountHints>, hidden: number) {
    const body = w.find('.hf-body').element as HTMLElement
    Object.defineProperty(body, 'scrollHeight', { value: 400, configurable: true })
    Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(body, 'scrollTop', { value: 0, writable: true, configurable: true })
    const nodes = [...body.querySelectorAll<HTMLElement>('.hf-item, .hf-done')]
    nodes.forEach((n, i) =>
      // 后 `hidden` 条排在可视区之下
      Object.defineProperty(n, 'offsetTop', {
        value: i >= nodes.length - hidden ? 300 : 10,
        configurable: true,
      }),
    )
    return body
  }

  it('装不下时给出「还有 N 条」，并给底部渐隐', async () => {
    // 第 6 条被切一半、而没有任何东西说明下面还有 —— 半截字看起来
    // 更像排版坏了，不像「可以往下滚」。字号调大之后更糟。
    const w = mountHints()
    const body = overflowing(w, 2)
    await w.find('.hf-body').trigger('scroll')

    expect(w.find('.hf-more').text()).toContain('还有 2 条')
    expect(body.classList.contains('has-more')).toBe(true)
  })

  it('滚到底就收起来 —— 一个永远亮着的「还有更多」等于没有', async () => {
    const w = mountHints()
    const body = overflowing(w, 2)
    await w.find('.hf-body').trigger('scroll')
    expect(w.find('.hf-more').exists()).toBe(true)

    Object.defineProperty(body, 'scrollTop', { value: 200, configurable: true })
    await w.find('.hf-body').trigger('scroll')

    expect(w.find('.hf-more').exists()).toBe(false)
    expect(body.classList.contains('has-more')).toBe(false)
  })

  it('装得下就不出 —— 别凭空加一个没用的按钮', async () => {
    const w = mountHints()
    const body = w.find('.hf-body').element as HTMLElement
    Object.defineProperty(body, 'scrollHeight', { value: 200, configurable: true })
    Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true })
    await w.find('.hf-body').trigger('scroll')

    expect(w.find('.hf-more').exists()).toBe(false)
  })

  it('**只数整条没露出来的**，被切一半的那条不算', async () => {
    // 那条已经看得见了，算进「还有」会让数字比实际感受多一个。
    const w = mountHints()
    overflowing(w, 1)
    await w.find('.hf-body').trigger('scroll')

    expect(w.find('.hf-more').text()).toContain('还有 1 条')
  })

  it('点它往下翻', async () => {
    const w = mountHints()
    const body = overflowing(w, 2)
    const spy = vi.fn()
    body.scrollBy = spy
    await w.find('.hf-body').trigger('scroll')
    await w.find('.hf-more').trigger('click')

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
  })
})

describe('追问提示浮框 · 标题栏当把手，但按钮要能点', () => {
  /** 在某个元素上按下并挪动，返回「有没有真的开始拖」 */
  async function dragFrom(w: ReturnType<typeof mountHints>, el: Element) {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 400, clientY: 100 }))
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 200 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 200 }))
    await w.vm.$nextTick()
    return (w.find('.hint-float').attributes('style') ?? '').includes('left')
  }

  it('**在缩小按钮上按下不开始拖** —— 否则指针被标题栏捕获，按钮收不到自己的 click', async () => {
    // 线上表现是「缩小按钮点了没反应」，而按钮、handler、样式全都正常，极难查。
    // 这里断言的是**有没有开始拖**（jsdom 没有 setPointerCapture，
    // 断言不了捕获本身；而不开始拖就不会有捕获，判据是等价的）。
    const w = mountHints()
    expect(await dragFrom(w, w.find('.hf-btn[title="缩小"]').element)).toBe(false)
  })

  it('**在关闭按钮上按下同理**', async () => {
    const w = mountHints()
    expect(await dragFrom(w, w.find('.hf-btn[title^="关闭"]').element)).toBe(false)
  })

  it('按钮的 click 照常发出去', async () => {
    const w = mountHints()
    await w.find('.hf-btn[title="缩小"]').trigger('click')
    await w.find('.hf-btn[title^="关闭"]').trigger('click')

    expect(w.emitted('update:minimized')?.[0]).toEqual([true])
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('在标题栏空白处按下才开始拖', async () => {
    const w = mountHints()
    const head = w.find('.hf-head').element
    head.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 400, clientY: 100 }))
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 200 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 200 }))
    await w.vm.$nextTick()

    expect(w.find('.hint-float').attributes('style')).toContain('left')
  })
})
