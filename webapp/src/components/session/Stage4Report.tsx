'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, Cause, Measure, ReflectionReport } from '@/types'
import { appendSessionOperationLog } from '@/lib/session-audit'


interface Props {
  session: ReflectionSession
  problems: Problem[]
  causes: Cause[]
  measures: Measure[]
  report: ReflectionReport | null
  setReport: (r: ReflectionReport) => void
  onFinish: () => void
  onAnalyze: () => Promise<void>
  analyzing: boolean
  analysisError: string
}

type EvidenceItem = { text?: string; source?: string }
type Priority = '高(P1)' | '中(P2)' | '低(P3)'

type EditableRow = {
  id: string
  problem: string
  evidence: string
  cause: string
  measure: string
  priority: Priority
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}


const PRIORITIES: Priority[] = ['高(P1)', '中(P2)', '低(P3)']

function sourceLabel(source?: string) {
  if (!source) return '未标注来源'
  if (source.includes('peer')) return '同伴评价'
  if (source.includes('self')) return '教师自评'
  if (source.includes('audio')) return '课堂录音'
  if (source.includes('design')) return '教学设计'
  if (source.includes('ai')) return 'AI模型评价'

  return source
}

function normalizeText(value: string) {
  return value.replace(/\|/g, '｜').replace(/\n/g, '<br/>').trim()
}

function buildEvidence(problem: Problem) {
  const evidence = Array.isArray(problem.evidence) ? problem.evidence as EvidenceItem[] : []
  if (evidence.length > 0) {
    return evidence
      .map((e, i) => {
        const text = String(e?.text ?? '').trim()
        if (!text) return ''
        return `证据${i + 1}（${sourceLabel(e?.source)}）：${text}`
      })
      .filter(Boolean)
      .slice(0, 2)
      .join('\n')
  }

  const src = (problem.source ?? []).map(sourceLabel).join('、')
  return src ? `证据来源：${src}` : '证据：暂无直接引文'
}

function buildMarkdownTable(rows: EditableRow[]) {
  return [
    '| 存在的问题（来源标注） | 原因分析 | 改进措施与计划（优先级） |',
    '| --- | --- | --- |',
    ...(rows.length
      ? rows.map(r => `| ${normalizeText(r.problem)}<br/>${normalizeText(r.evidence)} | ${normalizeText(r.cause)} | [${r.priority}] ${normalizeText(r.measure)} |`)
      : ['| （暂无） | （暂无） | （暂无） |']),
  ].join('\n')
}

const SECTION_2_TITLE = '三、总结与展望'


function parseDraftToSections(text: string) {
  const titleCandidates = [SECTION_2_TITLE, '二、总结与展望', '二、对本次反思活动的总结和未来展望是否科学可行']

  for (const title of titleCandidates) {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const overviewMatch = text.match(new RegExp(`一、课堂概述\\s*([\\s\\S]*?)\\n\\s*${escapedTitle}`))
    const outlookMatch = text.match(new RegExp(`${escapedTitle}\\s*([\\s\\S]*)$`))
    if (overviewMatch || outlookMatch) {
      return {
        overview: overviewMatch?.[1]?.trim() ?? '',
        outlook: outlookMatch?.[1]?.trim() ?? '',
      }
    }
  }

  return { overview: '', outlook: '' }
}



export default function Stage4Report({
  session,
  problems,
  causes,
  measures,
  report,
  setReport,
  onFinish,
  onAnalyze,
  analyzing,
  analysisError,
}: Props) {
  const supabase = createClient()
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [overview, setOverview] = useState('')
  const [outlook, setOutlook] = useState('')
  const [rows, setRows] = useState<EditableRow[]>([])
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: '我是总结与展望引导助手。我们先从第一步开始：本次反思中，你经历了哪些关键分析步骤？',
    },
  ])


  const confirmedProblems = useMemo(
    () => problems.filter(p => p.confirmed).sort((a, b) => a.sort_order - b.sort_order),
    [problems]
  )
  const confirmedCauses = useMemo(
    () => causes.filter(c => c.confirmed).sort((a, b) => a.sort_order - b.sort_order),
    [causes]
  )
  const confirmedMeasures = useMemo(
    () => measures.filter(m => m.confirmed).sort((a, b) => a.sort_order - b.sort_order),
    [measures]
  )

  useEffect(() => {
    const generatedRows: EditableRow[] = []

    confirmedMeasures.forEach((m, idx) => {
      const problem = confirmedProblems.find(p => p.id === m.problem_id)
      const cause = confirmedCauses.find(c => c.id === m.cause_id)
      const fallbackCause = confirmedCauses.find(c => c.problem_id === m.problem_id)
      const priority: Priority = idx < 3 ? '高(P1)' : idx < 6 ? '中(P2)' : '低(P3)'

      generatedRows.push({
        id: m.id,
        problem: problem?.description ?? '（未关联问题）',
        evidence: problem ? buildEvidence(problem) : '证据：暂无',
        cause: cause?.description ?? fallbackCause?.description ?? '（未关联归因）',
        measure: m.description,
        priority,
      })
    })

    if (!generatedRows.length) {
      confirmedProblems.forEach((p, idx) => {
        const cause = confirmedCauses.find(c => c.problem_id === p.id)
        generatedRows.push({
          id: `problem-${p.id}`,
          problem: p.description,
          evidence: buildEvidence(p),
          cause: cause?.description ?? '（未关联归因）',
          measure: '（请填写改进措施）',
          priority: idx < 3 ? '高(P1)' : idx < 6 ? '中(P2)' : '低(P3)',
        })
      })
    }

    setRows(generatedRows)
  }, [confirmedProblems, confirmedCauses, confirmedMeasures])

  useEffect(() => {
    const text = report?.content ?? report?.ai_draft ?? ''
    if (!text) return
    const parsed = parseDraftToSections(text)
    if (parsed.overview) setOverview(parsed.overview)
    if (parsed.outlook) setOutlook(parsed.outlook)
  }, [report?.id, report?.content, report?.ai_draft])


  const autoSaveDraft = useCallback(async () => {
    if (!report) return
    const draftText = [
      '一、课堂概述',
      overview,
      '',
      SECTION_2_TITLE,
      outlook,
    ].join('\n')

    await supabase.from('reflection_reports').update({ content: draftText }).eq('id', report.id)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [outlook, overview, report, supabase])

  useEffect(() => {
    if (!report) return
    const t = setTimeout(() => { void autoSaveDraft() }, 3000)
    return () => clearTimeout(t)
  }, [report, autoSaveDraft])


  function updateRow(id: string, key: keyof EditableRow, value: string) {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, [key]: value } : r)))
  }

  async function sendChatMessage(raw: string) {
    const content = raw.trim()
    if (!content || chatLoading) return

    const nextMessages: ChatMessage[] = [...chatMessages, { role: 'user', content }]
    setChatMessages(nextMessages)
    setChatInput('')
    setChatError('')
    setChatLoading(true)
    void appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 4,
      action: '机器人对话-教师提问',
      targetType: 'report',
      targetId: report?.id,
      summary: '教师向总结与展望引导助手发送消息',
      after: content.slice(0, 2000),
    }).catch(() => undefined)

    try {
      const res = await fetch('/api/ai/summary-coach-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.id,
          outlookDraft: outlook,
          messages: nextMessages,
        }),
      })

      const payload = await res.json().catch(() => null) as { error?: string; reply?: string } | null
      if (!res.ok) throw new Error(payload?.error ?? '总结与展望对话失败')

      const reply = String(payload?.reply ?? '').trim() || '我已收到。请继续补充具体教学情境与思考变化。'
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }])
      void appendSessionOperationLog(supabase, session.id, {
        at: new Date().toISOString(),
        stage: 4,
        action: '机器人对话-助手回复',
        targetType: 'report',
        targetId: report?.id,
        summary: '总结与展望引导助手回复消息',
        after: reply.slice(0, 2000),
      }).catch(() => undefined)
    } catch (err: unknown) {
      setChatError(err instanceof Error ? err.message : '总结与展望对话失败')
    } finally {
      setChatLoading(false)
    }
  }


  const askTemplates = [
    '本次反思中，你经历了哪些关键分析步骤？',
    '在哪一步你对问题理解发生了变化？',
    '你对教学有哪些新的认识？',
    '今后你最优先改进什么？如何判断有效？',
  ]

  async function finalize() {

    setSaving(true)

    const finalTable = buildMarkdownTable(rows)
    const finalContent = [
      '【问题-归因-改进措施对照表】',
      finalTable,
      '',
      '一、课堂概述',
      overview.trim(),
      '',
      SECTION_2_TITLE,
      outlook.trim(),
    ].join('\n')


    let reportId = report?.id
    let reportData: ReflectionReport | null = null

    if (!reportId) {
      const { data } = await supabase
        .from('reflection_reports')
        .insert({ session_id: session.id, ai_draft: finalContent, content: finalContent, finalized_at: new Date().toISOString() })
        .select().single()
      if (data) {
        reportData = data
        reportId = data.id
      }
    } else {
      const { data } = await supabase
        .from('reflection_reports')
        .update({ ai_draft: finalContent, content: finalContent, finalized_at: new Date().toISOString() })
        .eq('id', reportId).select().single()
      if (data) reportData = data
    }

    const { data: latestSession } = await supabase
      .from('reflection_sessions')
      .select('draft_snapshot')
      .eq('id', session.id)
      .maybeSingle()

    const prevSnapshot = ((latestSession?.draft_snapshot ?? session.draft_snapshot ?? {}) as Record<string, unknown>)
    const nextSnapshot = {
      ...prevSnapshot,
      final_report_payload: {
        rows,
        overview: overview.trim(),
        outlook: outlook.trim(),
        submitted_at: new Date().toISOString(),
      },
    }


    await supabase
      .from('reflection_sessions')
      .update({ status: 'done', current_stage: 4, draft_snapshot: nextSnapshot })
      .eq('id', session.id)

    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 4,
      action: '提交最终报告',
      targetType: 'report',
      targetId: reportId,
      summary: '教师提交最终反思报告并结束本次反思',
      after: `课堂概述字数：${overview.trim().length}；总结与展望字数：${outlook.trim().length}`,
    })

    if (reportData) setReport(reportData)

    onFinish()
    setSaving(false)
    router.refresh()
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">阶段 4 — 撰写反思报告</h2>
          <p className="text-gray-500 text-sm mt-1">可编辑表格后，完成课堂概述与总结展望并提交结束反思</p>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-green-600">已自动保存草稿</span>}
          <button onClick={onAnalyze} disabled={analyzing}
            className="text-sm bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
            {analyzing ? '生成中…' : '🤖 AI 生成正文草稿'}
          </button>
        </div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-4 text-sm text-gray-500">
        问题 {confirmedProblems.length} 条 · 归因 {confirmedCauses.length} 条 · 措施 {confirmedMeasures.length} 条
      </div>

      {analysisError && <p className="text-red-500 text-sm mb-4">{analysisError}</p>}
      {analyzing && <p className="text-blue-600 text-sm mb-4">正在生成课堂概述与“科学可行性”总结展望草稿，请稍候…</p>}


      <div className="mb-6 border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <p className="text-sm font-medium text-gray-800">问题-归因-改进措施对照表（可编辑）</p>
          <p className="text-xs text-gray-500 mt-1">提交时保存当前编辑结果（含来源与优先级）</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-100 text-gray-700">
                <th className="text-left px-3 py-2 border-b border-gray-200 w-[28%]">存在的问题（来源标注）</th>
                <th className="text-left px-3 py-2 border-b border-gray-200 w-[27%]">原因分析</th>
                <th className="text-left px-3 py-2 border-b border-gray-200 w-[35%]">改进措施与计划</th>
                <th className="text-left px-3 py-2 border-b border-gray-200 w-[10%]">优先级</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-3 py-3 border-b border-gray-100">
                    <textarea
                      value={`${row.problem}\n${row.evidence}`}
                      onChange={e => {
                        const lines = e.target.value.split('\n')
                        updateRow(row.id, 'problem', lines[0] ?? '')
                        updateRow(row.id, 'evidence', lines.slice(1).join('\n'))
                      }}
                      rows={5}
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                    />
                  </td>
                  <td className="px-3 py-3 border-b border-gray-100">
                    <textarea
                      value={row.cause}
                      onChange={e => updateRow(row.id, 'cause', e.target.value)}
                      rows={5}
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                    />
                  </td>
                  <td className="px-3 py-3 border-b border-gray-100">
                    <textarea
                      value={row.measure}
                      onChange={e => updateRow(row.id, 'measure', e.target.value)}
                      rows={5}
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                    />
                  </td>
                  <td className="px-3 py-3 border-b border-gray-100">
                    <select
                      value={row.priority}
                      onChange={e => updateRow(row.id, 'priority', e.target.value as Priority)}
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {PRIORITIES.map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">一、课堂概述</label>
          <textarea
            value={overview}
            onChange={e => setOverview(e.target.value)}
            rows={6}
            placeholder="概述本节课教学目标、实施过程与课堂表现。"
            className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{SECTION_2_TITLE}</label>
          <div className="space-y-4">
            <textarea
              value={outlook}
              onChange={e => setOutlook(e.target.value)}
              rows={8}
              placeholder="请按（1）整体反思总结（2）教学认知提升（3）可迁移经验（4）未来改进方向撰写。"
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />

            <aside className="rounded-xl border border-blue-200 bg-blue-50 p-4">

              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">AI</div>
                <div>
                  <p className="text-base font-semibold text-blue-900">总结与展望引导助手</p>
                  <p className="text-xs text-blue-700">帮助你完成“反思的再反思”</p>
                </div>
              </div>

              {!chatOpen ? (
                <button
                  type="button"
                  onClick={() => setChatOpen(true)}
                  className="w-full px-3 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
                >
                  打开对话面板
                </button>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-medium text-blue-900">对话面板</p>
                    <button
                      type="button"
                      onClick={() => setChatOpen(false)}
                      className="text-xs text-blue-700 hover:underline"
                    >
                      收起
                    </button>
                  </div>

                  <div className="bg-white border border-blue-100 rounded-lg p-3 h-56 overflow-y-auto space-y-2">
                    {chatMessages.map((m, idx) => (
                      <div
                        key={`${m.role}-${idx}`}
                        className={m.role === 'assistant' ? 'text-sm px-3 py-2 rounded-lg whitespace-pre-wrap bg-blue-50 text-blue-900' : 'text-sm px-3 py-2 rounded-lg whitespace-pre-wrap bg-gray-100 text-gray-800'}
                      >
                        {m.content}
                      </div>
                    ))}
                    {chatLoading && <p className="text-xs text-blue-600">总结与展望引导助手正在思考…</p>}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {askTemplates.map(t => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => void sendChatMessage(t)}
                        disabled={chatLoading}
                        className="text-xs px-2.5 py-1.5 rounded-full border border-blue-200 text-blue-700 bg-white hover:bg-blue-50 disabled:opacity-40"
                      >
                        {t}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 flex gap-2">
                    <textarea
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      placeholder="输入你的总结思路、认知变化或未来改进计划…"
                      rows={3}
                      className="flex-1 border border-blue-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault()
                          void sendChatMessage(chatInput)
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void sendChatMessage(chatInput)}
                      disabled={chatLoading || !chatInput.trim()}
                      className="px-4 py-2 h-fit bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm rounded-lg"
                    >
                      发送
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">提示：按 Ctrl/⌘ + Enter 快速发送。助手将按“总结→提升→迁移→展望”递进引导，不做长篇泛化分析。</p>
                  {chatError && <p className="mt-2 text-sm text-red-600">{chatError}</p>}
                </>
              )}
            </aside>
          </div>
        </div>

      </div>

      <div className="flex justify-end gap-3 mt-4">
        <button
          onClick={finalize}
          disabled={saving || rows.length === 0 || !overview.trim() || !outlook.trim()}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? '提交中…' : '提交并结束本次反思'}
        </button>
      </div>
    </div>
  )
}
