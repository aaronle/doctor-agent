import { defineStore } from 'pinia'
import { ref } from 'vue'

const STORAGE_KEY = 'doctor-agent.session'

/** 演示口径下的默认接诊医生。页头与候诊列表都要显示一个名字。 */
export const DEFAULT_DOCTOR = '张医生'

/**
 * 医生会话。
 *
 * **一期没有登录**：没有医院 SSO，原先那道「任意账号密码都能进」的登录页
 * 是纯摆设 —— 既拖慢演示，又让人误以为这里有身份边界。已于 2026-09-01 移除，
 * 直接进候诊列表。
 *
 * 这里只留一个可改的医生名：页头要显示接诊医生，将来接 SSO 时这个 store
 * 就是落点，不必再把身份概念重新引一遍。
 */
export const useSession = defineStore('session', () => {
  const doctorName = ref(sessionStorage.getItem(STORAGE_KEY) || DEFAULT_DOCTOR)

  function setDoctor(name: string) {
    doctorName.value = name || DEFAULT_DOCTOR
    sessionStorage.setItem(STORAGE_KEY, doctorName.value)
  }

  return { doctorName, setDoctor }
})
