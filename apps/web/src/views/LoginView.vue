<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { Lock, User } from '@element-plus/icons-vue'

import { useSession } from '../stores/session'

const router = useRouter()
const session = useSession()

const username = ref('张医生')
const password = ref('123456')

function submit() {
  session.login(username.value)
  router.push('/outpatient/list')
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <div class="login-logo">
          <el-icon :size="24"><Lock /></el-icon>
        </div>
        <h1 class="login-title">惠每AI门诊工作站</h1>
        <p class="login-sub">北京大学国际医院 · 一期 MVP</p>
      </div>

      <el-form size="large">
        <el-form-item required>
          <el-input v-model="username" :prefix-icon="User" clearable placeholder="医生工号或姓名" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item required>
          <el-input
            v-model="password"
            :prefix-icon="Lock"
            type="password"
            show-password
            placeholder="密码"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-form-item>
          <el-button class="login-btn" type="primary" @click="submit">进入门诊工作站</el-button>
        </el-form-item>
      </el-form>

      <p class="login-hint">一期未接入医院 SSO，任意账号密码均可登录 · 演示病例，非真实患者数据</p>
    </div>
  </div>
</template>

<style scoped src="../styles/Login.scoped.css"></style>
