import { vi } from 'vitest'

/**
 * 移动端测试的共用夹具。
 *
 * 演示与测试一律用假数据（虚构病例），与一期「不接真实患者数据」的红线一致。
 */

export const PATIENT = {
  id: 'P001',
  name: '王某某',
  gender: '女',
  age: 58,
  visit_type: '复诊',
  dept: '内分泌科',
  doctor: '李医生',
  visit_date: '2026-06-17',
  chief_complaint: '血糖控制不佳，口渴多饮 2 周',
  primary_diagnosis: '2型糖尿病',
  risk_level: '高风险',
  id_no: '',
  phone: '138****0001',
  is_return_visit: true,
  pre_consultation_done: true,
  nutrition_screening_score: 1,
  past_history: '2型糖尿病 5 年，原发性高血压 3 年',
  allergies: ['青霉素'],
  vitals: { height: 162, weight: 68.5, bmi: 26.1, temp: 36.5, bp: '142/88', hr: 76 },
  lab_results: [
    { name: '空腹血糖', value: '8.5', unit: 'mmol/L', ref: '<7.0', abnormal: true, diff_note: '较上次上升 0.7' },
    { name: '血钾', value: '4.1', unit: 'mmol/L', ref: '3.5-5.5', abnormal: false },
  ],
  orders: [{ id: 'O1', drug: '二甲双胍缓释片', dose: '0.5g', freq: 'bid', route: '口服', days: '30', status: '在用' }],
  visit_history: [
    { visit_date: '2026-03-11', visit_type: '门诊', dept: '内分泌科', doctor: '李医生', diagnosis: '2型糖尿病', summary: '调整用药' },
  ],
}

export const SUMMARY = {
  overall_conclusion: {
    risk_level: '中风险',
    summary: '2型糖尿病病程5年，血糖控制未达标。',
    problems: ['血糖控制不佳'],
    conflicts: ['患者自述偶服用药，处方显示规律用药'],
  },
  treatment_effectiveness: { ai_summary: '现方案控制不足' },
  risk_assessments: [
    { id: 'r1', name: '低血糖风险', level: '中风险', color: '#f59e0b', summary: '联用磺脲类', evidence: '格列美脲 2mg qd' },
  ],
  risk_alerts: [
    { id: 'a1', name: '心肌缺血迹象', level: '高风险', color: '#e6191a', summary: 'ST段V4-V6轻度压低' },
  ],
  recommended_orders: [{ drug: '达格列净', dose: '10mg', freq: 'qd', route: '口服', basis: '合并糖尿病肾病' }],
  recommended_exams: [{ id: 'x1', name: '尿微量白蛋白', type: '检验', basis: 'UACR 升高需复查' }],
  examinations: [{ id: 'e1', name: '双眼底照相', type: '检查', date: '2026-06-10', abnormal: true, result: '双眼NPDR轻度', conclusion: '异常: NPDR 轻度' }],
  todos: [
    { id: 't1', text: '复查糖化血红蛋白', priority: '高', source: '硬规则', done: false, action_type: 'exam', category: '检查检验' },
  ],
  dialog_script: [],
  record_nodes: {},
  record_content: { chief_complaint: '血糖控制不佳，口渴多饮 2 周。', present_illness: '近 2 周口渴多饮加重。' },
  is_return_visit: true,
  pre_consultation_done: true,
  suspected_diagnoses: [
    { name: '2型糖尿病（血糖控制不佳）', confidence: 90, icd: 'E11.9', rank_label: '①', supporting: ['空腹血糖 8.5'] },
    { name: '糖尿病视网膜病变（NPDR轻度）', confidence: 85, icd: 'E11.3', rank_label: '②' },
  ],
  differential_diagnosis: {},
  visit_history: [],
  comorbidity: {
    detected: true,
    risk_level: '中风险',
    summary: '合并高血压与高脂血症',
    conditions: [
      { name: '原发性高血压', icd: 'I10', duration: '3年', risk_level: '中风险', analysis: '血压 142/88 未达标', recommended_dept: '心内科' },
    ],
    nutrition: { triggered: false, score: 1, threshold: 3, message: '' },
  },
  handled_alerts: [],
  timeline: [{ time: '2026-06-17 09:12', category: '就诊', action: '开始接诊', detail: '内分泌科 李医生' }],
  _meta: { degraded_agents: [], hard_rule_alerts: 1, model_conflicts: [], cached: false },
}

export const ASSESSMENT_CATALOG = {
  note: '',
  categories: [
    { name: '代谢与内分泌', count: 2, items: [{ name: '糖尿病足风险', level: '中', desc: '' }, { name: '低血糖风险', level: '高', desc: '' }] },
  ],
}

export const RECORD_QUALITY = {
  completeness: 82,
  metrics: [{ name: '完整性', value: 82, basis: '九段中缺 2 段' }],
  gaps: [{ text: '未记录个人史', level: '一般', status: 'open', field: '个人史', field_key: 'personal_history', issue: '缺失', type: 'warning' as const }],
}

/** 把窗口宽度伪装成手机。缺这一步，移动端分支根本不会渲染。 */
export function stubMatchMedia(isMobile: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: isMobile && query.includes('max-width'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  )
}

/** 覆盖移动端会触达的全部端点。返回 fetch mock，便于断言调用。 */
export function stubFetch(overrides: Record<string, unknown> = {}) {
  const mock = vi.fn(async (url: string) => {
    const u = String(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    for (const [fragment, body] of Object.entries(overrides)) {
      if (u.includes(fragment)) return json(body)
    }
    if (u.includes('/api/his/patients/manage')) return json({ ok: true, patients: [], total: 0, reminded_count: 0 })
    if (u.includes('/api/his/patients')) return json([PATIENT])
    if (u.includes('/api/his/patient/')) return json(PATIENT)
    if (u.includes('report-summary')) return json(SUMMARY)
    if (u.includes('assessment-catalog')) return json(ASSESSMENT_CATALOG)
    if (u.includes('record/quality')) return json(RECORD_QUALITY)
    if (u.includes('/api/emr/record/')) return json({ patient_id: 'P001', latest: null, submitted: null })
    if (u.includes('knowledge')) return json({ items: [] })
    if (u.includes('drugs')) return json([])
    return json({})
  })
  vi.stubGlobal('fetch', mock)
  return mock
}
