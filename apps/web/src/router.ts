import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/**
 * 路由与 V4.3 一一对应，不得新增第二套工作台或独立问诊页。
 *
 * 与 V4.3 的唯一差别是模式：V4.3 用 hash 路由，这里改为 history 模式，
 * 由 FastAPI 对未匹配路径回落 index.html。URL 更干净，路径本身不变。
 */
const routes: RouteRecordRaw[] = [
  // 一期没有医院 SSO，登录页只是一道摆设 —— 任意账号密码都能进。
  // 摆一道形同虚设的门，既拖慢演示，又让人误以为这里有身份边界。直接进候诊列表。
  { path: '/', redirect: '/outpatient/list' },
  // 老书签与外部链接还可能指向 /login，重定向掉而不是 404
  { path: '/login', redirect: '/outpatient/list' },
  { path: '/outpatient', name: 'OutpatientHome', component: () => import('./views/WorkstationView.vue'), meta: { title: '门诊工作站' } },
  { path: '/outpatient/list', name: 'OutpatientList', component: () => import('./views/OutpatientListView.vue'), meta: { title: '候诊列表' } },
  { path: '/outpatient/manage', name: 'PatientManage', component: () => import('./views/PatientManageView.vue'), meta: { title: '患者管理' } },
  // 控制台。面向管理员与调优人员，不占用 V4.3 定义的五个医生端页面。
  { path: '/admin', name: 'AdminConsole', component: () => import('./views/AdminConsoleView.vue'), meta: { title: 'Agent 控制台' } },
  { path: '/outpatient/:patientId', name: 'OutpatientWorkstation', component: () => import('./views/WorkstationView.vue'), meta: { title: '门诊工作站' } },
]

export const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to) => {
  document.title = `${to.meta.title ?? '门诊'} · AI 门诊工作站`
  return true
})
