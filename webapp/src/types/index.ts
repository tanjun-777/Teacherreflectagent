import type { Database } from './supabase'

export type Profile = Database['public']['Tables']['profiles']['Row']
export type ReflectionSession = Database['public']['Tables']['reflection_sessions']['Row']
export type Problem = Database['public']['Tables']['problems']['Row']
export type Cause = Database['public']['Tables']['causes']['Row']
export type Measure = Database['public']['Tables']['measures']['Row']
export type ReflectionReport = Database['public']['Tables']['reflection_reports']['Row']
export type ImprovementPlan = Database['public']['Tables']['improvement_plans']['Row']

export type SourceTag = 'peer_review' | 'self_review' | 'external_feedback' | 'teacher_manual'

export const SOURCE_LABEL: Record<SourceTag, string> = {
  peer_review: '多主体同伴评价',
  self_review: '教师自评',
  external_feedback: '外部教研系统',
  teacher_manual: '教师自主新增',
}


export const SOURCE_COLOR: Record<SourceTag, string> = {
  peer_review: 'bg-green-100 text-green-700',
  self_review: 'bg-orange-100 text-orange-700',
  external_feedback: 'bg-purple-100 text-purple-700',
  teacher_manual: 'bg-teal-100 text-teal-700',
}

// 证据来源（阶段2·明确问题 证据关联）：严格限于五类教学材料
export type EvidenceSourceTag = 'teaching_design' | 'student_performance' | 'learning_outcomes' | 'classroom_record' | 'external_feedback'

export const EVIDENCE_SOURCE_LABEL: Record<EvidenceSourceTag, string> = {
  teaching_design: '教学设计',
  student_performance: '学生表现',
  learning_outcomes: '学习结果',
  classroom_record: '课堂教学实录',
  external_feedback: '外部教研系统反馈',
}
