export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          role: 'teacher' | 'admin'
          name: string | null
          school: string | null
          subject: string | null
          grade: string | null
          textbook_version: string | null
          textbook_detail: string | null
          avatar_url: string | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['profiles']['Row'], 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>
      }
      reflection_sessions: {
        Row: {
          id: string
          teacher_id: string
          title: string
          class_date: string | null
          subject: string | null
          grade: string | null
          lesson_topic: string | null
          teaching_design: string | null
          self_review: string | null
          peer_review: string | null
          audio_url: string | null
          audio_transcript: string | null
          current_stage: number
          status: 'draft' | 'analyzing' | 'done'
          draft_snapshot: Json | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['reflection_sessions']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['reflection_sessions']['Insert']>
      }
      problems: {
        Row: {
          id: string
          session_id: string
          description: string
          evidence: Json | null
          source: string[] | null
          confirmed: boolean
          sort_order: number
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['problems']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['problems']['Insert']>
      }
      causes: {
        Row: {
          id: string
          session_id: string
          problem_id: string
          description: string
          confirmed: boolean
          sort_order: number
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['causes']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['causes']['Insert']>
      }
      measures: {
        Row: {
          id: string
          session_id: string
          problem_id: string
          cause_id: string | null
          description: string
          confirmed: boolean
          sort_order: number
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['measures']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['measures']['Insert']>
      }
      reflection_reports: {
        Row: {
          id: string
          session_id: string
          content: string | null
          ai_draft: string | null
          finalized_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['reflection_reports']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['reflection_reports']['Insert']>
      }
      improvement_plans: {
        Row: {
          id: string
          session_id: string
          measure_id: string | null
          goal: string
          actions: string | null
          timeline: string | null
          success_criteria: string | null
          status: 'pending' | 'in_progress' | 'done'
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['improvement_plans']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['improvement_plans']['Insert']>
      }
    }
  }
}
