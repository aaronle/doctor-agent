import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

import LoginView from './LoginView.vue'

describe('LoginView', () => {
  it('uses the confirmed product entry and contains no legacy brand', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: LoginView }],
    })
    const wrapper = mount(LoginView, { global: { plugins: [router] } })
    expect(wrapper.text()).toContain('进入医生智能体')
    expect(wrapper.text()).not.toContain('惠每')
  })
})
