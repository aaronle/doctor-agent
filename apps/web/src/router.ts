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
  // 交付平台。与控制台同一类页面（面向研发与调优，不是医生端功能），
  // 同样不占用 V4.3 定义的五个医生端页面。
  { path: '/delivery', name: 'Delivery', component: () => import('./views/DeliveryView.vue'), meta: { title: '交付平台' } },
  { path: '/outpatient/:patientId', name: 'OutpatientWorkstation', component: () => import('./views/WorkstationView.vue'), meta: { title: '门诊工作站' } },
]

export const router = createRouter({ history: createWebHistory(), routes })

/**
 * 页面标题。**必须与 `apps/api/app/seo.py` 的 ROUTES 逐字一致。**
 *
 * 两处都要有，是因为它们服务于两种不同的抓取方式：
 *   - 链接直接贴进聊天 → 爬虫读服务端下发的静态 HTML（seo.py 那份）
 *   - 从微信内置浏览器点分享 → 微信读**当前 DOM**，也就是这里设的这份
 *
 * 只改一处的后果实测过：卡片标题变成「候诊列表 · AI 门诊工作站」——
 * 一个内部页名被转发了出去。跨语言没法共用常量，只能两边各钉一条测试。
 */
const DOC_TITLES: Record<string, string> = {
  '/admin': 'Agent 控制台 · Doctor Agent',
  '/delivery': '交付平台 · Doctor Agent',
}
const DEFAULT_TITLE = 'Doctor Agent · AI 门诊工作站'

router.beforeEach((to) => {
  // 就诊页刻意不带就诊人标识：这个标题会被微信当成卡片标题转发出去
  const matched = Object.keys(DOC_TITLES).find((p) => to.path === p || to.path.startsWith(`${p}/`))
  document.title = matched ? DOC_TITLES[matched] : DEFAULT_TITLE
  return true
})
