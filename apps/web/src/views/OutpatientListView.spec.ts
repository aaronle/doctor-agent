import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { nextTick } from 'vue'

import OutpatientListView from './OutpatientListView.vue'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/outpatient/list', component: OutpatientListView },
    { path: '/outpatient', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
  ],
})

const patients = [
  {
    fixture_id: 'IM-001',
    specialty: '内科-内分泌代谢',
    scenario: '糖尿病复诊',
    patient_id: 'MOCK-IM-001',
    encounter_id: 'ENC-IM-001',
    name: '王某某',
    gender: '女',
    age: 58,
    chief_complaint: '血糖控制不佳',
    allergy: '无',
    facts: {},
  },
]

describe('OutpatientListView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(window, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ patients }),
    } as Response)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows patient list and can open a patient', async () => {
    await router.push('/outpatient/list')
    await router.isReady()
    const wrapper = mount(OutpatientListView, {
      global: {
        plugins: [router],
      },
    })
    await nextTick()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
    expect(wrapper.text()).toContain('王某某')
    const enterBtn = wrapper.findAll('button').find((el) => el.text() === '进入医生智能体')
    expect(enterBtn?.exists()).toBe(true)
    await enterBtn?.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/outpatient'))
  })
})
