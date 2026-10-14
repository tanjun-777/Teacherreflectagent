'use client'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, Cause, Measure, ReflectionReport } from '@/types'
import { appendSessionOperationLog, updateDraftSnapshotFields } from '@/lib/session-audit'
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

type EditableRow = {
  id: string
  problem: string
  evidence: string
  cause: string
  measure: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

type PhaseAssumption = { original_clue: string; explicated: string }
type PhaseExamination = { assumption: string; method: string; conclusion: string }
type PhaseNewUnderstanding = { based_on: string; statement: string }
// Phase 4 旧结构（历史数据兼容渲染）
type PhaseAction = { context: string; time: string; method: string; expected_effect: string }
// Phase 4 宏观行动重构（新结构：关联认识 → 基本原则 → 实践取向）
type PhaseOrientation = { linked_understanding: string; principle: string; orientation: string }

type PhaseResults = {
  1?: { status: 'completed'; assumptions: PhaseAssumption[]; summary: string }
  2?: { status: 'completed'; examinations: PhaseExamination[]; summary: string }
  3?: { status: 'completed'; new_understandings: PhaseNewUnderstanding[]; summary: string }
  4?: { status: 'completed'; orientations?: PhaseOrientation[]; actions?: PhaseAction[]; summary: string }
}

// 单条记录的反思深化状态（对话与四阶段结果各自独立累积）
type RowDeepeningState = {
  chat: ChatMessage[]
  phase: 1 | 2 | 3 | 4
  phaseResults: PhaseResults
  phaseInputCounts: Record<number, number>
  phaseTurnCounts: Record<number, number>
}

// 反思深化总状态：当前深化对象 + 各记录独立累积结果
type DeepeningSnapshot = {
  active_row: number | null
  rows: Record<number, RowDeepeningState>
}

function initialRowState(chat: ChatMessage[]): RowDeepeningState {
  return { chat, phase: 1, phaseResults: {}, phaseInputCounts: {}, phaseTurnCounts: {} }
}

// 由已保存阶段结果推导恢复后的当前阶段
function derivePhase(results: PhaseResults): 1 | 2 | 3 | 4 {
  if (results[4]?.status === 'completed') return 4
  if (results[3]?.status === 'completed') return 4
  if (results[2]?.status === 'completed') return 3
  if (results[1]?.status === 'completed') return 2
  return 1
}

const PHASE_LABELS: Record<number, string> = {
  1: '既有假设外显',
  2: '批判性检视',
  3: '新认识形成',
  4: '宏观行动重构',
}

// 将阶段结构化结果转为中文可读摘要（写入操作日志，避免 JSON 符号噪音）
function summarizePhaseResult(phase: number, data: Record<string, unknown>): string {
  const clean = (v: unknown, n = 60) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const items = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [])
  try {
    if (phase === 1) {
      const list = items(data.assumptions)
      if (!list.length) return '未提取到有效假设'
      return `外显假设 ${list.length} 条：` + list.map((a, i) => `${i + 1}.${clean(a.explicated)}（线索：${clean(a.original_clue, 30)}）`).join('；')
    }
    if (phase === 2) {
      const list = items(data.examinations)
      if (!list.length) return '未提取到有效检视记录'
      return `检视记录 ${list.length} 条：` + list.map((e, i) => `${i + 1}.${clean(e.conclusion)}（方式：${clean(e.method, 20)}）`).join('；')
    }
    if (phase === 3) {
      const list = items(data.new_understandings)
      if (!list.length) return '未提取到有效新认识'
      return `新认识 ${list.length} 条：` + list.map((n, i) => `${i + 1}.${clean(n.statement)}`).join('；')
    }
    const orientations = items(data.orientations)
    if (orientations.length) {
      return `宏观取向 ${orientations.length} 条：` + orientations.map((o, i) => `${i + 1}.${clean(o.orientation)}（基于：${clean(o.linked_understanding, 30)}）`).join('；')
    }
    // 兼容旧结构（actions）
    const list = items(data.actions)
    if (!list.length) return '未提取到有效宏观行动取向'
    return `行动 ${list.length} 条：` + list.map((a, i) => `${i + 1}.${clean(a.method)}（情境：${clean(a.context, 30)}）`).join('；')
  } catch {
    return '阶段完成，结构化结果已存入反思报告'
  }
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
    label: 'Phase 4 ｜ 宏观行动重构',
    placeholder: '本阶段将引导你思考新的认识对今后整体教学实践（理解教学、判断教学效果、设计课堂活动、作出教学决策）的基本原则与实践取向意味着什么。',
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
  if (source.includes('audio') || source.includes('classroom')) return '课堂教学实录'
  if (source.includes('design')) return '教学设计'
  if (source.includes('performance')) return '学生表现'
  if (source.includes('outcomes')) return '学习结果'
  if (source.includes('external')) return '外部智慧教研系统反馈'
  if (source.includes('manual')) return '自主关联'
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
    '| 存在的问题 | 证据（来源标注） | 原因分析 | 改进措施与计划 |',
    '| --- | --- | --- | --- |',
    ...(rows.length
      ? rows.map(r => `| ${normalizeText(r.problem)} | ${normalizeText(r.evidence)} | ${normalizeText(r.cause)} | ${normalizeText(r.measure)} |`)
      : ['| （暂无） | （暂无） | （暂无） | （暂无） |']),
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
  const [finalizeError, setFinalizeError] = useState('')
  // 对照表：挂载时优先恢复暂存的教师编辑（draft_snapshot.stage4_table_rows）
  const [rows, setRows] = useState<EditableRow[]>(() => {
    const snapshot = (session.draft_snapshot ?? {}) as Record<string, unknown>
    const saved = snapshot.stage4_table_rows as EditableRow[] | undefined
    return saved && Array.isArray(saved) && saved.length ? saved : []
  })
  // 教师是否已手动编辑对照表：为 true 时不再用派生数据覆盖，可通过「重置为最新数据」显式重建
  const [rowsDirty, setRowsDirty] = useState(() => {
    const snapshot = (session.draft_snapshot ?? {}) as Record<string, unknown>
    const saved = snapshot.stage4_table_rows as EditableRow[] | undefined
    return Boolean(saved && Array.isArray(saved) && saved.length)
  })

  // 反思深化状态
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [currentPhase, setCurrentPhase] = useState<1 | 2 | 3 | 4>(1)
  const [phaseResults, setPhaseResults] = useState<PhaseResults>({})
  // 各阶段教师实质性输入次数（防止无输入跳过阶段）
  const [phaseInputCounts, setPhaseInputCounts] = useState<Record<number, number>>({})
  // 各阶段对话轮数（达 8 轮后端注入收敛提醒）
  const [phaseTurnCounts, setPhaseTurnCounts] = useState<Record<number, number>>({})

  // 多记录反思深化：当前深化对象 + 各记录独立累积状态（对话/阶段结果/计数）
  const [deepening, setDeepening] = useState<DeepeningSnapshot>({ active_row: null, rows: {} })

  // 从 draft_snapshot 恢复反思深化数据（新结构；兼容迁移旧单记录结构到 rows[0]）
  useEffect(() => {
    const snapshot = (session.draft_snapshot ?? {}) as Record<string, unknown>
    const saved = snapshot.deepening as DeepeningSnapshot | undefined
    if (saved && saved.rows && typeof saved.rows === 'object') {
      const restoredRows: Record<number, RowDeepeningState> = {}
      Object.entries(saved.rows).forEach(([key, value]) => {
        const idx = Number(key)
        if (Number.isInteger(idx) && idx >= 0 && value && typeof value === 'object') {
          restoredRows[idx] = value as RowDeepeningState
        }
      })
      const restored: DeepeningSnapshot = { active_row: saved.active_row ?? null, rows: restoredRows }
      setDeepening(restored)
      const active = restored.active_row
      if (active != null && restoredRows[active]) {
        const st = restoredRows[active]
        setChatMessages(st.chat ?? [])
        setCurrentPhase(st.phase ?? 1)
        setPhaseResults(st.phaseResults ?? {})
        setPhaseInputCounts(st.phaseInputCounts ?? {})
        setPhaseTurnCounts(st.phaseTurnCounts ?? {})
      }
      return
    }
    // 旧单记录结构迁移：围绕第 1 条记录开展的深化 → rows[0]
    // 旧深化数据保留在 rows[0]（选择第 1 条时无缝继续），但不默认选中，
    // 进入页面先显示选择列表，由教师自主选择深化对象
    const oldDialogue = snapshot.deepening_dialogue as ChatMessage[] | undefined
    const oldResults = snapshot.deepening_results as PhaseResults | undefined
    const oldInputs = snapshot.deepening_phase_inputs as Record<number, number> | undefined
    const oldTurns = snapshot.deepening_phase_turns as Record<number, number> | undefined
    if ((oldDialogue && Array.isArray(oldDialogue) && oldDialogue.length > 0) || oldResults) {
      const migrated: RowDeepeningState = {
        chat: Array.isArray(oldDialogue) ? oldDialogue : [],
        phase: oldResults ? derivePhase(oldResults) : 1,
        phaseResults: oldResults ?? {},
        phaseInputCounts: oldInputs ?? {},
        phaseTurnCounts: oldTurns ?? {},
      }
      setDeepening({ active_row: null, rows: { 0: migrated } })
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

  // 按最新确认数据（问题/归因/措施）构建对照表
  const buildGeneratedRows = useCallback((): EditableRow[] => {
    const generatedRows: EditableRow[] = []

    confirmedMeasures.forEach((m) => {
      const problem = confirmedProblems.find(p => p.id === m.problem_id)
      const cause = confirmedCauses.find(c => c.id === m.cause_id)
      const fallbackCause = confirmedCauses.find(c => c.problem_id === m.problem_id)

      generatedRows.push({
        id: m.id,
        problem: problem?.description ?? '（未关联问题）',
        evidence: problem ? buildEvidence(problem) : '证据：暂无',
        cause: cause?.description ?? fallbackCause?.description ?? '（未关联归因）',
        measure: m.description,
      })
    })

    if (!generatedRows.length) {
      confirmedProblems.forEach((p) => {
        const cause = confirmedCauses.find(c => c.problem_id === p.id)
        generatedRows.push({
          id: `problem-${p.id}`,
          problem: p.description,
          evidence: buildEvidence(p),
          cause: cause?.description ?? '（未关联归因）',
          measure: '（请填写改进措施）',
        })
      })
    }

    return generatedRows
  }, [confirmedProblems, confirmedCauses, confirmedMeasures])

  useEffect(() => {
    // 教师已手动编辑（或恢复了暂存）时不覆盖，避免丢失编辑
    if (rowsDirty && rows.length > 0) return
    setRows(buildGeneratedRows())
  }, [rowsDirty, rows.length, buildGeneratedRows])

  // 对照表编辑自动暂存到 draft_snapshot（防刷新/切换阶段丢失），串行队列防并发覆盖
  useEffect(() => {
    if (!rowsDirty || rows.length === 0) return
    const timer = setTimeout(() => {
      void updateDraftSnapshotFields(supabase, session.id, snap => ({
        ...snap,
        stage4_table_rows: rows,
      })).catch(() => undefined)
    }, 800)
    return () => clearTimeout(timer)
  }, [rows, rowsDirty, session.id, supabase])

  // 按最新确认数据重建对照表，并清除旧编辑暂存
  const resetRowsToLatest = useCallback(() => {
    setRows(buildGeneratedRows())
    setRowsDirty(false)
    void updateDraftSnapshotFields(supabase, session.id, snap => {
      const next = { ...snap }
      delete next.stage4_table_rows
      return next
    }).catch(() => undefined)
  }, [buildGeneratedRows, session.id, supabase])

  // 「重新分析」完成后按最新数据重建对照表
  const prevAnalyzingRef = useRef(analyzing)
  useEffect(() => {
    if (prevAnalyzingRef.current && !analyzing) {
      setRows(buildGeneratedRows())
      setRowsDirty(false)
      void updateDraftSnapshotFields(supabase, session.id, snap => {
        const next = { ...snap }
        delete next.stage4_table_rows
        return next
      }).catch(() => undefined)
    }
    prevAnalyzingRef.current = analyzing
  }, [analyzing, buildGeneratedRows, session.id, supabase])

  // 选择反思深化对象：生成该记录专属的初始问候（P1 开放式追问），并持久化
  const buildRowGreeting = useCallback((rowIndex: number, row: EditableRow) => {
    return `我是教学反思深化引导助手。我们将围绕你选定的一条反思记录，通过四个阶段——既有假设外显、批判性检视、新认识形成、宏观行动重构——来深化你的反思。\n\n【你选定的深化对象 · 第 ${rowIndex + 1} 条】\n【问题】${row.problem}\n${row.evidence}\n【归因】${row.cause}\n【措施】${row.measure}\n\n先请你回顾这条记录的整体判断：从问题、证据到归因和措施，你当时是怎样理解这次教学现象的？这样的理解背后，你默认了哪些前提或判断标准？请尝试用"我认为……是因为……"或"我判断……依据是……"来表述。`
  }, [])

  // 当前记录是否已完成四阶段深化（P4 确认完成后视为完成，方允许更换记录）
  const currentRowFinished = deepening.active_row != null
    && deepening.rows[deepening.active_row]?.phaseResults[4]?.status === 'completed'

  // 各记录完成情况（用于选择列表徽章与页头统计）
  const rowFinished = useCallback((idx: number) => deepening.rows[idx]?.phaseResults[4]?.status === 'completed', [deepening.rows])
  const finishedRowCount = useMemo(
    () => Object.keys(deepening.rows).filter(idx => rowFinished(Number(idx))).length,
    [deepening.rows, rowFinished]
  )

  // 将当前视图状态写回指定记录并持久化到 draft_snapshot
  const persistDeepening = useCallback(async (next: DeepeningSnapshot) => {
    setDeepening(next)
    await updateDraftSnapshotFields(supabase, session.id, snap => ({
      ...snap,
      deepening: next,
    })).catch(() => undefined)
  }, [session.id, supabase])

  // 选择/切换深化对象：前一条未完成四阶段时禁止更换
  const selectRow = useCallback((idx: number) => {
    if (chatLoading || !rows[idx]) return
    // 目标条已完成时可随时进入查看其结果；仅切换到未完成条才受"当前条须先完成"限制
    if (deepening.active_row != null && deepening.active_row !== idx && !currentRowFinished && !rowFinished(idx)) {
      setChatError('当前记录的反思深化尚未完成（需完成四个阶段），暂不能开展其他记录；已完成的记录可随时点击查看结果。')
      return
    }
    const prevActive = deepening.active_row
    let nextRows = { ...deepening.rows }
    // 保存当前视图到原记录
    if (prevActive != null && prevActive !== idx) {
      nextRows[prevActive] = {
        chat: chatMessages,
        phase: currentPhase,
        phaseResults,
        phaseInputCounts,
        phaseTurnCounts,
      }
    }
    // 恢复或初始化目标记录
    let target = nextRows[idx]
    if (!target) {
      target = initialRowState([{ role: 'assistant', content: buildRowGreeting(idx, rows[idx]) }])
      nextRows[idx] = target
    }
    setChatMessages(target.chat)
    setCurrentPhase(target.phase)
    setPhaseResults(target.phaseResults)
    setPhaseInputCounts(target.phaseInputCounts)
    setPhaseTurnCounts(target.phaseTurnCounts)
    setChatError('')
    setChatOpen(true)
    const isSwitch = prevActive != null && prevActive !== idx
    void persistDeepening({ active_row: idx, rows: nextRows })
    void appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 4,
      action: isSwitch ? '反思深化-更换深化对象' : '反思深化-选择深化对象',
      targetType: 'deepening',
      summary: `教师${isSwitch ? '更换' : '选择'}第 ${idx + 1} 条记录（问题：${rows[idx].problem.slice(0, 60)}）作为反思深化对象`,
      after: `第 ${idx + 1} 条：${rows[idx].problem.slice(0, 500)}`,
    }).catch(() => undefined)
  }, [chatLoading, rows, deepening, currentRowFinished, rowFinished, chatMessages, currentPhase, phaseResults, phaseInputCounts, phaseTurnCounts, buildRowGreeting, persistDeepening, supabase, session.id])


  // 保存当前记录的对话、阶段结果和计数到 draft_snapshot.deepening（串行队列防并发覆盖）
  const saveDeepeningData = useCallback(async (messages: ChatMessage[], results: PhaseResults, inputCounts: Record<number, number>, turnCounts: Record<number, number>, phaseOverride?: 1 | 2 | 3 | 4) => {
    const active = deepening.active_row
    if (active == null) return
    const next: DeepeningSnapshot = {
      active_row: active,
      rows: {
        ...deepening.rows,
        [active]: {
          chat: messages,
          phase: phaseOverride ?? currentPhase,
          phaseResults: results,
          phaseInputCounts: inputCounts,
          phaseTurnCounts: turnCounts,
        },
      },
    }
    setDeepening(next)
    await updateDraftSnapshotFields(supabase, session.id, snap => ({
      ...snap,
      deepening: next,
    }))
  }, [deepening, currentPhase, session.id, supabase])

  function updateRow(id: string, key: keyof EditableRow, value: string) {
    setRowsDirty(true)
    setRows(prev => prev.map(r => (r.id === id ? { ...r, [key]: value } : r)))
  }

  async function sendChatMessage(raw: string, opts?: { countsAsInput?: boolean; confirmPhase?: boolean; phaseResultsOverride?: PhaseResults }) {
    const content = raw.trim()
    if (!content || chatLoading) return
    const activeRow = deepening.active_row
    if (activeRow == null || !rows[activeRow]) {
      setChatError('请先在上方选择一条反思记录作为深化对象，再开始对话。')
      return
    }

    // 基准结果集：回退场景使用清除后的结果，避免旧结果继续引导对话
    const baseResults = opts?.phaseResultsOverride ?? phaseResults
    // 统计教师实质性输入（自动确认/回退消息不计入）
    const countsAsInput = opts?.countsAsInput !== false
    const nextInputCounts = countsAsInput
      ? { ...phaseInputCounts, [currentPhase]: (phaseInputCounts[currentPhase] ?? 0) + 1 }
      : phaseInputCounts
    if (countsAsInput) setPhaseInputCounts(nextInputCounts)
    // 每次请求计为一轮对话（含确认/回退消息），达阈值后端注入收敛提醒
    const nextTurnCounts = { ...phaseTurnCounts, [currentPhase]: (phaseTurnCounts[currentPhase] ?? 0) + 1 }
    setPhaseTurnCounts(nextTurnCounts)

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
      summary: `教师在记录${activeRow + 1}·Phase${currentPhase}（${PHASE_LABELS[currentPhase]}）发送消息`,
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
          phase_results: baseResults,
          phase_user_inputs: nextInputCounts[currentPhase] ?? 0,
          phase_turn_count: nextTurnCounts[currentPhase] ?? 0,
          confirm_phase: opts?.confirmPhase === true,
          focus_row: {
            index: activeRow,
            problem: rows[activeRow].problem,
            evidence: rows[activeRow].evidence,
            cause: rows[activeRow].cause,
            measure: rows[activeRow].measure,
          },
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
          ...baseResults,
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
          after: summarizePhaseResult(completedPhase, data as Record<string, unknown>).slice(0, 1000),
        }).catch(() => undefined)

        // 保存对话和阶段结果（同时记录推进后的阶段）
        await saveDeepeningData(
          updatedMessages,
          updatedResults,
          nextInputCounts,
          nextTurnCounts,
          completedPhase < 4 ? (completedPhase + 1) as 1 | 2 | 3 | 4 : 4
        )
      } else {
        // 仅保存对话
        await saveDeepeningData(updatedMessages, phaseResults, nextInputCounts, nextTurnCounts)
      }
    } catch (err: unknown) {
      // 回滚乐观更新：消息与输入/轮次计数恢复发送前状态，失败的输入不计入“实质性输入”门槛
      setChatMessages(chatMessages)
      setChatInput(content)
      setPhaseInputCounts(phaseInputCounts)
      setPhaseTurnCounts(phaseTurnCounts)
      setChatError(err instanceof Error ? err.message : '反思深化对话失败')
    } finally {
      setChatLoading(false)
    }
  }

  // 手动确认当前阶段完成（必须已有教师实质性输入，禁止无输入跳过阶段）
  async function manualConfirmPhase() {
    if (chatLoading) return
    if ((phaseInputCounts[currentPhase] ?? 0) < 1) {
      setChatError('请先在当前阶段输入至少一条你的思考，再确认完成。')
      return
    }
    // Phase 4 为最后阶段：确认后本条记录的深化即告完成
    const content = currentPhase < 4 ? '确认完成，进入下一阶段' : '确认完成，结束本条记录的反思深化'
    await sendChatMessage(content, { countsAsInput: false, confirmPhase: true })
  }

  // 回退到上一阶段：清除所回退阶段及其之后的旧结果，重新思考后产出新结果（破坏性操作，需确认）
  async function goBackPhase() {
    if (currentPhase <= 1 || chatLoading) return
    const prevPhase = (currentPhase - 1) as 1 | 2 | 3 | 4
    // 明确告知将被清除的已确认阶段结果（回退目标阶段及其后全部阶段）
    const clearingPhases = [prevPhase, prevPhase + 1, prevPhase + 2, prevPhase + 3]
      .filter(p => p <= 4 && phaseResults[p as 1 | 2 | 3 | 4]?.status === 'completed') as Array<1 | 2 | 3 | 4>
    const clearTip = clearingPhases.length
      ? `将清除 ${clearingPhases.map(p => `Phase ${p}（${PHASE_LABELS[p]}）`).join('、')} 的已确认结果`
      : '该阶段暂无已确认结果'
    if (!confirm(`确定回退到 Phase ${prevPhase}（${PHASE_LABELS[prevPhase]}）重新思考吗？\n\n${clearTip}，回退后需重新完成，此操作不可恢复。`)) return
    const clearedResults: PhaseResults = {}
    if (prevPhase > 1 && phaseResults[1]?.status === 'completed') clearedResults[1] = phaseResults[1]
    if (prevPhase > 2 && phaseResults[2]?.status === 'completed') clearedResults[2] = phaseResults[2]
    if (prevPhase > 3 && phaseResults[3]?.status === 'completed') clearedResults[3] = phaseResults[3]
    setCurrentPhase(prevPhase)
    setPhaseResults(clearedResults)
    await sendChatMessage('我想回到上一阶段重新思考', { countsAsInput: false, phaseResultsOverride: clearedResults })
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
      '这一认识对你今后的教学意味着什么？',
      '今后你判断教学效果会采用什么原则？',
      '这会怎样影响你设计课堂活动的取向？',
    ],
  }

  // 渲染已完成阶段的结构化结果
  function renderPhaseResults(p: 1 | 2 | 3 | 4) {
    const cfg = PHASE_FRAMEWORK[p]
    const emptyTip = <p className="text-xs text-gray-500">（本阶段未产出结构化条目，可回退阶段后重新完成）</p>

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
    const orientations = phaseResults[4]?.orientations ?? []
    if (orientations.length) {
      return orientations.map((o, i) => (
        <div key={i} className={cn('text-sm mb-2', cfg.subText)}>
          <p className={cn('text-xs', cfg.accentText)}>宏观取向 {i + 1}</p>
          <p>基于认识：{o.linked_understanding}</p>
          <p>基本原则：{o.principle}</p>
          <p>实践取向：{o.orientation}</p>
        </div>
      ))
    }
    // 兼容旧结构（actions）
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

  // 渲染单条记录的四阶段成果摘要（P4 兼容新旧结构）
  function renderEntrySummary(results: PhaseResults) {
    return [
      'Phase 1 ｜ 既有假设外显',
      ...(results[1]?.assumptions ?? []).map((a, i) => `假设${i + 1}（线索：${a.original_clue}）：${a.explicated}`),
      '',
      'Phase 2 ｜ 批判性检视',
      ...(results[2]?.examinations ?? []).map((e, i) => `假设${i + 1}检视（${e.method}）：${e.conclusion}`),
      '',
      'Phase 3 ｜ 新认识形成',
      ...(results[3]?.new_understandings ?? []).map((n, i) => `新认识${i + 1}（基于${n.based_on}）：${n.statement}`),
      '',
      'Phase 4 ｜ 宏观行动重构',
      ...(results[4]?.orientations?.length
        ? results[4].orientations.map((o, i) => `取向${i + 1}：基于「${o.linked_understanding}」，原则：${o.principle}；实践取向：${o.orientation}`)
        : (results[4]?.actions ?? []).map((a, i) => `行动${i + 1}：在${a.context}，${a.time}，${a.method}，预期${a.expected_effect}`)),
    ].join('\n')
  }

  async function finalize() {
    if (saving) return
    setSaving(true)
    setFinalizeError('')

    try {
      const finalTable = buildMarkdownTable(rows)

      // 汇总所有已完成四阶段深化的记录（按记录顺序逐条累积呈现）
      const finishedEntries = Object.keys(deepening.rows)
        .map(Number)
        .sort((a, b) => a - b)
        .reduce<Array<{ idx: number; problem: string; results: PhaseResults }>>((acc, idx) => {
          const st = deepening.rows[idx]
          if (st?.phaseResults[4]?.status === 'completed') {
            acc.push({ idx, problem: rows[idx]?.problem ?? `第 ${idx + 1} 条记录`, results: st.phaseResults })
          }
          return acc
        }, [])

      const deepeningSummary = finishedEntries.length
        ? finishedEntries.map((e, n) => [
            `◆ 深化记录 ${n + 1}（对照表第 ${e.idx + 1} 条）：${e.problem}`,
            renderEntrySummary(e.results),
          ].join('\n')).join('\n\n')
        : '（本次未完成任何记录的反思深化）'

      const finalContent = [
        '【问题-归因-改进措施对照表】',
        finalTable,
        '',
        '【教学反思深化结果】',
        deepeningSummary,
        ...(finishedEntries.length < rows.length
          ? [``, `说明：对照表共 ${rows.length} 条记录，本次完成反思深化 ${finishedEntries.length} 条。`]
          : []),
      ].join('\n')

      let reportId = report?.id
      let reportData: ReflectionReport | null = null

      if (!reportId) {
        const { data, error } = await supabase
          .from('reflection_reports')
          .insert({ session_id: session.id, ai_draft: finalContent, content: finalContent, finalized_at: new Date().toISOString() })
          .select().single()
        if (error || !data) {
          throw new Error(`保存反思报告失败：${error?.message ?? '未返回数据'}`)
        }
        reportData = data
        reportId = data.id
      } else {
        const { data, error } = await supabase
          .from('reflection_reports')
          .update({ ai_draft: finalContent, content: finalContent, finalized_at: new Date().toISOString() })
          .eq('id', reportId).select().single()
        if (error || !data) {
          throw new Error(`更新反思报告失败：${error?.message ?? '未返回数据'}`)
        }
        reportData = data
      }

      const { data: latestSession, error: snapErr } = await supabase
        .from('reflection_sessions')
        .select('draft_snapshot')
        .eq('id', session.id)
        .maybeSingle()
      if (snapErr) {
        throw new Error(`读取会话草稿失败：${snapErr.message}`)
      }

      const prevSnapshot = ((latestSession?.draft_snapshot ?? session.draft_snapshot ?? {}) as Record<string, unknown>)
      const compatResults = deepening.active_row != null && deepening.rows[deepening.active_row]
        ? deepening.rows[deepening.active_row].phaseResults
        : (finishedEntries[0]?.results ?? {})
      const nextSnapshot = {
        ...prevSnapshot,
        final_report_payload: {
          rows,
          deepening_records: finishedEntries.map((e, n) => ({
            order: n + 1,
            row_index: e.idx,
            problem: e.problem,
            phase_results: e.results,
          })),
          deepening_results: compatResults,
          submitted_at: new Date().toISOString(),
        },
      }

      // 报告保存成功后才结束会话：此步失败时会话保持原状态，教师可直接重试
      const { error: doneErr } = await supabase
        .from('reflection_sessions')
        .update({ status: 'done', current_stage: 4, draft_snapshot: nextSnapshot })
        .eq('id', session.id)
      if (doneErr) {
        throw new Error(`更新会话状态失败：${doneErr.message}`)
      }

      // 操作日志为辅助记录：失败不阻断已成功的提交流程
      await appendSessionOperationLog(supabase, session.id, {
        at: new Date().toISOString(),
        stage: 4,
        action: '提交最终反思报告',
        targetType: 'report',
        targetId: reportId,
        summary: '教师提交最终反思报告并结束本次反思',
        after: `反思深化完成情况：对照表共 ${rows.length} 条记录，完成深化 ${finishedEntries.length} 条${finishedEntries.length ? `（记录序号：${finishedEntries.map(e => e.idx + 1).join('、')}）` : ''}`,
      }).catch(() => undefined)

      if (reportData) setReport(reportData)

      onFinish()
      router.refresh()
    } catch (err) {
      setFinalizeError(err instanceof Error ? err.message : '提交失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-xl font-bold text-gray-900">阶段3 ｜ 初步教学反思审视与深化</h2>
              <p className="text-gray-400 text-xs mt-0.5">问题 {confirmedProblems.length} 条 · 归因 {confirmedCauses.length} 条 · 措施 {confirmedMeasures.length} 条 · 反思深化 {finishedRowCount}/{rows.length} 条记录完成</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={onAnalyze} disabled={analyzing}
                className="text-sm bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                {analyzing ? '生成中…' : '🔄 重新分析'}
              </button>
            </div>
          </div>

          {analysisError && <p className="text-red-500 text-sm mb-4">{analysisError}</p>}
          {analyzing && <p className="text-blue-600 text-sm mb-4">正在自动生成改进措施，请稍候…</p>}

          {/* 问题-归因-改进措施对照表 + 反思深化结构化框架：宽屏并排，窄屏上下堆叠 */}
          <div className="grid gap-6 items-start xl:grid-cols-[minmax(0,58%)_minmax(0,42%)] mb-6">
            <div className="border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-800">问题-归因-改进措施对照表（可编辑）</p>
                {rowsDirty && (
                  <button onClick={resetRowsToLatest}
                    className="text-xs text-blue-600 hover:text-blue-700 hover:underline whitespace-nowrap">
                    重置为最新数据
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">编辑内容自动暂存；提交时保存当前编辑结果（含来源标注）</p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-100 text-gray-700">
                    <th className="text-left px-2 py-2 border-b border-gray-200 w-[10%]">反思深化</th>
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[21%]">存在的问题</th>
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[28%]">证据（来源标注）</th>
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[20%]">原因分析</th>
                    <th className="text-left px-3 py-2 border-b border-gray-200 w-[24%]">改进措施与计划</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const rowDone = rowFinished(idx)
                    const rowInProgress = !!deepening.rows[idx] && !rowDone
                    const rowIsCurrent = deepening.active_row === idx
                    const rowLocked = deepening.active_row != null && !rowIsCurrent && !currentRowFinished && !rowDone
                    return (
                    <tr key={row.id} className={cn('align-top', rowIsCurrent && 'bg-blue-50/40')}>
                      <td className="px-2 py-2 border-b border-gray-100">
                        <div className="flex flex-col items-center gap-1.5 pt-1">
                          <span className="text-xs text-gray-500">第 {idx + 1} 条</span>
                          <span className={cn('text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap',
                            rowDone ? 'bg-green-100 text-green-700' : rowIsCurrent ? 'bg-blue-600 text-white' : rowInProgress ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500')}>
                            {rowDone ? '已完成' : rowInProgress || rowIsCurrent ? '正在进行' : '未开始'}
                          </span>
                          <button
                            type="button"
                            onClick={() => selectRow(idx)}
                            disabled={chatLoading || rowLocked}
                            title={rowLocked ? '完成当前记录四个阶段的深化后方可开展其他记录' : rowDone ? `查看第 ${idx + 1} 条记录的反思深化结果` : rowInProgress || rowIsCurrent ? `进入第 ${idx + 1} 条记录的反思深化对话` : `围绕第 ${idx + 1} 条记录开展四阶段反思深化`}
                            className="text-[11px] px-2 py-1 rounded-md border border-blue-300 text-blue-700 bg-white hover:bg-blue-50 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {rowDone ? '查看反思深化结果' : rowInProgress || rowIsCurrent ? '正在开展反思深化' : '开展反思深化'}
                          </button>
                        </div>
                      </td>
                      <td className="px-2.5 py-2 border-b border-gray-100">
                        <textarea
                          value={row.problem}
                          onChange={e => updateRow(row.id, 'problem', e.target.value)}
                          rows={3}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                        />
                      </td>
                      <td className="px-2.5 py-2 border-b border-gray-100">
                        <textarea
                          value={row.evidence}
                          onChange={e => updateRow(row.id, 'evidence', e.target.value)}
                          rows={3}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                        />
                      </td>
                      <td className="px-2.5 py-2 border-b border-gray-100">
                        <textarea
                          value={row.cause}
                          onChange={e => updateRow(row.id, 'cause', e.target.value)}
                          rows={3}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                        />
                      </td>
                      <td className="px-2.5 py-2 border-b border-gray-100">
                        <textarea
                          value={row.measure}
                          onChange={e => updateRow(row.id, 'measure', e.target.value)}
                          rows={3}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                        />
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

            {/* 反思深化结构化框架（提前显示，阶段完成后自动填充结果） */}
            <div className="border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-gray-800">反思深化结构化框架（四阶段）</p>
                {deepening.active_row != null && rows[deepening.active_row] && (
                  <span className="text-xs text-gray-500 truncate">
                    当前深化对象：第 {deepening.active_row + 1} 条 · {rows[deepening.active_row].problem.slice(0, 30)}
                  </span>
                )}
              </div>
            </div>
            <div className="p-4 space-y-2.5">
              {deepening.active_row == null && (
                <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  尚未选择深化对象：请在上方对照表中点击一条记录的「开展反思深化」按钮，围绕它开展四阶段反思深化（一次聚焦一条，完成一条后可继续下一条）。
                </p>
              )}
              {([1, 2, 3, 4] as const).map(p => {
                const cfg = PHASE_FRAMEWORK[p]
                const isCompleted = phaseResults[p]?.status === 'completed'
                const isActive = !isCompleted && p === currentPhase
                return (
                  <div
                    key={p}
                    className={cn(
                      'rounded-xl border p-3 transition-colors',
                      isCompleted ? cfg.completedBox : isActive ? cfg.activeBox : 'border-dashed border-gray-300 bg-gray-50/60'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className={cn('text-sm font-semibold', isCompleted || isActive ? cfg.headerText : 'text-gray-500')}>
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
                        <p className="text-xs text-gray-600">{cfg.placeholder}</p>
                        <p className="text-xs text-gray-400 mt-1.5">在下方对话面板输入你的思考，至少一条输入后方可确认完成（不可跳过）。</p>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400">{cfg.placeholder}（完成后自动填充）</p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          </div>

        {/* 教学反思深化引导助手（全宽，位于对照表与结构化框架下方） */}
        <aside className="rounded-xl border border-blue-200 bg-blue-50 p-4 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold shrink-0">AI</div>
            <div className="min-w-0">
              <p className="text-base font-semibold text-blue-900">教学反思深化引导助手</p>
              <p className="text-xs text-blue-700">围绕你选定的一条记录，引导完成四阶段反思深化</p>
            </div>
            {deepening.active_row != null && chatOpen && (
              <button
                type="button"
                onClick={() => setChatOpen(false)}
                className="ml-auto text-xs text-blue-700 hover:underline shrink-0"
              >
                收起对话面板
              </button>
            )}
          </div>

          {deepening.active_row == null ? (
            <div className="bg-white border border-blue-100 rounded-lg p-4 min-h-[140px]">
              <p className="text-sm text-blue-900 font-medium mb-2">选择反思深化对象</p>
              <p className="text-xs text-blue-800 leading-relaxed">
                请在上方对照表中点击一条记录的「开展反思深化」按钮，开始该条的四阶段反思深化（一次聚焦一条，完成一条后可继续下一条）。
              </p>
              {rows.length === 0 && <p className="text-xs text-amber-600 mt-2">对照表暂无记录，请先在对照表中生成或补充记录。</p>}
              <p className="text-xs text-gray-400 mt-2">各记录深化成果独立累积，均计入最终报告。</p>
            </div>
          ) : !chatOpen ? (
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="w-full px-3 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
            >
              打开对话面板
            </button>
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">

              {/* 左列：对话消息流 + 输入 */}
              <div className="flex flex-col min-w-0">
                <div className="bg-white border border-blue-100 rounded-lg p-3 flex-1 min-h-[320px] max-h-[520px] overflow-y-auto space-y-2">
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
                <div className="mt-3 flex gap-2">
                  <textarea
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    placeholder="输入你对隐含假设、审视分析、新认识或宏观行动取向的思考…"
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
                {chatError && <p className="mt-2 text-sm text-red-600">{chatError}</p>}
              </div>

              {/* 右列：深化对象、阶段进度、模板与阶段控制 */}
              <div className="flex flex-col gap-3 min-w-0">

              {/* 当前深化对象栏（完成四阶段后方可更换） */}
              {deepening.active_row != null && rows[deepening.active_row] && (
                <div className="bg-white border border-blue-100 rounded-lg px-3 py-2 mb-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-blue-800 truncate">
                      当前深化对象：第 {deepening.active_row + 1} 条 · {rows[deepening.active_row].problem.slice(0, 40)}
                    </p>
                    <span className={cn('text-xs px-2 py-0.5 rounded-full shrink-0', currentRowFinished ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700')}>
                      {currentRowFinished ? '✓ 四阶段已完成' : '深化中'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-blue-600">
                    {currentRowFinished ? '✓ 可在上方对照表点击其他记录的「开展反思深化」按钮继续下一条' : '完成四阶段后方可开展其他记录深化；已完成的记录可随时点击查看结果'}
                  </p>
                </div>
              )}

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

              {currentRowFinished && (
                <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-3">
                  本条记录的反思深化已完成。你可继续选择其他记录深化，或直接提交最终报告。
                </p>
              )}

              {/* 当前阶段引导模板 */}
              <div className="flex flex-wrap gap-2">
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
              <div className="flex gap-2">
                {currentPhase > 1 && (
                  <button
                    type="button"
                    onClick={() => void goBackPhase()}
                    disabled={chatLoading}
                    className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                  >
                    ← 回退阶段
                  </button>
                )}
                {!currentRowFinished && (
                  <button
                    type="button"
                    onClick={() => void manualConfirmPhase()}
                    disabled={chatLoading || (phaseInputCounts[currentPhase] ?? 0) < 1}
                    title={(phaseInputCounts[currentPhase] ?? 0) < 1 ? '需先在当前阶段输入至少一条内容后才能确认完成' : currentPhase < 4 ? '确认当前阶段成果并进入下一阶段' : '确认宏观行动取向成果，完成本条记录的反思深化'}
                    className="text-sm px-3 py-1.5 rounded-lg border border-green-300 text-green-700 bg-green-50 hover:bg-green-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {currentPhase < 4 ? `确认Phase${currentPhase}完成 →` : '确认Phase4完成 ✓'}
                  </button>
                )}
              </div>

                </div>

              </div>
            </>
          )}
        </aside>

        {/* 提交并结束反思深化 */}
        {finalizeError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
            {finalizeError}。会话状态未变更，你的编辑与深化成果均已保留，可直接重试提交。
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button
            onClick={finalize}
            disabled={saving || rows.length === 0}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? '提交中…' : '提交并结束反思深化'}
          </button>
        </div>
      </div>
  )
}
