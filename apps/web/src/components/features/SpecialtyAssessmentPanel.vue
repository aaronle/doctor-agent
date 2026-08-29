<script setup lang="ts">
import { ref } from 'vue'

interface AssessmentItem {
  id: string
  label: string
  description: string
}

interface AssessmentGroup {
  id: string
  label: string
  tone: string
  items: AssessmentItem[]
}

const groups: AssessmentGroup[] = [
  {
    id: 'clinical-quality', label: '诊疗质控助手', tone: 'clinical',
    items: [
      { id: 'prognosis', label: '诊断预后分析', description: '帮助医师与患者科学认识预后，合理制定治疗目标与方案，改善医患沟通与治疗决策质量。' },
      { id: 'disease-risk', label: '专病风险评估', description: '早期识别高危患者，落实专病风险分层管理，降低门诊不良结局发生率。' },
      { id: 'hai', label: '院感风险监测', description: '结合诊断、操作、检验与暴露信息提示院感相关风险，并提供核验入口。' },
      { id: 'adverse-event', label: '不良事件监测', description: '识别诊疗过程中的潜在不良事件线索，形成待核验事项并保留处置记录。' },
      { id: 'infectious-report', label: '传染病预警报告', description: '提示疑似传染病报告条件、缺失信息和报告时限，最终由授权人员确认。' },
      { id: 'public-health', label: '突发公共卫生事件监测', description: '聚合同类异常信号，提示可能的公共卫生事件线索及上报路径。' },
      { id: 'critical-value', label: '危急值闭环管理', description: '关联危急值确认、通知、处置与复核状态，未闭环时持续提醒并按规则阻断。' },
    ],
  },
  {
    id: 'patient-service', label: '患者服务助手', tone: 'patient',
    items: [
      { id: 'chronic-screen', label: '慢病早期筛查与风险评估', description: '基于现有诊疗数据形成慢病筛查提示和下一步服务建议。' },
      { id: 'occupational', label: '职业病服务评估', description: '识别职业暴露与服务需求，提示需要补充的职业史和合规路径。' },
      { id: 'referral', label: '转诊服务评估', description: '结合病情、专科能力和资源情况提供院内外转诊草稿。' },
      { id: 'chronic-package', label: '慢病健康管理包', description: '根据疾病和风险分层匹配随访、监测、教育等管理服务。' },
      { id: 'exam-service', label: '专病健康体检服务', description: '按专病风险生成体检项目建议，并标明依据和适用条件。' },
      { id: 'full-course', label: '专病全病程服务评估', description: '评估诊前、诊中、诊后连续服务缺口和可衔接事项。' },
      { id: 'device', label: '智能设备服务评估', description: '判断居家监测设备的适用性、数据要求和风险边界。' },
      { id: 'exam-guide', label: '检查检验预约及引导服务', description: '形成预约、准备事项、路线和注意事项的患者服务草稿。' },
      { id: 'education', label: '健康教育与生活方式干预', description: '按疾病和个体情况生成可复核的教育与生活方式建议。' },
      { id: 'rehab-tcm', label: '康复门诊与中医适宜技术服务', description: '评估康复或中医适宜技术的服务匹配度，不替代临床适应证判断。' },
    ],
  },
  {
    id: 'operations', label: '运营管理助手', tone: 'operations',
    items: [
      { id: 'privilege', label: '诊疗权限管理服务', description: '核验医生、科室和项目的诊疗权限，并提示越权风险。' },
      { id: 'appointment', label: '预约确认服务', description: '核对预约状态、资源和患者准备条件。' },
      { id: 'insurance-order', label: '医保合规开单', description: '在开立前提示医保规则、必要凭证和潜在违规点。' },
      { id: 'cost', label: '合理控费评估', description: '对费用结构和重复项目进行提示，保留医生判断和原因。' },
      { id: 'self-pay', label: '自费与超医保评估', description: '识别自费或超医保范围项目，提示知情确认要求。' },
      { id: 'flight-check', label: '医保飞检风险评估', description: '根据规则和历史风险模式提示医保飞检关注点。' },
      { id: 'resource', label: '医疗资源效率', description: '展示资源使用效率及可核验的改进线索。' },
      { id: 'workload', label: '医生工作量与绩效核算', description: '按已确认口径汇总工作量，指标定义和绩效规则由医院配置。' },
      { id: 'visit-ratio', label: '首诊复诊比例配置', description: '辅助分析并配置首复诊资源比例，不自动修改排班。' },
    ],
  },
  {
    id: 'research', label: '临床科研助手', tone: 'research',
    items: [
      { id: 'enrollment', label: '科研课题入组评估', description: '按已批准方案筛选潜在入组对象，必须经过研究人员确认。' },
      { id: 'trial', label: '药物临床试验评估', description: '对照入排标准提示候选者和缺失证据，不自动完成入组。' },
      { id: 'project-recommendation', label: '科研课题智能推荐', description: '依据研究方向和可用数据推荐课题线索，供科研人员论证。' },
    ],
  },
  {
    id: 'teaching', label: '临床教学助手', tone: 'teaching',
    items: [
      { id: 'case-teaching', label: '教学病例评估推荐', description: '识别具有教学价值的病例并生成脱敏教学要点草稿。' },
      { id: 'record-review', label: '处方与病历点评', description: '依据已批准的点评规则生成结构化问题清单，结果需教师复核。' },
      { id: 'question-bank', label: '考核题库推荐', description: '按教学目标与难度推荐题目，保留来源和版本。' },
      { id: 'teaching-file', label: '教学档案', description: '归集教学活动、评价和改进记录，受角色权限和脱敏规则约束。' },
    ],
  },
]

// 专项评估是能力目录，不是患者风险结果。为避免占据病历工作区，
// 首次进入及切换患者后默认全部折叠，由医生按需展开。
const openGroups = ref(new Set<string>())
const activeItem = ref('')

function toggleGroup(groupId: string) {
  const next = new Set(openGroups.value)
  if (next.has(groupId)) {
    next.delete(groupId)
    const group = groups.find((item) => item.id === groupId)
    if (group?.items.some((item) => item.id === activeItem.value)) activeItem.value = ''
  } else next.add(groupId)
  openGroups.value = next
}
</script>

<template>
  <section class="special-assessment-panel">
    <header class="special-assessment-title">专项评估</header>
    <div v-for="group in groups" :key="group.id" class="assessment-group" :class="group.tone">
      <button class="assessment-group-title" type="button" @click="toggleGroup(group.id)">
        <strong>{{ group.label }}</strong>
        <span>{{ group.items.length }}项　{{ openGroups.has(group.id) ? '⌄' : '›' }}</span>
      </button>
      <div v-if="openGroups.has(group.id)" class="assessment-items">
        <button
          v-for="item in group.items"
          :key="item.id"
          type="button"
          class="assessment-item"
          :class="{ active: activeItem === item.id }"
          @click="activeItem = activeItem === item.id ? '' : item.id"
        >
          <span><strong>{{ item.label }}</strong><em>{{ activeItem === item.id ? '⌄' : '›' }}</em></span>
          <p v-if="activeItem === item.id">{{ item.description }}</p>
        </button>
      </div>
    </div>
    <footer>专项能力按当前患者、就诊和医生权限调用；涉及 Worker/Sub-Agent 的拆分方式待讨论。</footer>
  </section>
</template>
