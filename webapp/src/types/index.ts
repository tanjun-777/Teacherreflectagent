import type { Database } from './supabase'

export type Profile = Database['public']['Tables']['profiles']['Row']
export type ReflectionSession = Database['public']['Tables']['reflection_sessions']['Row']
export type Problem = Database['public']['Tables']['problems']['Row']
export type Cause = Database['public']['Tables']['causes']['Row']
export type Measure = Database['public']['Tables']['measures']['Row']
export type ReflectionReport = Database['public']['Tables']['reflection_reports']['Row']
export type ImprovementPlan = Database['public']['Tables']['improvement_plans']['Row']

export type SourceTag = 'ai_analysis' | 'peer_review' | 'self_review'

export const SOURCE_LABEL: Record<SourceTag, string> = {
  ai_analysis: 'AI模型评价',
  peer_review: '同伴评价',
  self_review: '教师自评',
}


export const SOURCE_COLOR: Record<SourceTag, string> = {
  ai_analysis: 'bg-blue-100 text-blue-700',
  peer_review: 'bg-green-100 text-green-700',
  self_review: 'bg-orange-100 text-orange-700',
}
