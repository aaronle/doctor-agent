<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

import { login } from '../api'

const router = useRouter()
const username = ref('张医生')
const password = ref('demo')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    const result = await login(username.value, password.value)
    sessionStorage.setItem('doctor_agent_token', result.access_token)
    sessionStorage.setItem('doctor_agent_doctor', JSON.stringify(result.doctor))
    await router.replace('/outpatient')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '登录失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="login-page">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-mark">⌾</div>
      <h1>AI门诊工作站</h1>
      <p>北京大学国际医院 · 医生辅助演示</p>
      <label><span>医生</span><input v-model="username" autocomplete="username" aria-label="用户名" /></label>
      <label><span>密码</span><input v-model="password" type="password" autocomplete="current-password" aria-label="密码" /></label>
      <div v-if="error" class="login-error">{{ error }}</div>
      <button type="submit" :disabled="busy">{{ busy ? '正在进入…' : '进入医生智能体' }}</button>
      <small>信息暂存于浏览器会话 · 当前为产品演示数据</small>
    </form>
  </main>
</template>
