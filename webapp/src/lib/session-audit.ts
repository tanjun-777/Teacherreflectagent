import type { SupabaseClient } from '@supabase/supabase-js'
import type { Json } from '@/types/supabase'

export type SessionOperationLog = {
  at: string
  stage: 1 | 2 | 3 | 4
  action: string
  targetType: 'problem' | 'cause' | 'measure' | 'report' | 'deepening' | 'stage'
  targetId?: string
  summary: string
  before?: string
  after?: string
}

// ── draft_snapshot 串行写入门（同一浏览器标签页内全局互斥）─────────────
// draft_snapshot 为整字段「读-改-写」，并发写会互相覆盖（丢日志/丢对话/丢阶段进度）。
// 所有对 draft_snapshot 的写入都必须经由该队列串行执行。
let draftSnapshotQueue: Promise<unknown> = Promise.resolve()

export function withDraftSnapshotUpdate<T>(task: () => Promise<T>): Promise<T> {
  const run = draftSnapshotQueue.then(task, task)
  draftSnapshotQueue = run.then(() => undefined, () => undefined)
  return run
}

// 在串行队列内完成 draft_snapshot 的读-改-写，merge 返回完整的新快照
export async function updateDraftSnapshotFields(
  supabase: SupabaseClient,
  sessionId: string,
  merge: (snapshot: Record<string, Json>) => Record<string, Json>,
): Promise<Record<string, Json>> {
  return withDraftSnapshotUpdate(async () => {
    const { data: row } = await supabase
      .from('reflection_sessions')
      .select('draft_snapshot')
      .eq('id', sessionId)
      .maybeSingle()
    const prev = ((row?.draft_snapshot ?? {}) as Record<string, Json>)
    const next = merge({ ...prev })
    const { error } = await supabase
      .from('reflection_sessions')
      .update({ draft_snapshot: next })
      .eq('id', sessionId)
    if (error) throw new Error(error.message)
    return next
  })
}

// ── 操作日志 ────────────────────────────────────────────────────
// 优先写入独立表 session_operation_logs（append-only，天然无并发覆盖）；
// 表不存在（尚未执行迁移 SQL）时回退到 draft_snapshot.operation_logs（串行队列内）。
export async function appendSessionOperationLog(
  supabase: SupabaseClient,
  sessionId: string,
  log: SessionOperationLog,
) {
  const { error } = await supabase.from('session_operation_logs').insert({
    session_id: sessionId,
    logged_at: log.at,
    stage: log.stage,
    action: log.action,
    target_type: log.targetType,
    target_id: log.targetId ?? null,
    summary: log.summary,
    before_value: log.before ?? null,
    after_value: log.after ?? null,
  })
  if (!error) return

  await withDraftSnapshotUpdate(async () => {
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

    const { error: updateError } = await supabase
      .from('reflection_sessions')
      .update({ draft_snapshot: { ...snapshot, operation_logs: nextLogs } })
      .eq('id', sessionId)
    if (updateError) {
      // 回退写入失败时暴露问题（不阻断主流程），避免日志静默丢失无迹可查
      console.warn('[session-audit] 操作日志回退写入失败:', updateError.message)
    }
  })
}

type OperationLogRow = {
  id?: number
  logged_at?: string
  at?: string
  stage?: number
  action?: string
  target_type?: string
  targetType?: string
  target_id?: string | null
  targetId?: string | null
  summary?: string | null
  before_value?: string | null
  after_value?: string | null
  before?: string | null
  after?: string | null
}

// 合并读取：新表日志 + 旧 draft_snapshot.operation_logs（迁移前的历史数据），按时间升序
export async function getSessionOperationLogs(
  supabase: SupabaseClient,
  sessionId: string,
  legacySnapshot?: Json | null,
): Promise<SessionOperationLog[]> {
  const { data: rows } = await supabase
    .from('session_operation_logs')
    .select('*')
    .eq('session_id', sessionId)
    .order('logged_at', { ascending: true })
    .order('id', { ascending: true })

  const fromTable: SessionOperationLog[] = ((rows ?? []) as unknown as OperationLogRow[]).map(r => ({
    at: r.logged_at ?? '',
    stage: (r.stage ?? 1) as 1 | 2 | 3 | 4,
    action: r.action ?? '',
    targetType: (r.target_type ?? 'problem') as SessionOperationLog['targetType'],
    targetId: r.target_id ?? undefined,
    summary: r.summary ?? '',
    before: r.before_value ?? undefined,
    after: r.after_value ?? undefined,
  }))

  const snap = ((legacySnapshot ?? {}) as Record<string, Json>)
  const legacy: SessionOperationLog[] = Array.isArray(snap.operation_logs)
    ? (snap.operation_logs as unknown as OperationLogRow[]).map(r => ({
        at: r.at ?? '',
        stage: (r.stage ?? 1) as 1 | 2 | 3 | 4,
        action: r.action ?? '',
        targetType: (r.targetType ?? 'problem') as SessionOperationLog['targetType'],
        targetId: r.targetId ?? undefined,
        summary: r.summary ?? '',
        before: r.before ?? undefined,
        after: r.after ?? undefined,
      }))
    : []

  return [...legacy, ...fromTable].sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0
    const tb = b.at ? new Date(b.at).getTime() : 0
    return ta - tb
  })
}
