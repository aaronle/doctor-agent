<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterView } from 'vue-router'

import { useSession } from './stores/session'
import { usePreferences } from './composables/usePreferences'

/**
 * 个人偏好的**跨设备同步**这一半。
 *
 * 上屏那一半在 `main.ts` 的 `bootstrapPreferences()` 里，mount 之前就跑完了；
 * 这里只负责去后端拉一次、以后端为准。放在这里而不是各个页面里：
 * 偏好是全局的，挂在路由页上就会出现「进过配置页的那次才生效」——
 * 那正是修掉的那个 bug。
 *
 * 拉取失败不做任何事：`load()` 内部只挂一条 syncError，本机值照常有效。
 */
const session = useSession()
onMounted(() => {
  void usePreferences().load(session.doctorName)
})
</script>

<template>
  <RouterView />
</template>
