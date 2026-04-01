import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { formatDate } from '@/lib/utils'
import type { ReflectionSession, Profile, Problem, Cause, Measure, ReflectionReport, ImprovementPlan } from '@/types'

export default async function AdminSessionDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()

  const { data: rawSession } = await supabase
    .from('reflection_sessions')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!rawSession) return notFound()
  const session = rawSession as ReflectionSession

  const [{ data: rawTeacher }, { data: rawProblems }, { data: rawCauses }, { data: rawMeasures }, { data: rawReport }, { data: rawPlans }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', session.teacher_id).maybeSingle(),
    supabase.from('problems').select('*').eq('session_id', session.id).order('sort_order'),
    supabase.from('causes').select('*').eq('session_id', session.id).order('sort_order'),
    supabase.from('measures').select('*').eq('session_id', session.id).order('sort_order'),
    supabase.from('reflection_reports').select('*').eq('session_id', session.id).maybeSingle(),
    supabase.from('improvement_plans').select('*').eq('session_id', session.id).order('created_at'),
  ])

  const teacher = rawTeacher as Profile | null
  const problems = (rawProblems ?? []) as Problem[]
  const causes = (rawCauses ?? []) as Cause[]
  const measures = (rawMeasures ?? []) as Measure[]
  const report = (rawReport ?? null) as ReflectionReport | null
  const plans = (rawPlans ?? []) as ImprovementPlan[]

  const confirmedProblems = problems.filter(p => p.confirmed)
  const confirmedCauses = causes.filter(c => c.confirmed)
  const confirmedMeasures = measures.filter(m => m.confirmed)

  const snapshot = (session.draft_snapshot ?? {}) as Record<string, unknown>
  const finalPayload = (snapshot.final_report_payload ?? null) as {
    rows?: Array<{
      problem?: string
      evidence?: string
      cause?: string
      measure?: string
      priority?: string
    }>
    overview?: string
    outlook?: string
    submitted_at?: string
  } | null

  const operationLogs = (Array.isArray(snapshot.operation_logs) ? snapshot.operation_logs : []) as Array<{
    at?: string
    stage?: number
    action?: string
    targetType?: string
    targetId?: string
    summary?: string
    before?: string
    after?: string
  }>

  const sortedLogs = [...operationLogs].sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0
    const tb = b.at ? new Date(b.at).getTime() : 0
    return tb - ta
  })

  const classifyAction = (action?: string) => {
    if (!action) return '其他'
    if (action.includes('确认')) return '确认'
    if (action.includes('删除')) return '删除'
    if (action.includes('修改')) return '修改'
    return '其他'
  }

  const stageLogs: Record<1 | 2 | 3 | 4, typeof sortedLogs> = {
    1: sortedLogs.filter(log => log.stage === 1),
    2: sortedLogs.filter(log => log.stage === 2),
    3: sortedLogs.filter(log => log.stage === 3),
    4: sortedLogs.filter(log => log.stage === 4),
  }

  return (


    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">反思记录详情</h1>
          <p className="text-sm text-gray-500 mt-1">查看教师最终反思结果与过程操作记录</p>

        </div>
        <Link href="/admin/sessions" className="text-sm text-blue-600 hover:underline">← 返回反思记录</Link>
      </div>

      <section className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-3">会话基础信息</h2>
        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <p><span className="text-gray-400">标题：</span><span className="text-gray-800">{session.title}</span></p>
          <p><span className="text-gray-400">教师：</span><span className="text-gray-800">{teacher?.name ?? '—'}</span></p>
          <p><span className="text-gray-400">学科/年级：</span><span className="text-gray-800">{[session.subject, session.grade].filter(Boolean).join(' · ') || '—'}</span></p>
          <p><span className="text-gray-400">上课日期：</span><span className="text-gray-800">{formatDate(session.class_date)}</span></p>
          <p><span className="text-gray-400">当前阶段：</span><span className="text-gray-800">{session.current_stage}/4</span></p>

          <p><span className="text-gray-400">最后更新：</span><span className="text-gray-800">{formatDate(session.updated_at)}</span></p>
        </div>
      </section>

      <section className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">问题识别</p>
          <p className="text-2xl font-bold text-blue-600 mt-1">{confirmedProblems.length}/{problems.length}</p>
          <p className="text-xs text-gray-400 mt-1">已确认/总数</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">归因分析</p>
          <p className="text-2xl font-bold text-orange-600 mt-1">{confirmedCauses.length}/{causes.length}</p>
          <p className="text-xs text-gray-400 mt-1">已确认/总数</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">改进措施</p>
          <p className="text-2xl font-bold text-green-600 mt-1">{confirmedMeasures.length}/{measures.length}</p>
          <p className="text-xs text-gray-400 mt-1">已确认/总数</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">改进计划</p>
          <p className="text-2xl font-bold text-purple-600 mt-1">{plans.length}</p>
          <p className="text-xs text-gray-400 mt-1">累计条目</p>
        </div>
      </section>

      <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h2 className="text-base font-semibold text-gray-900">最终反思结果</h2>
        {finalPayload ? (
          <>
            <div className="text-xs text-gray-500">
              最终提交时间：{finalPayload.submitted_at ? formatDate(finalPayload.submitted_at) : '—'}
            </div>
            <div className="overflow-x-auto border border-gray-100 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-700">
                    <th className="text-left px-3 py-2">存在的问题（来源标注）</th>
                    <th className="text-left px-3 py-2">原因分析</th>
                    <th className="text-left px-3 py-2">改进措施与计划</th>
                    <th className="text-left px-3 py-2">优先级</th>
                  </tr>
                </thead>
                <tbody>
                  {(finalPayload.rows ?? []).map((row, i) => (
                    <tr key={i} className="border-t border-gray-100 align-top">
                      <td className="px-3 py-2 whitespace-pre-wrap">{[row.problem, row.evidence].filter(Boolean).join('\n') || '—'}</td>
                      <td className="px-3 py-2 whitespace-pre-wrap">{row.cause || '—'}</td>
                      <td className="px-3 py-2 whitespace-pre-wrap">{row.measure || '—'}</td>
                      <td className="px-3 py-2 whitespace-pre-wrap">{row.priority || '—'}</td>
                    </tr>
                  ))}
                  {!(finalPayload.rows ?? []).length && (
                    <tr>
                      <td className="px-3 py-3 text-gray-400" colSpan={4}>暂无最终表格数据</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <DataBlock title="一、课堂概述" content={finalPayload.overview ?? null} />
            <DataBlock title="三、总结与展望" content={finalPayload.outlook ?? null} />
          </>
        ) : (
          <DataBlock title="最终报告正文" content={report?.content || report?.ai_draft || null} />
        )}
      </section>

      <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
        <h2 className="text-base font-semibold text-gray-900">过程操作记录（表格）</h2>

        <OperationLogsStageTable
          title="阶段1：问题识别"
          logs={stageLogs[1]}
          classifyAction={classifyAction}
        />

        <OperationLogsStageTable
          title="阶段2：归因分析"
          logs={stageLogs[2]}
          classifyAction={classifyAction}
        />

        <OperationLogsStageTable
          title="阶段3：改进措施"
          logs={stageLogs[3]}
          classifyAction={classifyAction}
        />

        <OperationLogsStageTable
          title="反思报告"
          logs={stageLogs[4]}
          classifyAction={classifyAction}
        />
      </section>


      <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h2 className="text-base font-semibold text-gray-900">阶段0原始数据</h2>

        <DataBlock title="教学设计" content={session.teaching_design} />
        <DataBlock title="教师自评" content={session.self_review} />
        <DataBlock title="同伴评价" content={session.peer_review} />
        <DataBlock title="课堂录音转写" content={session.audio_transcript} />
      </section>


    </div>
  )
}

function OperationLogsStageTable({
  title,
  logs,
  classifyAction,
}: {
  title: string
  logs: Array<{
    at?: string
    stage?: number
    action?: string
    targetType?: string
    targetId?: string
    summary?: string
    before?: string
    after?: string
  }>
  classifyAction: (action?: string) => string
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-800 mb-2">{title}</h3>
      <div className="overflow-x-auto border border-gray-100 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-gray-700">
              <th className="text-left px-3 py-2">时间</th>
              <th className="text-left px-3 py-2">操作类型</th>
              <th className="text-left px-3 py-2">对象</th>
              <th className="text-left px-3 py-2">摘要</th>
              <th className="text-left px-3 py-2">变更前</th>
              <th className="text-left px-3 py-2">变更后</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log, i) => (
              <tr key={`${log.at ?? 'na'}-${log.targetId ?? i}`} className="border-t border-gray-100 align-top">
                <td className="px-3 py-2 whitespace-pre-wrap">{log.at ? formatDate(log.at) : '时间未知'}</td>
                <td className="px-3 py-2 whitespace-pre-wrap">{classifyAction(log.action)}</td>
                <td className="px-3 py-2 whitespace-pre-wrap">{[log.targetType, log.targetId].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-3 py-2 whitespace-pre-wrap">{log.summary || '—'}</td>
                <td className="px-3 py-2 whitespace-pre-wrap">{log.before || '—'}</td>
                <td className="px-3 py-2 whitespace-pre-wrap">{log.after || '—'}</td>
              </tr>
            ))}
            {!logs.length && (
              <tr>
                <td className="px-3 py-3 text-gray-400" colSpan={6}>暂无操作记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DataBlock({ title, content }: { title: string; content: string | null }) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-700 mb-1">{title}</p>
      <div className="text-sm text-gray-600 bg-gray-50 rounded-lg border border-gray-100 p-3 whitespace-pre-wrap min-h-12">
        {content || '暂无数据'}
      </div>
    </div>
  )
}

