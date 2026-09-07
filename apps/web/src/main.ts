import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import 'element-plus/dist/index.css'
import './styles/base.css'
// V4.3 在所有 scoped 规则之后还有一层不带作用域的 !important 覆盖，
// 决定了表头等区域的最终观感。必须在 base.css 之后、组件样式之前引入。
import './styles/app-overrides.css'
// 移动端样式。类名全部带 m- 前缀，只有移动端组件会挂载，桌面 DOM 里不出现。
import './styles/mobile.css'
// 主题变量。由 scripts/build-themes.mjs 生成。
// **默认主题一个变量都不定义** —— 它靠 var(--t-xxx, #原值) 的回退值生效，
// 所以引入这个文件不会改变默认态的任何一个像素，还原度门禁不受影响。
import './styles/themes.css'

import App from './App.vue'
import { router } from './router'
import { installDebugHandle } from './logging'
import { bootstrapPreferences } from './composables/usePreferences'

// 调试句柄挂到 window.__da。默认不输出，URL 加 ?debug=1 或执行 __da.on() 打开；
// 环形缓冲始终在记 —— 出问题往往是事后才想起要看日志，那时再重现现场就没了。
installDebugHandle()

// 个人偏好上屏。**必须在 mount 之前**，而且只读 localStorage 不发请求 ——
// 放到组件里去 load，第一帧渲染的是默认样式，医生会看到主题和字号闪一下。
// 跨设备同步那一半在 App.vue 里异步补（那时医生名才拿得到）。
bootstrapPreferences()

createApp(App).use(createPinia()).use(router).use(ElementPlus, { locale: zhCn }).mount('#app')
