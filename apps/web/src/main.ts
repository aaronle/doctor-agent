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

import App from './App.vue'
import { router } from './router'

createApp(App).use(createPinia()).use(router).use(ElementPlus, { locale: zhCn }).mount('#app')
