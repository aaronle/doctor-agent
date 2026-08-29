import { defineStore } from 'pinia'
import { ref } from 'vue'

const STORAGE_KEY = 'doctor-agent.session'

/**
 * 医生会话。
 *
 * 一期没有医院 SSO：任意账号密码即可进入，与 V4.3 的演示口径一致。
 * 登录态存 sessionStorage 而非 localStorage —— 关掉标签页即失效，
 * 演示机上不会留下一个长期有效的「已登录」状态。
 */
export const useSession = defineStore('session', () => {
  const stored = sessionStorage.getItem(STORAGE_KEY)
  const doctorName = ref(stored ?? '')
  const loggedIn = ref(Boolean(stored))

  function login(name: string) {
    doctorName.value = name || '张医生'
    loggedIn.value = true
    sessionStorage.setItem(STORAGE_KEY, doctorName.value)
  }

  function logout() {
    doctorName.value = ''
    loggedIn.value = false
    sessionStorage.removeItem(STORAGE_KEY)
  }

  return { doctorName, loggedIn, login, logout }
})
