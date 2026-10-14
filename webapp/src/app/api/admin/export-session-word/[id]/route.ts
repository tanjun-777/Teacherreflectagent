import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { ReflectionSession, Profile, Problem, Cause, Measure } from '@/types'
import { getSessionOperationLogs } from '@/lib/session-audit'
import { cleanLogText } from '@/lib/log-display'
import {
  formatCell,
  withEvidenceFallback,
  buildRelationRows,
  buildComparisonTableHtml,
  buildDeepeningResultsHtml,
  buildDeepeningRecordsHtml,
  buildDialogueTableHtml,
  type FinalPayloadRow,
  type DeepeningResults,
  type DeepeningRecordSummary,
  type DialogueMessage,
} from '@/lib/word-export'

type OperationLog = {
  at?: string
  stage?: number
  action?: string
  targetType?: string
  targetId?: string
  summary?: string
  before?: string
  after?: string
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: rawProfile } = await supabase.from('profiles').select('*').eq('id', user.id).single()
  const adminProfile = rawProfile as Profile | null
  if (adminProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: rawSession } = await supabase
    .from('reflection_sessions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()

  if (!rawSession) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const session = rawSession as ReflectionSession

  const [{ data: rawTeacher }, { data: rawProblems }, { data: rawCauses }, { data: rawMeasures }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', session.teacher_id).maybeSingle(),
    supabase.from('problems').select('*').eq('session_id', session.id).order('sort_order'),
    supabase.from('causes').select('*').eq('session_id', session.id).order('sort_order'),
    supabase.from('measures').select('*').eq('session_id', session.id).order('sort_order'),
  ])

  const teacher = rawTeacher as Profile | null
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
  const deepeningDialogue = (Array.isArray(snapshot.deepening_dialogue) ? snapshot.deepening_dialogue : []) as DialogueMessage[]
  // 多记录反思深化（新结构）：各记录独立累积的四阶段成果与对话
  const deepeningRecords = (Array.isArray(finalPayload?.deepening_records) ? finalPayload.deepening_records : []) as DeepeningRecordSummary[]
  const deepeningState = (snapshot.deepening ?? null) as {
    active_row?: number | null
    rows?: Record<string, { chat?: DialogueMessage[] }>
  } | null

  // 合并读取：session_operation_logs 表 + 迁移前 draft_snapshot.operation_logs 历史数据（升序）
  const sortedLogs = await getSessionOperationLogs(supabase, session.id, session.draft_snapshot ?? null) as OperationLog[]

  const reportRows: FinalPayloadRow[] = (finalPayload?.rows && finalPayload.rows.length)
    ? finalPayload.rows
    : buildRelationRows(useProblems, useCauses, useMeasures)

  const tableRows = withEvidenceFallback(reportRows, useProblems)

  const overview = finalPayload?.overview || ''

  const statusLabel: Record<string, string> = { draft: '草稿', analyzing: 'AI分析中', done: '已完成' }

  const classifyAction = (log: OperationLog) => {
    const action = log.action ?? ''
    if (!action) return '其他'
    if (action.includes('删除')) return '删除'
    if (action.includes('修改')) return '修改'
    if (action.includes('确认')) {
      const before = String(log.before ?? '').trim()
      const after = String(log.after ?? '').trim()
      if (before && after && before !== after) return '修改'
      return '确认'
    }
    return '其他'
  }

  const buildStageLogsTable = (title: string, stage: 1 | 2 | 3 | 4) => {
    const stageLogs = sortedLogs.filter(log => log.stage === stage)
    // 与管理端页面一致的日志清洗：JSON 转中文、剥离 Markdown 记号，保证导出 Word 清晰可读
    const rowsHtml = stageLogs.length
      ? stageLogs.map((log, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${formatCell(log.at)}</td>
        <td>${formatCell(classifyAction(log))}</td>
        <td>${formatCell(cleanLogText(log.summary))}</td>
        <td>${formatCell(cleanLogText(log.before))}</td>
        <td>${formatCell(cleanLogText(log.after))}</td>
      </tr>
    `).join('')
      : `
      <tr>
        <td>1</td>
        <td>—</td>
        <td>—</td>
        <td>暂无操作记录</td>
        <td>—</td>
        <td>—</td>
      </tr>
    `

    return `
    <p><strong>${title}</strong></p>
    <table>
      <tr>
        <th style="width: 56px;">序号</th>
        <th style="width: 18%;">时间</th>
        <th style="width: 14%;">操作类型</th>
        <th style="width: 30%;">摘要</th>
        <th style="width: 19%;">变更前</th>
        <th style="width: 19%;">变更后</th>
      </tr>
      ${rowsHtml}
    </table>
  `
  }

  const logsSectionHtml = [
    buildStageLogsTable('阶段2 · 步骤1 ｜ 明确问题', 1),
    buildStageLogsTable('阶段2 · 步骤2 ｜ 归因分析', 2),
    buildStageLogsTable('阶段2 · 步骤3 ｜ 改进措施', 3),
    buildStageLogsTable('阶段3 ｜ 初步教学反思审视与深化', 4),
  ].join('')

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

  <h2>第三部分：系统操作记录</h2>
  ${logsSectionHtml}

  <h2>第四部分：反思深化对话记录</h2>
  ${
    deepeningState?.rows && Object.keys(deepeningState.rows).length
      ? Object.keys(deepeningState.rows).map(Number).sort((a, b) => a - b).map(idx => {
          const row = deepeningState.rows![String(idx)] ?? {}
          const chat: DialogueMessage[] = Array.isArray(row.chat) ? row.chat : []
          const problemText = String(tableRows[idx]?.problem ?? '').trim()
          const title = `深化对象 第 ${idx + 1} 条${problemText ? `：${problemText.length > 60 ? `${problemText.slice(0, 60)}…` : problemText}` : ''}`
          return `\n  <p><strong>${formatCell(title)}</strong></p>\n  ${buildDialogueTableHtml(chat)}`
        }).join('\n')
      : buildDialogueTableHtml(deepeningDialogue)
  }
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
