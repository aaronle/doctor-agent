import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

import { useSession } from './stores/session'

/**
 * 路由与 V4.3 一一对应，不得新增第二套工作台或独立问诊页。
 *
 * 与 V4.3 的唯一差别是模式：V4.3 用 hash 路由，这里改为 history 模式，
 * 由 FastAPI 对未匹配路径回落 index.html。URL 更干净，路径本身不变。
 */
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/login' },
  { path: '/login', name: 'Login', component: () => import('./views/LoginView.vue'), meta: { noAuth: true, title: '登录' } },
  { path: '/outpatient', name: 'OutpatientHome', component: () => import('./views/WorkstationView.vue'), meta: { title: '门诊工作站' } },
  { path: '/outpatient/list', name: 'OutpatientList', component: () => import('./views/OutpatientListView.vue'), meta: { title: '候诊列表' } },
  { path: '/outpatient/manage', name: 'PatientManage', component: () => import('./views/PatientManageView.vue'), meta: { title: '患者管理' } },
  { path: '/outpatient/:patientId', name: 'OutpatientWorkstation', component: () => import('./views/WorkstationView.vue'), meta: { title: '门诊工作站' } },
]

export const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to) => {
  const session = useSession()
  document.title = `${to.meta.title ?? '门诊'} · 惠每AI门诊`
  if (!to.meta.noAuth && !session.loggedIn) {
    return { path: '/login' }
  }
  return true
})
