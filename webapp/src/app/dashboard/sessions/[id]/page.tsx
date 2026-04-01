import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import SessionWizard from '@/components/session/SessionWizard'

type FinalReportPayload = {
  rows?: Array<{
    problem?: string
    evidence?: string
    cause?: string
    measure?: string
    priority?: string
  }>
  overview?: string
  outlook?: string
}

function parseFinalPayload(draftSnapshot: unknown): FinalReportPayload {
  if (!draftSnapshot || typeof draftSnapshot !== 'object') return {}
  const snapshot = draftSnapshot as Record<string, unknown>
  const payload = snapshot.final_report_payload
  if (!payload || typeof payload !== 'object') return {}
  return payload as FinalReportPayload
}

export default async function SessionPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: session } = await supabase
    .from('reflection_sessions')
    .select('*')
    .eq('id', params.id)
    .eq('teacher_id', user!.id)
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
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[30%]">存在的问题（来源标注）</th>
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[25%]">原因分析</th>
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[35%]">改进措施与计划</th>
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[10%]">优先级</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={`row-${i}`} className="align-top">
                      <td className="px-3 py-3 border-b border-gray-100 whitespace-pre-line">{row.problem}{row.evidence ? `\n${row.evidence}` : ''}</td>
                      <td className="px-3 py-3 border-b border-gray-100 whitespace-pre-line">{row.cause}</td>
                      <td className="px-3 py-3 border-b border-gray-100 whitespace-pre-line">{row.measure}</td>
                      <td className="px-3 py-3 border-b border-gray-100">{row.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-6">
          <section>
            <h2 className="text-base font-semibold text-gray-900 mb-2">一、课堂概述</h2>
            <p className="text-sm text-gray-700 whitespace-pre-line">{payload.overview || '—'}</p>
          </section>
          <section>
            <h2 className="text-base font-semibold text-gray-900 mb-2">二、总结与展望</h2>
            <p className="text-sm text-gray-700 whitespace-pre-line">{payload.outlook || '—'}</p>
          </section>
          {!payload.overview && !payload.outlook && (
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
