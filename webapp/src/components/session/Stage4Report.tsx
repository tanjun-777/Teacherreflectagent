'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, Cause, Measure, ReflectionReport } from '@/types'
import { appendSessionOperationLog } from '@/lib/session-audit'
import { cn } from '@/lib/utils'


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

type PhaseAssumption = { original_clue: string; explicated: string }
type PhaseExamination = { assumption: string; method: string; conclusion: string }
type PhaseNewUnderstanding = { based_on: string; statement: string }
type PhaseAction = { context: string; time: string; method: string; expected_effect: string }

type PhaseResults = {
  1?: { status: 'completed'; assumptions: PhaseAssumption[]; summary: string }
  2?: { status: 'completed'; examinations: PhaseExamination[]; summary: string }
  3?: { status: 'completed'; new_understandings: PhaseNewUnderstanding[]; summary: string }
  4?: { status: 'completed'; actions: PhaseAction[]; summary: string }
}

const PRIORITIES: Priority[] = ['高(P1)', '中(P2)', '低(P3)']

const PHASE_LABELS: Record<number, string> = {
  1: '既有假设外显',
  2: '批判性检视',
  3: '新认识形成',
  4: '行动重构',
}

// 反思深化结构化框架：各阶段样式与占位说明（结构提前展示，完成后自动填充结果）
const PHASE_FRAMEWORK: Record<number, {
  label: string
  placeholder: string
  completedBox: string
  activeBox: string
  headerText: string
  subText: string
  accentText: string
}> = {
  1: {
    label: 'Phase 1 ｜ 既有假设外显',
    placeholder: '本阶段将通过对话识别并明确陈述对照表中隐含的假设，产出外显假设（原文线索 → 外显表述）。',
    completedBox: 'bg-blue-50 border-blue-200',
    activeBox: 'border-2 border-blue-400 bg-blue-50/40',
    headerText: 'text-blue-900',
    subText: 'text-blue-800',
    accentText: 'text-blue-500',
  },
  2: {
    label: 'Phase 2 ｜ 批判性检视',
    placeholder: '本阶段将对每条外显假设从证据、逻辑、替代解释与偏见等维度进行检视，产出检视结论。',
    completedBox: 'bg-orange-50 border-orange-200',
    activeBox: 'border-2 border-orange-400 bg-orange-50/40',
    headerText: 'text-orange-900',
    subText: 'text-orange-800',
    accentText: 'text-orange-500',
  },
  3: {
    label: 'Phase 3 ｜ 新认识形成',
    placeholder: '本阶段将基于检视结论整合形成新的教学认识（检视依据 → 新认识表述）。',
    completedBox: 'bg-purple-50 border-purple-200',
    activeBox: 'border-2 border-purple-400 bg-purple-50/40',
    headerText: 'text-purple-900',
    subText: 'text-purple-800',
    accentText: 'text-purple-500',
  },
  4: {
    label: 'Phase 4 ｜ 行动重构',
    placeholder: '本阶段将把新认识转化为可执行的行动计划（情境 + 时间 + 方式 + 预期效果）。',
    completedBox: 'bg-green-50 border-green-200',
    activeBox: 'border-2 border-green-400 bg-green-50/40',
    headerText: 'text-green-900',
    subText: 'text-green-800',
    accentText: 'text-green-600',
  },
}

function sourceLabel(source?: string) {
  if (!source) return '未标注来源'
  if (source.includes('peer')) return '同伴评价'
  if (source.includes('self')) return '教师自评'
  if (source.includes('audio')) return '课堂录音'
  if (source.includes('design')) return '教学设计'
  if (source.includes('ai')) return 'AI模型评价'
  return source
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

function normalizeText(value: string) {
  return value.replace(/\|/g, '｜').replace(/\n/g, '<br/>').trim()
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
  const [rows, setRows] = useState<EditableRow[]>([])

  // 反思深化状态
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: '我是教学反思深化引导助手。我们将通过四个阶段——既有假设外显、批判性检视、新认识形成、行动重构——来审视和深化你的教学反思。我们先从第一步开始：在你的问题-归因-改进措施对照表中，你注意到哪些隐含的假设？',
    },
  ])
  const [currentPhase, setCurrentPhase] = useState<1 | 2 | 3 | 4>(1)
  const [phaseResults, setPhaseResults] = useState<PhaseResults>({})
  // 各阶段教师实质性输入次数（防止无输入跳过阶段）
  const [phaseInputCounts, setPhaseInputCounts] = useState<Record<number, number>>({})

  // 从 draft_snapshot 恢复已保存的反思深化数据
  useEffect(() => {
    const snapshot = (session.draft_snapshot ?? {}) as Record<string, unknown>
    const savedDialogue = snapshot.deepening_dialogue as ChatMessage[] | undefined
    if (savedDialogue && Array.isArray(savedDialogue) && savedDialogue.length > 0) {
      setChatMessages(savedDialogue)
    }
    const savedResults = snapshot.deepening_results as PhaseResults | undefined
    if (savedResults) {
      setPhaseResults(savedResults)
      // 确定当前阶段
      if (savedResults[4]?.status === 'completed') {
        setCurrentPhase(4)
      } else if (savedResults[3]?.status === 'completed') {
        setCurrentPhase(4)
      } else if (savedResults[2]?.status === 'completed') {
        setCurrentPhase(3)
      } else if (savedResults[1]?.status === 'completed') {
        setCurrentPhase(2)
      }
    }
    const savedInputCounts = snapshot.deepening_phase_inputs as Record<number, number> | undefined
    if (savedInputCounts) {
      setPhaseInputCounts(savedInputCounts)
    }
  }, [session.draft_snapshot])

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


  // 保存对话内容、阶段结果和各阶段输入计数到 draft_snapshot
  const saveDeepeningData = useCallback(async (messages: ChatMessage[], results: PhaseResults, inputCounts: Record<number, number>) => {
    const { data: latestSession } = await supabase
      .from('reflection_sessions')
      .select('draft_snapshot')
      .eq('id', session.id)
      .maybeSingle()

    const prevSnapshot = ((latestSession?.draft_snapshot ?? session.draft_snapshot ?? {}) as Record<string, unknown>)
    const nextSnapshot = {
      ...prevSnapshot,
      deepening_dialogue: messages,
      deepening_results: results,
      deepening_phase_inputs: inputCounts,
    }

    await supabase
      .from('reflection_sessions')
      .update({ draft_snapshot: nextSnapshot })
      .eq('id', session.id)
  }, [session.id, session.draft_snapshot, supabase])

  function updateRow(id: string, key: keyof EditableRow, value: string) {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, [key]: value } : r)))
  }

  async function sendChatMessage(raw: string, opts?: { countsAsInput?: boolean }) {
    const content = raw.trim()
    if (!content || chatLoading) return

    // 统计教师实质性输入（自动确认/回退消息不计入）
    const countsAsInput = opts?.countsAsInput !== false
    const nextInputCounts = countsAsInput
      ? { ...phaseInputCounts, [currentPhase]: (phaseInputCounts[currentPhase] ?? 0) + 1 }
      : phaseInputCounts
    if (countsAsInput) setPhaseInputCounts(nextInputCounts)

    const nextMessages: ChatMessage[] = [...chatMessages, { role: 'user', content }]
    setChatMessages(nextMessages)
    setChatInput('')
    setChatError('')
    setChatLoading(true)
    void appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 4,
      action: '反思深化-教师提问',
      targetType: 'deepening',
      summary: `教师在Phase${currentPhase}（${PHASE_LABELS[currentPhase]}）发送消息`,
      after: content.slice(0, 2000),
    }).catch(() => undefined)

    try {
      const res = await fetch('/api/ai/deepening-coach-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.id,
          messages: nextMessages,
          current_phase: currentPhase,
          phase_results: phaseResults,
          phase_user_inputs: nextInputCounts[currentPhase] ?? 0,
        }),
      })

      const payload = await res.json().catch(() => null) as {
        error?: string
        reply?: string
        phase_result?: { phase: number; data: Record<string, unknown> }
        phase_completed?: boolean
      } | null

      if (!res.ok) throw new Error(payload?.error ?? '反思深化对话失败')

      const reply = String(payload?.reply ?? '').trim() || '我已收到。请继续补充你的思考。'
      const updatedMessages = [...nextMessages, { role: 'assistant' as const, content: reply }]
      setChatMessages(updatedMessages)

      void appendSessionOperationLog(supabase, session.id, {
        at: new Date().toISOString(),
        stage: 4,
        action: '反思深化-助手回复',
        targetType: 'deepening',
        summary: `反思深化助手在Phase${currentPhase}回复消息`,
        after: reply.slice(0, 2000),
      }).catch(() => undefined)

      // 如果阶段完成，保存阶段结果
      if (payload?.phase_completed && payload?.phase_result) {
        const { phase: completedPhase, data } = payload.phase_result
        const updatedResults: PhaseResults = {
          ...phaseResults,
          [completedPhase]: { status: 'completed', ...(data as Record<string, unknown>) } as PhaseResults[1],
        }
        setPhaseResults(updatedResults)

        // 自动进入下一阶段
        if (completedPhase < 4) {
          const nextPhase = (completedPhase + 1) as 1 | 2 | 3 | 4
          setCurrentPhase(nextPhase)
        }

        void appendSessionOperationLog(supabase, session.id, {
          at: new Date().toISOString(),
          stage: 4,
          action: `反思深化-Phase${completedPhase}完成`,
          targetType: 'deepening',
          summary: `Phase${completedPhase}（${PHASE_LABELS[completedPhase]}）完成确认`,
          after: JSON.stringify(data).slice(0, 2000),
        }).catch(() => undefined)

        // 保存对话和阶段结果
        await saveDeepeningData(updatedMessages, updatedResults, nextInputCounts)
      } else {
        // 仅保存对话
        await saveDeepeningData(updatedMessages, phaseResults, nextInputCounts)
      }
    } catch (err: unknown) {
      setChatError(err instanceof Error ? err.message : '反思深化对话失败')
    } finally {
      setChatLoading(false)
    }
  }

  // 手动确认当前阶段完成（必须已有教师实质性输入，禁止无输入跳过阶段）
  async function manualConfirmPhase() {
    if (chatLoading) return
    if ((phaseInputCounts[currentPhase] ?? 0) < 1) {
      setChatError('请先在当前阶段输入至少一条你的思考，再确认完成并进入下一阶段。')
      return
    }
    await sendChatMessage('确认完成，进入下一阶段', { countsAsInput: false })
  }

  // 回退到上一阶段
  async function goBackPhase() {
    if (currentPhase <= 1) return
    const prevPhase = (currentPhase - 1) as 1 | 2 | 3 | 4
    setCurrentPhase(prevPhase)
    await sendChatMessage('我想回到上一阶段重新思考', { countsAsInput: false })
  }

  const askTemplates: Record<number, string[]> = {
    1: [
      '你注意到了哪些隐含的假设？',
      '这句话背后隐含了什么因果关系？',
      '能举个例子说明你的假设吗？',
    ],
    2: [
      '你有什么证据支持这个假设？',
      '有没有反例或替代解释？',
      '这个假设是否隐含了某种偏见？',
    ],
    3: [
      '经过检视，你有了什么新的认识？',
      '这和之前的假设有什么不同？',
      '你如何整合这些发现？',
    ],
    4: [
      '你接下来打算怎么做？',
      '在什么环节实施这个行动？',
      '如何验证行动是否有效？',
    ],
  }

  // 渲染已完成阶段的结构化结果
  function renderPhaseResults(p: 1 | 2 | 3 | 4) {
    const cfg = PHASE_FRAMEWORK[p]
    const emptyTip = <p className="text-sm text-gray-500">（本阶段未产出结构化条目，可回退阶段后重新完成）</p>

    if (p === 1) {
      const items = phaseResults[1]?.assumptions ?? []
      if (!items.length) return emptyTip
      return items.map((a, i) => (
        <div key={i} className={cn('text-sm mb-2', cfg.subText)}>
          <p className={cn('text-xs', cfg.accentText)}>假设 {i + 1}</p>
          <p>原文线索：{a.original_clue}</p>
          <p>外显表述：{a.explicated}</p>
        </div>
      ))
    }
    if (p === 2) {
      const items = phaseResults[2]?.examinations ?? []
      if (!items.length) return emptyTip
      return items.map((e, i) => (
        <div key={i} className={cn('text-sm mb-2', cfg.subText)}>
          <p className={cn('text-xs', cfg.accentText)}>假设 {i + 1} 检视</p>
          <p>检视方式：{e.method}</p>
          <p>检视结论：{e.conclusion}</p>
        </div>
      ))
    }
    if (p === 3) {
      const items = phaseResults[3]?.new_understandings ?? []
      if (!items.length) return emptyTip
      return items.map((n, i) => (
        <div key={i} className={cn('text-sm mb-2', cfg.subText)}>
          <p className={cn('text-xs', cfg.accentText)}>新认识 {i + 1}</p>
          <p>基于：{n.based_on}</p>
          <p>表述：{n.statement}</p>
        </div>
      ))
    }
    const items = phaseResults[4]?.actions ?? []
    if (!items.length) return emptyTip
    return items.map((a, i) => (
      <div key={i} className={cn('text-sm mb-2', cfg.subText)}>
        <p className={cn('text-xs', cfg.accentText)}>行动 {i + 1}</p>
        <p>情境：{a.context}</p>
        <p>时间：{a.time}</p>
        <p>方式：{a.method}</p>
        <p>预期效果：{a.expected_effect}</p>
      </div>
    ))
  }

  async function finalize() {
    setSaving(true)

    const finalTable = buildMarkdownTable(rows)
    const deepeningSummary = [
      'Phase 1 ｜ 既有假设外显',
      ...(phaseResults[1]?.assumptions ?? []).map((a, i) => `假设${i + 1}（线索：${a.original_clue}）：${a.explicated}`),
      '',
      'Phase 2 ｜ 批判性检视',
      ...(phaseResults[2]?.examinations ?? []).map((e, i) => `假设${i + 1}检视（${e.method}）：${e.conclusion}`),
      '',
      'Phase 3 ｜ 新认识形成',
      ...(phaseResults[3]?.new_understandings ?? []).map((n, i) => `新认识${i + 1}（基于${n.based_on}）：${n.statement}`),
      '',
      'Phase 4 ｜ 行动重构',
      ...(phaseResults[4]?.actions ?? []).map((a, i) => `行动${i + 1}：在${a.context}，${a.time}，${a.method}，预期${a.expected_effect}`),
    ].join('\n')

    const finalContent = [
      '【问题-归因-改进措施对照表】',
      finalTable,
      '',
      '【教学反思深化结果】',
      deepeningSummary,
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
        deepening_results: phaseResults,
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
      action: '提交最终反思报告',
      targetType: 'report',
      targetId: reportId,
      summary: '教师提交最终反思报告并结束本次反思',
      after: `反思深化阶段完成情况：Phase1=${phaseResults[1]?.status ?? '未完成'}，Phase2=${phaseResults[2]?.status ?? '未完成'}，Phase3=${phaseResults[3]?.status ?? '未完成'}，Phase4=${phaseResults[4]?.status ?? '未完成'}`,
    })

    if (reportData) setReport(reportData)

    onFinish()
    setSaving(false)
    router.refresh()
  }

  const allPhasesCompleted = phaseResults[4]?.status === 'completed'
  const completedPhases = Object.keys(phaseResults).filter(k => phaseResults[k as unknown as '1' | '2' | '3' | '4']?.status === 'completed').length

  return (
    <div className="p-6 max-w-[1440px] mx-auto">
      <div className="grid grid-cols-[minmax(0,1fr)_460px] gap-6 items-start">

        {/* 左侧主区域 */}
        <div>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-gray-900">阶段 4 — 教学反思审视与深化</h2>
              <p className="text-gray-500 text-sm mt-1">确认对照表内容，通过AI引导完成四阶段反思深化（假设外显→批判性检视→新认识形成→行动重构）</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={onAnalyze} disabled={analyzing}
                className="text-sm bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                {analyzing ? '生成中…' : '🔄 重新分析'}
              </button>
            </div>
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-4 text-sm text-gray-500">
            问题 {confirmedProblems.length} 条 · 归因 {confirmedCauses.length} 条 · 措施 {confirmedMeasures.length} 条 · 反思深化 {completedPhases}/4 阶段完成
          </div>

          {analysisError && <p className="text-red-500 text-sm mb-4">{analysisError}</p>}
          {analyzing && <p className="text-blue-600 text-sm mb-4">正在自动生成改进措施，请稍候…</p>}

          {/* 问题-归因-改进措施对照表 */}
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

          {/* 反思深化结构化框架（提前显示，阶段完成后自动填充结果） */}
          <div className="mb-6 border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
              <p className="text-sm font-medium text-gray-800">反思深化结构化框架（四阶段）</p>
              <p className="text-xs text-gray-500 mt-1">框架提前展示；与右侧引导助手对话，每完成一个阶段，该阶段结果将自动填充到对应区域</p>
            </div>
            <div className="p-4 space-y-3">
              {([1, 2, 3, 4] as const).map(p => {
                const cfg = PHASE_FRAMEWORK[p]
                const isCompleted = phaseResults[p]?.status === 'completed'
                const isActive = !isCompleted && p === currentPhase
                return (
                  <div
                    key={p}
                    className={cn(
                      'rounded-xl border p-4 transition-colors',
                      isCompleted ? cfg.completedBox : isActive ? cfg.activeBox : 'border-dashed border-gray-300 bg-gray-50/60'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className={cn('text-sm font-medium', isCompleted || isActive ? cfg.headerText : 'text-gray-500')}>
                        {cfg.label}
                      </p>
                      <span
                        className={cn(
                          'text-xs px-2 py-0.5 rounded-full shrink-0',
                          isCompleted ? 'bg-green-500 text-white' : isActive ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'
                        )}
                      >
                        {isCompleted ? '✓ 已完成' : isActive ? '进行中' : '待完成'}
                      </span>
                    </div>

                    {isCompleted ? (
                      renderPhaseResults(p)
                    ) : isActive ? (
                      <div>
                        <p className="text-sm text-gray-600">{cfg.placeholder}</p>
                        <p className="text-xs text-gray-500 mt-2">请在右侧&ldquo;教学反思深化引导助手&rdquo;对话面板中输入你的思考并完成本阶段（至少一条输入后方可确认完成，不可跳过）。</p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-sm text-gray-500">{cfg.placeholder}</p>
                        <p className="text-xs text-gray-400 mt-2">阶段结果将在对话完成后自动填充到此处</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-4">
            <button
              onClick={finalize}
              disabled={saving || rows.length === 0}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {saving ? '提交中…' : '提交并结束反思深化'}
            </button>
          </div>
        </div>

        {/* 右侧 AI 助手 */}
        <aside className="sticky top-6 rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">AI</div>
            <div>
              <p className="text-base font-semibold text-blue-900">教学反思深化引导助手</p>
              <p className="text-xs text-blue-700">帮助教师完成初步教学反思结果"问题-归因-改进措施对照表"的审视和反思深化</p>
            </div>
          </div>

          {/* 当前阶段指示器 */}
          <div className="flex items-center gap-1 mb-3">
            {[1, 2, 3, 4].map(p => (
              <div key={p} className="flex items-center flex-1">
                <div className={cn(
                  'w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0',
                  phaseResults[p as unknown as '1' | '2' | '3' | '4']?.status === 'completed'
                    ? 'bg-green-500 text-white'
                    : p === currentPhase
                      ? 'bg-blue-600 text-white ring-2 ring-blue-200'
                      : 'bg-gray-200 text-gray-400'
                )}>
                  {phaseResults[p as unknown as '1' | '2' | '3' | '4']?.status === 'completed' ? '✓' : p}
                </div>
                {p < 4 && <div className={cn('flex-1 h-0.5 mx-0.5', phaseResults[p as unknown as '1' | '2' | '3' | '4']?.status === 'completed' ? 'bg-green-500' : 'bg-gray-200')} />}
              </div>
            ))}
          </div>
          <p className="text-xs text-center text-blue-700 mb-3">
            当前阶段：Phase {currentPhase} — {PHASE_LABELS[currentPhase]}
          </p>

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

              <div className="bg-white border border-blue-100 rounded-lg p-3 h-64 overflow-y-auto space-y-2">
                {chatMessages.map((m, idx) => (
                  <div
                    key={`${m.role}-${idx}`}
                    className={cn('text-sm px-3 py-2 rounded-lg whitespace-pre-wrap', m.role === 'assistant' ? 'bg-blue-50 text-blue-900' : 'bg-gray-100 text-gray-800')}
                  >
                    {m.content}
                  </div>
                ))}
                {chatLoading && <p className="text-xs text-blue-600">教学反思深化引导助手正在思考…</p>}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {askTemplates[currentPhase]?.map(t => (
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

              {/* 阶段控制按钮 */}
              <div className="mt-3 flex gap-2">
                {currentPhase > 1 && (
                  <button
                    type="button"
                    onClick={() => void goBackPhase()}
                    disabled={chatLoading}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                  >
                    ← 回退阶段
                  </button>
                )}
                {currentPhase < 4 && (
                  <button
                    type="button"
                    onClick={() => void manualConfirmPhase()}
                    disabled={chatLoading || (phaseInputCounts[currentPhase] ?? 0) < 1}
                    title={(phaseInputCounts[currentPhase] ?? 0) < 1 ? '需先在当前阶段输入至少一条内容后才能确认完成' : '确认当前阶段成果并进入下一阶段'}
                    className="text-xs px-3 py-1.5 rounded-lg border border-green-300 text-green-700 bg-green-50 hover:bg-green-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    确认Phase{currentPhase}完成 →
                  </button>
                )}
              </div>
              {currentPhase < 4 && (phaseInputCounts[currentPhase] ?? 0) < 1 && (
                <p className="mt-2 text-xs text-amber-600">请先在当前阶段输入至少一条你的思考，才能确认完成并进入下一阶段（不可跳过）。</p>
              )}

              <div className="mt-3 flex gap-2">
                <textarea
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="输入你对假设的思考、检视分析、新认识或行动计划…"
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
              <p className="mt-1 text-xs text-gray-500">提示：按 Ctrl/⌘ + Enter 快速发送。助手将按"假设外显→批判检视→新认识→行动重构"四阶段递进引导。</p>
              {chatError && <p className="mt-2 text-sm text-red-600">{chatError}</p>}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
