<script setup lang="ts">
/**
 * 院内 HIS 门面 —— **纯视觉仿真，不实现任何功能**。
 *
 * ## 它是干什么的
 *
 * 「医生智能体」是一个浮窗，它的真实使用场景是**浮在医生本来就在用的 HIS 上**。
 * 底下什么都没有的话，演示时看到的是「一个孤立的 AI 工具」；
 * 有了这层门面，看到的才是「AI 长在医生现有的工作流里」—— 那才是产品的主张。
 *
 * 照北大国际医院现行 HIS 的界面仿的：顶部工具栏、患者信息栏、
 * 左侧病历文书 + 西医诊断、右侧医嘱项目 + 医嘱开立。
 *
 * ## 为什么全是 div，没有一个 input
 *
 * **这层不能可编辑，也不能可点。** 用真的 `<input>` 会让人以为能录入，
 * 一敲字发现存不进去，比没有这层还糟。全部用 div 模拟外观，
 * 天然不可编辑；整层 `user-select:none`，连选中文本都不给。
 *
 * ## 与「未接入院内 HIS」标识的关系
 *
 * 2026-09-02 曾把 HIS 门面**整块撤掉**，理由是「一个长得像 HIS 的页面
 * 很容易让人以为已经和院内系统打通了」。现在按需求把它做回来，
 * 那个顾虑一个字都没变 —— 所以：
 *
 * 1. 页头那条「演示环境 · 未接入任何院内 HIS」保留，且这层的层级低于它；
 * 2. 这层自己右上角再挂一条「界面仿真 · 不可操作」；
 * 3. 数据全部是本仓库的虚构病例，不接任何外部系统。
 *
 * 少了任何一条，这层就从「演示道具」变成了「误导」。
 */
import { computed, ref } from 'vue'

import type { PatientDetail } from '../api'

const props = defineProps<{ patient: PatientDetail | null }>()

const p = computed(() => props.patient)

/**
 * ## 交互做到什么程度
 *
 * 只做**纯前端、看得见反馈、不产生任何后果**的那几个：
 * 切医嘱分类、切初诊/复诊、勾选医嘱行、折叠左栏。
 *
 * 判据是「点下去有反应，但不会让人以为数据存进去了」。
 * 所以没有任何一个动作会发请求、也不会有「保存成功」这类提示 ——
 * 那种反馈会让人相信这是真在用的系统，而它不是。
 */
const activeTab = ref('医嘱项目')
const visitKind = ref<'初诊' | '复诊'>('初诊')
const checked = ref<Set<number>>(new Set())
const docCollapsed = ref(false)

function toggleRow(i: number) {
  const next = new Set(checked.value)
  next.has(i) ? next.delete(i) : next.add(i)
  checked.value = next
}

/** 医嘱表格的仿真行。按科室给一套对得上的内容 —— 心内科病人开眼科的药会很出戏。 */
const orders = computed(() => {
  const dept = p.value?.dept ?? ''
  if (dept.includes('心内')) {
    return [
      ['签署', '西药', '阿司匹林肠溶片(阿司匹林肠溶片...', '100mg', '8.60', '口服', '每日一次(晨) 30天', '8.60', '心内科门诊', '151722365'],
      ['签署', '西药', '阿托伐他汀钙片(立普妥)', '20mg', '46.30', '口服', '每晚一次 30天', '46.30', '心内科门诊', '151722366'],
      ['签署', '检查', '12导联心电图', '', '35.00', '', '', '35.00', '心电图室', '151722367'],
      ['开立', '检验', '血脂全套+肌钙蛋白I(血)', '', '128.00', '', '空腹采血', '128.00', '检验科', '151722369'],
    ]
  }
  if (dept.includes('内分泌')) {
    return [
      ['签署', '西药', '二甲双胍缓释片(格华止)', '0.5g', '18.40', '口服', '每日两次 30天', '18.40', '内分泌门诊', '151722365'],
      ['签署', '西药', '阿卡波糖片(拜唐苹)', '50mg', '32.70', '口服', '三餐时嚼服 30天', '32.70', '内分泌门诊', '151722366'],
      ['签署', '检验', '糖化血红蛋白(HbA1c)', '', '65.00', '', '', '65.00', '检验科', '151722367'],
      ['开立', '检查', '双眼底照相', '', '120.00', '', '', '120.00', '眼科', '151722369'],
    ]
  }
  return [
    ['签署', '西药', '氨氯地平片(络活喜)', '5mg', '26.80', '口服', '每日一次 30天', '26.80', '神经内科门诊', '151722365'],
    ['签署', '检查', '头颅CT平扫(无胶片)', '', '280.00', '', '', '280.00', '放射科', '151722367'],
    ['开立', '检验', '血常规+凝血四项(血)', '', '96.00', '', '', '96.00', '检验科', '151722369'],
    ['开立', '诊疗', '心电监护(小时)', '2次', '22', '', '2次', '22.00', '神经内科门诊', '151722371'],
  ]
})

const total = computed(() =>
  orders.value.reduce((s, r) => s + Number(r[7] || 0), 0).toFixed(2),
)

/** 分类页签 → 表格过滤。「医嘱项目」是全部。 */
const TAB_TYPE: Record<string, string | null> = {
  医嘱项目: null, 药品: '西药', 检查: '检查', 检验: '检验', 诊疗: '诊疗', 其他: '__none__',
}
const visibleOrders = computed(() => {
  const want = TAB_TYPE[activeTab.value]
  if (want === null || want === undefined) return orders.value.map((o, i) => ({ o, i }))
  return orders.value.map((o, i) => ({ o, i })).filter(({ o }) => o[1] === want)
})
const countOf = (t: string) => orders.value.filter((o) => o[1] === t).length

const TOOLBAR = [
  ['✎', '保存', true], ['▤', '诊间预约', false], ['⎙', '打印', true], ['♪', '叫号', true],
  ['✓', '诊毕', true], ['▦', '数据中心', false], ['⊞', '工作表单', true], ['☰', '患者列表', false],
  ['▤', '报告查看', true], ['⚙', '其他', true], ['⌂', '科室', true], ['↻', '刷新', false],
] as const

/** 病历文书左栏的行。第二列为空表示是「未录入」的灰底占位。 */
const DOC_ROWS = [
  ['主诉：', ''],
  ['现病史：', '现病史录入'],
  ['既往史：', '既往史录入'],
  ['查体：', '体格检查录入'],
  ['辅助检查：', '辅助检查录入'],
  ['处置意见：', '处置意见'],
] as const
</script>

<template>
  <!--
    整层 aria-hidden：它对屏幕阅读器没有任何意义，
    读出来只会把真正要读的「医生智能体」淹掉。
  -->
  <div class="his-backdrop" aria-hidden="true">
    <!-- 顶部工具栏 -->
    <div class="hb-toolbar">
      <div class="hb-tools">
        <!--
          「界面仿真」标识放在**工具栏最左**，不是角落。
          原先挂在患者栏右下角 —— 那个位置正好被医生智能体浮窗盖住，
          而这条标识存在的全部意义就是被看见。**防误解的东西不能藏在会被遮的地方。**
        -->
        <span class="hb-sim-badge">界面仿真 · 不可操作</span>
        <span v-for="[icon, label, caret] in TOOLBAR" :key="label" class="hb-tool">
          <i class="hb-ti">{{ icon }}</i>{{ label }}<b v-if="caret" class="hb-caret">▾</b>
        </span>
      </div>
      <div class="hb-tools-right">
        <span class="hb-tool"><i class="hb-ti">◔</i>无叫号患者</span>
        <span class="hb-utd">UTD</span>
        <span class="hb-search">🔍</span>
      </div>
    </div>

    <!-- 患者信息栏 -->
    <div class="hb-patient">
      <div class="hb-queue">
        <div class="hb-queue-row">
          <span>候诊:<b>3</b></span><span>已诊:<b>1</b></span><span>待回诊:<b>0</b></span><span>未分诊:<b>0</b></span>
        </div>
        <div class="hb-queue-input">自动 ▾　{{ p?.id ?? '—' }}　🔍</div>
      </div>
      <div class="hb-avatar">👤</div>
      <div class="hb-name">{{ p?.name ?? '—' }}　{{ p?.gender === '女' ? '女性' : '男性' }}　{{ p?.age ?? '—' }}岁</div>
      <div class="hb-grid">
        <span class="hb-f"><i>患者分类</i>医保病人</span>
        <span class="hb-f"><i>价格分类</i>普通</span>
        <span class="hb-f"><i>医保计划</i>北京市医保</span>
        <span class="hb-f"><i>生理状态</i>—</span>
        <span class="hb-f"><i>挂号类型</i>诊间</span>
        <span class="hb-f"><i>号别</i>普通</span>
        <span class="hb-f"><i>过敏史</i><b class="hb-allergy">{{ p?.allergy?.status === 'confirmed' ? p.allergy.items.join('、') : '—' }}</b></span>
        <span class="hb-f"><i>门诊次数</i>28</span>
        <span class="hb-f"><i>联系电话</i>{{ p?.phone ?? '—' }}</span>
        <span class="hb-f"><i>出生日期</i>{{ p?.birth_date ?? '—' }}</span>
        <span class="hb-f"><i>信用医</i>否</span>
        <span class="hb-f"><i>预付费卡</i>—</span>
      </div>
    </div>

    <!-- 主体：左病历文书 / 右医嘱 -->
    <div class="hb-body">
      <div class="hb-left">
        <div class="hb-panel-title"><i>◐</i>病历文书
          <span class="hb-pt-right" @click="docCollapsed = !docCollapsed">▫ {{ docCollapsed ? '»' : '«' }}</span>
        </div>
        <div class="hb-doc-head">
          <span class="hb-radio" :class="{ on: visitKind === '初诊' }" @click="visitKind = '初诊'">{{ visitKind === '初诊' ? '◉' : '○' }} 初诊</span>
          <span class="hb-radio" :class="{ on: visitKind === '复诊' }" @click="visitKind = '复诊'">{{ visitKind === '复诊' ? '◉' : '○' }} 复诊</span>
          <span class="hb-select">门诊通用{{ visitKind }}病历（PKUIH 202601）模…　▾</span>
        </div>
        <div v-show="!docCollapsed" class="hb-rtf">
          <span v-for="i in ['✂','⧉','📋','↶','↷']" :key="i" class="hb-rtf-i">{{ i }}</span>
          <span class="hb-rtf-sel">宋体 ▾</span><span class="hb-rtf-sel">9 ▾</span>
          <span class="hb-rtf-i on">B</span><span class="hb-rtf-i">I</span><span class="hb-rtf-i">U</span>
          <span v-for="i in ['Ω','x²','x₂','≡','≣','⌕']" :key="i" class="hb-rtf-i">{{ i }}</span>
        </div>
        <div v-show="!docCollapsed" class="hb-doc">
          <div v-for="[label, ph] in DOC_ROWS" :key="label" class="hb-doc-row">
            <span class="hb-doc-label">{{ label }}</span>
            <span class="hb-doc-val" :class="{ ph: !!ph }">{{ ph }}</span>
          </div>
          <div class="hb-doc-note">新型冠状病毒肺炎流行病学调查情况</div>
          <div class="hb-doc-note">鼠疫流行病学调查情况</div>
          <div class="hb-doc-row"><span class="hb-doc-label">诊断或印象诊断：</span><span class="hb-doc-val">{{ p?.primary_diagnosis ?? '' }}</span></div>
          <div class="hb-doc-row"><span class="hb-doc-label">嘱托：</span><span class="hb-doc-val">定期复查，清淡饮食</span></div>
          <div class="hb-doc-row"><span class="hb-doc-label">医师签名：</span><span class="hb-doc-val">{{ p?.doctor ?? '' }}</span></div>
          <div class="hb-doc-row"><span class="hb-doc-label">就诊日期：</span><span class="hb-doc-val">{{ p?.visit_date ?? '' }} 09:14:22</span></div>
        </div>
        <div class="hb-panel-title sub">西医诊断</div>
        <table class="hb-tbl diag">
          <thead><tr><th>医保诊断名称</th><th>诊断补充…</th><th>北临版诊断名称</th><th>疑</th><th>主</th><th>ICD</th></tr></thead>
          <tbody>
            <tr><td>{{ p?.primary_diagnosis ?? '' }}</td><td /><td>{{ p?.primary_diagnosis ?? '' }}</td><td>☐</td><td>☑</td><td>—</td></tr>
            <tr v-for="i in 2" :key="i"><td /><td /><td /><td>☐</td><td>☐</td><td /></tr>
          </tbody>
        </table>
      </div>

      <div class="hb-right">
        <div class="hb-tabs">
          <span class="hb-tab" :class="{ on: activeTab === '医嘱项目' }" @click="activeTab = '医嘱项目'">医嘱项目</span>
          <span class="hb-tab" :class="{ on: activeTab === '药品' }" @click="activeTab = '药品'">药品({{ countOf('西药') }})</span>
          <span class="hb-tab" :class="{ on: activeTab === '检查' }" @click="activeTab = '检查'">检查({{ countOf('检查') }})</span>
          <span class="hb-tab" :class="{ on: activeTab === '检验' }" @click="activeTab = '检验'">检验({{ countOf('检验') }})</span>
          <span class="hb-tab" :class="{ on: activeTab === '诊疗' }" @click="activeTab = '诊疗'">诊疗({{ countOf('诊疗') }})</span>
          <span class="hb-tab" :class="{ on: activeTab === '其他' }" @click="activeTab = '其他'">其他(0)</span>
          <span class="hb-tab">分方</span><span class="hb-tab">费用清单</span>
          <span class="hb-amount">金额: <b>{{ total }}元</b>　0.00/{{ total }}</span>
        </div>
        <table class="hb-tbl orders">
          <thead>
            <tr><th class="w24">☐</th><th class="w52">状态</th><th class="w46">类型</th><th>处置内容</th><th class="w56">剂量</th>
              <th class="w60">金额</th><th class="w36">科研</th><th class="w88">执行科室</th><th class="w52">审核</th>
              <th class="w82">医嘱编码</th><th class="w104">开始时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="{ o, i } in visibleOrders" :key="i"
                :class="{ signed: o[0] === '签署', picked: checked.has(i) }" @click="toggleRow(i)">
              <td>{{ checked.has(i) ? '☑' : '☐' }}</td>
              <td><span class="hb-status" :class="o[0] === '签署' ? 'ok' : 'new'">{{ o[0] }}</span></td>
              <td>{{ o[1] }}</td>
              <td class="left">{{ o[2] }}<span v-if="o[5]" class="hb-sub">　{{ o[5] }}　{{ o[6] }}</span></td>
              <td>{{ o[3] }}</td><td class="right">{{ o[4] }}</td><td>☐</td><td>{{ o[8] }}</td>
              <td><span class="hb-lock">🔒</span></td><td>{{ o[9] }}</td>
              <td>{{ (p?.visit_date ?? '').slice(2) }} 09:1{{ i + 2 }}</td>
            </tr>
            <tr v-if="!visibleOrders.length" class="hb-empty"><td colspan="11">该分类下暂无医嘱</td></tr>
          </tbody>
        </table>
        <div class="hb-panel-title sub mt">医嘱开立</div>
        <table class="hb-tbl entry">
          <thead><tr><th>医嘱项目 🔍</th><th class="w120">剂量</th><th class="w90">频次 🔍</th><th class="w110">总量</th><th class="w120">执行科室 🔍</th></tr></thead>
          <tbody><tr v-for="i in 2" :key="i"><td /><td /><td /><td /><td /></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped src="../styles/HisBackdrop.scoped.css"></style>
