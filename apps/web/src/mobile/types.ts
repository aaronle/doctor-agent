/**
 * ＋ 菜单点选后要做的事。
 *
 * 放在独立文件而不是 SFC 里：`<script setup>` 不能有具名导出，
 * 类型跟着组件走就只能靠 `defineProps` 反推，调用方拿不到。
 */
/** 记录页的五个分段。＋ 菜单要能直接跳到其中一段，所以类型得共用。 */
export const RECORD_SEGMENTS = ['病历', '医嘱', '检查检验', '时间轴', '健康档案'] as const
export type RecordSegment = (typeof RECORD_SEGMENTS)[number]

export type MenuAction =
  | { kind: 'analysis'; focus: string }
  | { kind: 'records'; segment: RecordSegment }
  | { kind: 'voice' }
  | { kind: 'prompts' }
  | { kind: 'route'; to: string }
  | { kind: 'send'; text: string }
