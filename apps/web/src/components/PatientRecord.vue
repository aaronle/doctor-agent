<script setup lang="ts">
import type { Patient } from '../types'

defineProps<{ patient: Patient | null }>()
</script>

<template>
  <section class="record-pane">
    <div class="record-title"><span>▣</span> 门诊病历</div>
    <div class="record-nav">
      <button class="patient-circle active">王</button>
      <button class="patient-circle">张</button>
      <button class="patient-circle">李</button>
      <button class="patient-circle">陈</button>
      <button class="patient-circle">刘</button>
      <button class="patient-circle">赵</button>
    </div>
    <div class="record-content">
      <div class="diagnosis-head">
        <strong>📌 诊断</strong>
        <span v-if="!patient" class="muted">暂无患者诊断</span>
        <template v-else>
          <span class="diagnosis-pill">{{ patient.scenario }}</span>
        </template>
      </div>
      <div class="form-row required"><label>主诉</label><p>{{ patient?.chief_complaint || '请填写主诉（必填）' }}</p></div>
      <div class="form-row required"><label>现病史</label><p>请填写现病史（必填）</p></div>
      <div class="form-row"><label>既往史</label><p>{{ patient ? '由患者历史资料和医生问诊补充' : '请填写既往史' }}</p></div>
      <div class="form-row"><label>个人史</label><p>请填写个人史（吸烟、饮酒、职业暴露等）</p></div>
      <div class="form-row"><label>过敏史</label><p>{{ patient?.allergy || '无' }}</p></div>
      <div class="form-row compact"><label>体征</label><p>身高 ___ CM　体重 ___ KG　BMI ___　体温 ___ ℃</p></div>
      <div class="form-row"><label>体格检查</label><p>请填写体格检查</p></div>
      <div class="form-row accent"><label>辅助检查</label><p>请填写辅助检查内容</p></div>
      <div class="form-row"><label>建议</label><p>处理意见、初步诊断</p></div>
    </div>
  </section>
</template>
