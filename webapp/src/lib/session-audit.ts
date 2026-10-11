import type { SupabaseClient } from '@supabase/supabase-js'
import type { Json } from '@/types/supabase'

export type SessionOperationLog = {
  at: string
  stage: 1 | 2 | 3 | 4
  action: string
  targetType: 'problem' | 'cause' | 'measure' | 'report' | 'deepening'
  targetId?: string
  summary: string
  before?: string
  after?: string
}

export async function appendSessionOperationLog(
  supabase: SupabaseClient,
  sessionId: string,
  log: SessionOperationLog
) {
  const { data: session } = await supabase
    .from('reflection_sessions')
    .select('draft_snapshot')
    .eq('id', sessionId)
    .maybeSingle()

  const snapshot = ((session?.draft_snapshot ?? {}) as Record<string, Json>)
  const prevLogs = Array.isArray(snapshot.operation_logs)
    ? (snapshot.operation_logs as Json[])
    : []

  const nextLogs = [...prevLogs, log as unknown as Json].slice(-500)

  await supabase
    .from('reflection_sessions')
    .update({ draft_snapshot: { ...snapshot, operation_logs: nextLogs } })
    .eq('id', sessionId)
}
