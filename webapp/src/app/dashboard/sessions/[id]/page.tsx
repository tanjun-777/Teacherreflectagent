import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import SessionWizard from '@/components/session/SessionWizard'

type DeepeningPhaseResults = {
  1?: { status: string; assumptions?: Array<{ original_clue: string; explicated: string }> }
  2?: { status: string; examinations?: Array<{ assumption: string; method: string; conclusion: string }> }
  3?: { status: string; new_understandings?: Array<{ based_on: string; statement: string }> }
  4?: {
    status: string
    orientations?: Array<{ linked_understanding: string; principle: string; orientation: string }>
    actions?: Array<{ context: string; time: string; method: string; expected_effect: string }>
  }
}

type DeepeningRecordSummary = {
  order?: number
  row_index?: number
  problem?: string
  phase_results?: DeepeningPhaseResults
}

type FinalReportPayload = {
  rows?: Array<{
    problem?: string
    evidence?: string
    cause?: string
    measure?: string
  }>
  deepening_results?: DeepeningPhaseResults
  deepening_records?: DeepeningRecordSummary[]
}

function parseFinalPayload(draftSnapshot: unknown): FinalReportPayload {
  if (!draftSnapshot || typeof draftSnapshot !== 'object') return {}
  const snapshot = draftSnapshot as Record<string, unknown>
  const payload = snapshot.final_report_payload
  if (!payload || typeof payload !== 'object') return {}
  return payload as FinalReportPayload
}

// 单条记录的四阶段成果渲染（P4 宏观取向优先，兼容旧 actions 结构）
function renderPhaseSections(results?: DeepeningPhaseResults) {
  if (!results) return null
  return (
    <>
      {results[1]?.status === 'completed' && (
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Phase 1 ｜ 既有假设外显</h3>
          {results[1].assumptions?.map((a, i) => (
            <div key={i} className="text-sm text-gray-700 mb-2">
              <p className="text-xs text-gray-500">假设 {i + 1}</p>
              <p>原文线索：{a.original_clue}</p>
              <p>外显表述：{a.explicated}</p>
            </div>
          )) ?? <p className="text-sm text-gray-500">—</p>}
        </section>
      )}
      {results[2]?.status === 'completed' && (
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Phase 2 ｜ 批判性检视</h3>
          {results[2].examinations?.map((e, i) => (
            <div key={i} className="text-sm text-gray-700 mb-2">
              <p className="text-xs text-gray-500">假设 {i + 1} 检视</p>
              <p>检视方式：{e.method}</p>
              <p>检视结论：{e.conclusion}</p>
            </div>
          )) ?? <p className="text-sm text-gray-500">—</p>}
        </section>
      )}
      {results[3]?.status === 'completed' && (
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Phase 3 ｜ 新认识形成</h3>
          {results[3].new_understandings?.map((n, i) => (
            <div key={i} className="text-sm text-gray-700 mb-2">
              <p className="text-xs text-gray-500">新认识 {i + 1}</p>
              <p>基于：{n.based_on}</p>
              <p>表述：{n.statement}</p>
            </div>
          )) ?? <p className="text-sm text-gray-500">—</p>}
        </section>
      )}
      {results[4]?.status === 'completed' && (
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Phase 4 ｜ 宏观行动重构</h3>
          {(results[4].orientations ?? []).length > 0 ? results[4].orientations!.map((o, i) => (
            <div key={i} className="text-sm text-gray-700 mb-2">
              <p className="text-xs text-gray-500">宏观取向 {i + 1}</p>
              <p>基于认识：{o.linked_understanding}</p>
              <p>基本原则：{o.principle}</p>
              <p>实践取向：{o.orientation}</p>
            </div>
          )) : (results[4].actions ?? []).map((a, i) => (
            <div key={i} className="text-sm text-gray-700 mb-2">
              <p className="text-xs text-gray-500">行动 {i + 1}</p>
              <p>情境：{a.context}</p>
              <p>时间：{a.time}</p>
              <p>方式：{a.method}</p>
              <p>预期效果：{a.expected_effect}</p>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

export default async function SessionPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: session } = await supabase
    .from('reflection_sessions')
    .select('*')
    .eq('id', params.id)
    .eq('teacher_id', user.id)
    .single()

  if (!session) return notFound()

  const [{ data: problems }, { data: causes }, { data: measures }, { data: report }] =
    await Promise.all([
      supabase.from('problems').select('*').eq('session_id', session.id).order('sort_order'),
      supabase.from('causes').select('*').eq('session_id', session.id).order('sort_order'),
      supabase.from('measures').select('*').eq('session_id', session.id).order('sort_order'),
      supabase.from('reflection_reports').select('*').eq('session_id', session.id).maybeSingle(),
    ])

  if (session.status === 'done') {
    const payload = parseFinalPayload(session.draft_snapshot)
    const rows = payload.rows ?? []

    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{session.title}</h1>
            <p className="text-sm text-gray-500 mt-1">最终反思报告</p>
          </div>
          <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">返回反思记录</Link>
        </div>

        {rows.length > 0 && (
          <div className="mb-6 border border-gray-200 rounded-xl overflow-hidden bg-white">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 text-sm font-medium text-gray-800">
              问题-归因-改进措施对照表（最终版）
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-100 text-gray-700">
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[32%]">存在的问题（来源标注）</th>
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[28%]">原因分析</th>
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[40%]">改进措施与计划</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={`row-${i}`} className="align-top">
                      <td className="px-3 py-3 border-b border-gray-100 whitespace-pre-line">{row.problem}{row.evidence ? `\n${row.evidence}` : ''}</td>
                      <td className="px-3 py-3 border-b border-gray-100 whitespace-pre-line">{row.cause}</td>
                      <td className="px-3 py-3 border-b border-gray-100 whitespace-pre-line">{row.measure}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-6">
          {(payload.deepening_records ?? []).length > 0 ? (
            payload.deepening_records!.map((rec, n) => (
              <section key={`rec-${n}`}>
                <h2 className="text-base font-semibold text-gray-900">
                  深化记录 {n + 1}{typeof rec.row_index === 'number' ? `（对照表第 ${rec.row_index + 1} 条）` : ''}
                </h2>
                {rec.problem && <p className="text-sm text-gray-500 mb-3">{rec.problem}</p>}
                <div className="space-y-4">
                  {renderPhaseSections(rec.phase_results)}
                </div>
              </section>
            ))
          ) : (
            renderPhaseSections(payload.deepening_results)
          )}
          {(!payload.deepening_results && !(payload.deepening_records ?? []).length) && (
            <section>
              <h2 className="text-base font-semibold text-gray-900 mb-2">报告原文</h2>
              <p className="text-sm text-gray-700 whitespace-pre-line">{report?.content || '暂无报告内容'}</p>
            </section>
          )}
        </div>
      </div>
    )
  }

  return (
    <SessionWizard
      session={session}
      initialProblems={problems ?? []}
      initialCauses={causes ?? []}
      initialMeasures={measures ?? []}
      initialReport={report ?? null}
    />
  )
}
