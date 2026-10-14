import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { ReflectionSession, Profile, Problem, Cause, Measure } from '@/types'
import {
  formatCell,
  withEvidenceFallback,
  buildRelationRows,
  buildComparisonTableHtml,
  buildDeepeningResultsHtml,
  buildDeepeningRecordsHtml,
  type FinalPayloadRow,
  type DeepeningResults,
  type DeepeningRecordSummary,
} from '@/lib/word-export'

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: rawTeacher }, { data: rawSession }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    supabase
      .from('reflection_sessions')
      .select('*')
      .eq('id', params.id)
      .eq('teacher_id', user.id)
      .maybeSingle(),
  ])

  if (!rawSession) return NextResponse.json({ error: 'Not Found' }, { status: 404 })

  const teacher = rawTeacher as Profile | null
  const session = rawSession as ReflectionSession

  if (session.status !== 'done') {
    return NextResponse.json({ error: 'Only completed sessions can be exported' }, { status: 403 })
  }

  const [{ data: rawProblems }, { data: rawCauses }, { data: rawMeasures }] = await Promise.all([
    supabase.from('problems').select('*').eq('session_id', session.id).order('sort_order'),
    supabase.from('causes').select('*').eq('session_id', session.id).order('sort_order'),
    supabase.from('measures').select('*').eq('session_id', session.id).order('sort_order'),
  ])

  const problems = (rawProblems ?? []) as Problem[]
  const causes = (rawCauses ?? []) as Cause[]
  const measures = (rawMeasures ?? []) as Measure[]

  const confirmedProblems = problems.filter(p => p.confirmed)
  const confirmedCauses = causes.filter(c => c.confirmed)
  const confirmedMeasures = measures.filter(m => m.confirmed)

  const useProblems = confirmedProblems.length ? confirmedProblems : problems
  const useCauses = confirmedCauses.length ? confirmedCauses : causes
  const useMeasures = confirmedMeasures.length ? confirmedMeasures : measures

  const snapshot = (session.draft_snapshot ?? {}) as Record<string, unknown>
  const finalPayload = (snapshot.final_report_payload ?? null) as {
    rows?: FinalPayloadRow[]
    overview?: string
    deepening_records?: DeepeningRecordSummary[]
  } | null
  const deepeningResults = (snapshot.deepening_results ?? null) as DeepeningResults | null
  // 多记录反思深化结果（新结构）：逐条呈现各记录四阶段成果；旧会话回退单条结构
  const deepeningRecords = (Array.isArray(finalPayload?.deepening_records) ? finalPayload.deepening_records : []) as DeepeningRecordSummary[]

  const reportRows: FinalPayloadRow[] = (finalPayload?.rows && finalPayload.rows.length)
    ? finalPayload.rows
    : buildRelationRows(useProblems, useCauses, useMeasures)

  const tableRows = withEvidenceFallback(reportRows, useProblems)

  const overview = finalPayload?.overview || ''

  const statusLabel: Record<string, string> = { draft: '草稿', analyzing: 'AI分析中', done: '已完成' }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: "Microsoft YaHei", Arial, sans-serif; color: #222; font-size: 12pt; }
    h1 { font-size: 18pt; margin: 0 0 12px; }
    h2 { font-size: 14pt; margin: 18px 0 8px; }
    p { margin: 4px 0; line-height: 1.6; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; table-layout: fixed; }
    th, td { border: 1px solid #d9d9d9; padding: 6px 8px; vertical-align: top; word-break: break-word; }
    th { background: #f5f7fa; font-weight: 600; }
  </style>
</head>
<body>
  <h1>课堂教学反思记录导出</h1>

  <h2>第一部分：原列表字段信息</h2>
  <table>
    <tr><th style="width: 180px;">字段</th><th>内容</th></tr>
    <tr><td>标题</td><td>${formatCell(session.title)}</td></tr>
    <tr><td>教师</td><td>${formatCell(teacher?.name)}</td></tr>
    <tr><td>学校</td><td>${formatCell(teacher?.school)}</td></tr>
    <tr><td>学科</td><td>${formatCell(session.subject)}</td></tr>
    <tr><td>年级</td><td>${formatCell(session.grade)}</td></tr>
    <tr><td>上课日期</td><td>${formatCell(session.class_date)}</td></tr>
    <tr><td>状态</td><td>${formatCell(statusLabel[session.status] ?? session.status)}</td></tr>
    <tr><td>创建时间</td><td>${formatCell(session.created_at)}</td></tr>
    <tr><td>更新时间</td><td>${formatCell(session.updated_at)}</td></tr>
  </table>

  <h2>第二部分：反思详情</h2>
  <p><strong>一、课堂概述</strong></p>
  <p>${formatCell(overview)}</p>

  <p><strong>二、问题/证据/归因/措施对照表</strong></p>
  ${buildComparisonTableHtml(tableRows)}

  <p><strong>三、教学反思审视与深化结果</strong></p>
  ${deepeningRecords.length ? buildDeepeningRecordsHtml(deepeningRecords) : buildDeepeningResultsHtml(deepeningResults)}
</body>
</html>`

  const filenameTitle = (session.title ?? '反思记录').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  const content = `\uFEFF${html}`

  return new NextResponse(content, {
    headers: {
      'Content-Type': 'application/msword; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(`${filenameTitle}-${Date.now()}.doc`)}`,
    },
  })
}
