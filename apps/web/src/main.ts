import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'

import App from './App.vue'
import LoginView from './views/LoginView.vue'
import OutpatientView from './views/OutpatientView.vue'
import OutpatientListView from './views/OutpatientListView.vue'
import './styles.css'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/outpatient/list' },
    { path: '/login', component: LoginView },
    { path: '/outpatient', component: OutpatientView },
    { path: '/outpatient/list', component: OutpatientListView },
  ],
})

const autoEntry = import.meta.env.VITE_DEMO_AUTO_ENTRY !== 'false'

if (autoEntry) {
  sessionStorage.setItem('doctor_agent_token', 'mock-token-doctor_001')
  if (!sessionStorage.getItem('doctor_agent_doctor')) {
    sessionStorage.setItem(
      'doctor_agent_doctor',
      JSON.stringify({ user_id: 'doctor_001', name: '张医生', department: '门诊' }),
    )
  }
}

router.beforeEach((to) => {
  if (autoEntry && to.path === '/login') return '/outpatient/list'
  if (autoEntry) return true
  if (to.path !== '/login' && !sessionStorage.getItem('doctor_agent_token')) return '/login'
  if (to.path === '/login' && sessionStorage.getItem('doctor_agent_token')) return '/outpatient/list'
})

createApp(App).use(createPinia()).use(router).mount('#app')
