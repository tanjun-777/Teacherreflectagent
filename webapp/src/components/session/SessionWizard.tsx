'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, Cause, Measure, ReflectionReport } from '@/types'

import { cn } from '@/lib/utils'
import { appendSessionOperationLog, withDraftSnapshotUpdate } from '@/lib/session-audit'
import Stage0Overview from './Stage0Overview'
import Stage1Problems from './Stage1Problems'
import Stage2Causes from './Stage2Causes'
import Stage3Measures from './Stage3Measures'
import Stage4Report from './Stage4Report'

interface Props {
  session: ReflectionSession
  initialProblems: Problem[]
  initialCauses: Cause[]
  initialMeasures: Measure[]
  initialReport: ReflectionReport | null
}

// 大阶段：阶段1 数据收集（新建页完成）→ 阶段2 反思进程（本向导）→ 阶段3 审视与深化（本向导）
const PHASES = [
  { label: '数据收集与整理', short: '1', title: '阶段1 ｜ 课堂教学数据与外部反馈结果的收集与整理' },
  { label: '反思进程推进与初步教学反思形成', short: '2', title: '阶段2 ｜ 反思进程推进与初步教学反思形成' },
  { label: '初步教学反思审视与深化', short: '3', title: '阶段3 ｜ 初步教学反思审视与深化' },
]

// 阶段2 内部子步骤：数据概览 → ①明确问题 → ②归因分析 → ③改进措施
// current_stage 内部值保持不变：0=概览 1=问题 2=归因 3=措施 4=阶段3（审视与深化）
const SUB_STEPS = [
  { label: '数据概览' },
  { label: '① 明确问题' },
  { label: '② 归因分析' },
  { label: '③ 改进措施' },
]

type AnalyzeStage = 1 | 2 | 3 | 4

export default function SessionWizard({
  session,
  initialProblems,
  initialCauses,
  initialMeasures,
  initialReport,
}: Props) {
  const supabase = createClient()
  const [currentStage, setCurrentStage] = useState(Math.min(session.current_stage, 4))
  // 历史最高到达阶段：控制大阶段/子步骤的可回访性，持久化于 draft_snapshot.max_reached_stage
  const initialMaxStage = Math.min(
    (() => {
      const snap = (session.draft_snapshot ?? {}) as { max_reached_stage?: number }
      return typeof snap.max_reached_stage === 'number' ? snap.max_reached_stage : session.current_stage
    })(),
    4
  )
  const [maxStage, setMaxStage] = useState(initialMaxStage)
  const maxStageRef = useRef(initialMaxStage)
  const [problems, setProblems] = useState<Problem[]>(initialProblems)
  const [causes, setCauses] = useState<Cause[]>(initialCauses)
  const [measures, setMeasures] = useState<Measure[]>(initialMeasures)
  const [report, setReport] = useState<ReflectionReport | null>(initialReport)
  const [sessionData, setSessionData] = useState(session)

  const [stage1Analyzing, setStage1Analyzing] = useState(false)
  const [stage1Error, setStage1Error] = useState('')
  const [stage1StatusMsg, setStage1StatusMsg] = useState('')

  const [stage4Analyzing, setStage4Analyzing] = useState(false)
  const [stage4Error, setStage4Error] = useState('')

  const autoTriggeredRef = useRef<Record<number, boolean>>({})

  // 阶段2/3 助手对话历史（持久化于 draft_snapshot，刷新后恢复）
  const initialChatSnapshot = (session.draft_snapshot ?? {}) as {
    cause_chat_dialogue?: Array<{ role: 'user' | 'assistant'; content: string }>
    measure_chat_dialogue?: Array<{ role: 'user' | 'assistant'; content: string }>
  }
  const initialCauseChat = initialChatSnapshot.cause_chat_dialogue ?? []
  const initialMeasureChat = initialChatSnapshot.measure_chat_dialogue ?? []

  // 删除问题：数据库级联删除其下归因与措施，同步清理本地状态
  const handleProblemDeleted = useCallback((problemId: string) => {
    setCauses(prev => prev.filter(c => c.problem_id !== problemId))
    setMeasures(prev => prev.filter(m => m.problem_id !== problemId))
  }, [])

  // 删除归因：数据库将关联措施 cause_id 置空（on delete set null），同步本地状态
  const handleCauseDeleted = useCallback((causeId: string) => {
    setMeasures(prev => prev.map(m => m.cause_id === causeId ? { ...m, cause_id: null } : m))
  }, [])

  const getErrorMessage = async (res: Response, fallback: string) => {
    const payload = await res.json().catch(() => null) as { error?: string } | null
    return payload?.error ?? fallback
  }

  // 首次进入某阶段/步骤时的操作日志标签（供管理端过程记录展示阶段推进轨迹）
  const STAGE_ENTER_LABEL: Record<number, string> = {
    1: '步骤① 明确问题',
    2: '步骤② 归因分析',
    3: '步骤③ 改进措施',
    4: '阶段3 审视与深化',
  }

  const advanceStage = useCallback(async (toStage: number) => {
    const safeStage = Math.min(toStage, 4)
    const nextMax = Math.max(maxStageRef.current, safeStage)
    // 首次到达新最高阶段时记录留痕（回访旧阶段不重复记录）
    const firstReach = safeStage > maxStageRef.current && safeStage >= 1

    // 读-改-写 draft_snapshot 必须走串行队列，避免与日志/对话保存并发互相覆盖
    let updated: ReflectionSession | null = null
    await withDraftSnapshotUpdate(async () => {
      const { data: latest } = await supabase
        .from('reflection_sessions')
        .select('draft_snapshot')
        .eq('id', session.id)
        .maybeSingle()
      const prevSnapshot = ((latest?.draft_snapshot ?? {}) as Record<string, unknown>)

      const { data } = await supabase
        .from('reflection_sessions')
        .update({
          current_stage: safeStage,
          draft_snapshot: { ...prevSnapshot, max_reached_stage: nextMax },
        })
        .eq('id', session.id)
        .select('*')
        .single()
      updated = (data as ReflectionSession) ?? null
    })

    maxStageRef.current = nextMax
    setMaxStage(nextMax)
    setCurrentStage(safeStage)
    if (firstReach) {
      const label = STAGE_ENTER_LABEL[safeStage] ?? `阶段${safeStage}`
      void appendSessionOperationLog(supabase, session.id, {
        at: new Date().toISOString(),
        stage: safeStage as 1 | 2 | 3 | 4,
        action: `进入${label}`,
        targetType: 'stage',
        summary: `教师首次进入「${label}」，推进反思流程`,
      }).catch(() => undefined)
    }
    if (updated) {
      setSessionData(updated)
    } else {
      setSessionData(s => ({ ...s, current_stage: safeStage, draft_snapshot: { ...((s.draft_snapshot ?? {}) as Record<string, unknown>), max_reached_stage: nextMax } as ReflectionSession['draft_snapshot'] }))
    }
  }, [supabase, session.id])

  const updateStageMeta = useCallback(async (stage: AnalyzeStage, status: 'running' | 'done' | 'failed', error = '') => {
    let updated: ReflectionSession | null = null
    await withDraftSnapshotUpdate(async () => {
      const { data: latestSession } = await supabase
        .from('reflection_sessions')
        .select('draft_snapshot,status')
        .eq('id', session.id)
        .maybeSingle()

      const prevSnapshot = ((latestSession?.draft_snapshot ?? sessionData.draft_snapshot ?? {}) as Record<string, unknown>)

      const stageState = {
        status,
        error: error || null,
        updated_at: new Date().toISOString(),
      }
      const analysisState = {
        ...((prevSnapshot.analysis_state as Record<string, unknown> | undefined) ?? {}),
        [`stage${stage}`]: stageState,
      }

      const nextSnapshot = {
        ...prevSnapshot,
        analysis_state: analysisState,
      }

      const latestStatus = latestSession?.status ?? sessionData.status
      const nextStatus = status === 'running'
        ? 'analyzing'
        : latestStatus === 'done'
          ? 'done'
          : 'draft'

      const { data } = await supabase
        .from('reflection_sessions')
        .update({ draft_snapshot: nextSnapshot, status: nextStatus })
        .eq('id', session.id)
        .select('*')
        .single()
      updated = (data as ReflectionSession) ?? null
    })

    if (updated) setSessionData(updated)
  }, [sessionData.draft_snapshot, sessionData.status, session.id, supabase])

  const refreshSession = useCallback(async () => {
    const { data } = await supabase
      .from('reflection_sessions')
      .select('*')
      .eq('id', session.id)
      .single()
    if (data) {
      setSessionData(data)
      return data
    }
    return sessionData
  }, [session.id, sessionData, supabase])

  const callAsr = useCallback(async (audioUrl: string, targetField: 'audio_transcript' | 'self_review' | 'peer_review', label: string) => {
    setStage1StatusMsg(`正在转写${label}录音…`)
    const res = await fetch('/api/asr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.id, audio_url: audioUrl, target_field: targetField }),
    })
    if (!res.ok) {
      const error = await getErrorMessage(res, `${label}录音转写失败`)
      throw new Error(error)
    }
  }, [session.id])

  const runProblemsAnalysis = useCallback(async () => {
    if (stage1Analyzing) return
    setStage1Analyzing(true)
    setStage1Error('')
    setStage1StatusMsg('正在准备分析数据…')
    await updateStageMeta(1, 'running')

    try {
      let latest = await refreshSession()
      const snapshot = (latest.draft_snapshot ?? {}) as {
        self_review_audio_url?: string
        peer_review_audio_url?: string
      }

      if (snapshot.self_review_audio_url && !latest.self_review) {
        await callAsr(snapshot.self_review_audio_url, 'self_review', '教师自评')
        latest = await refreshSession()
      }

      if (snapshot.peer_review_audio_url && !latest.peer_review) {
        await callAsr(snapshot.peer_review_audio_url, 'peer_review', '同伴评价')
        latest = await refreshSession()
      }

      if (latest.audio_url && !latest.audio_transcript) {
        await callAsr(latest.audio_url, 'audio_transcript', '课堂')
      }

      setStage1StatusMsg('AI 正在从反馈资料中提取问题…')
      const res = await fetch('/api/ai/analyze-problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.id }),
      })
      if (!res.ok) throw new Error(await getErrorMessage(res, 'AI 分析失败'))

      const { data: fresh } = await supabase
        .from('problems')
        .select('*')
        .eq('session_id', session.id)
        .order('sort_order')

      if (fresh) setProblems(fresh)
      await updateStageMeta(1, 'done')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '操作失败'
      setStage1Error(msg)
      await updateStageMeta(1, 'failed', msg)
    } finally {
      setStage1Analyzing(false)
      setStage1StatusMsg('')
    }
  }, [
    stage1Analyzing,
    updateStageMeta,
    refreshSession,
    callAsr,
    session.id,
    supabase,
  ])

  // 问题提取由教师在明确问题环节手动触发（不自动生成）；归因/措施亦为组件内按需触发
  const runReportGeneration = useCallback(async () => {
    if (stage4Analyzing) return
    setStage4Analyzing(true)
    setStage4Error('')
    await updateStageMeta(4, 'running')

    try {
      const res = await fetch('/api/ai/generate-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.id }),
      })

      if (!res.ok) throw new Error(await getErrorMessage(res, '生成失败，请稍后重试'))

      const { data: fresh } = await supabase
        .from('reflection_reports')
        .select('*')
        .eq('session_id', session.id)
        .maybeSingle()

      if (fresh) setReport(fresh)
      await updateStageMeta(4, 'done')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '生成失败，请稍后重试'
      setStage4Error(msg)
      await updateStageMeta(4, 'failed', msg)
    } finally {
      setStage4Analyzing(false)
    }
  }, [session.id, stage4Analyzing, supabase, updateStageMeta])

  const handleStartFromStage0 = useCallback(async () => {
    // 不自动提取问题：进入明确问题环节后由教师手动触发「从反馈资料提取问题」
    await advanceStage(1)
  }, [advanceStage])

  const handleNextFromStage1 = useCallback(async () => {
    await advanceStage(2)
  }, [advanceStage])

  const handleNextFromStage2 = useCallback(async () => {
    await advanceStage(3)
  }, [advanceStage])

  const handleNextFromStage3 = useCallback(async () => {
    await advanceStage(4)
    void runReportGeneration()
  }, [advanceStage, runReportGeneration])

  const handleFinishFromStage4 = useCallback(() => {
    setCurrentStage(4)
    setSessionData(prev => ({ ...prev, status: 'done', current_stage: 4 }))
  }, [])

  // 大阶段：0-3 属阶段2（反思进程），4 属阶段3（审视与深化）；阶段1 已在新建页完成
  const currentPhase = currentStage >= 4 ? 2 : 1

  // 大阶段可回访性按历史最高到达阶段（maxStage）判断，支持阶段2↔阶段3 双向直达
  const handlePhaseClick = (phaseIndex: number) => {
    if (phaseIndex === 0) {
      void advanceStage(0)
    } else if (phaseIndex === 1 && maxStage >= 1) {
      // 回到阶段2：优先回到措施步骤（曾到达阶段3 时），否则回到上次所在的子步骤
      void advanceStage(Math.min(Math.max(maxStage, 1), 3))
    } else if (phaseIndex === 2 && maxStage >= 4) {
      void advanceStage(4)
    }
  }

  useEffect(() => {
    if (currentStage === 4 && !autoTriggeredRef.current[4] && !report && measures.some(m => m.confirmed)) {
      autoTriggeredRef.current[4] = true
      void runReportGeneration()
    }
  }, [
    currentStage,
    measures,
    report,
    runReportGeneration,
  ])

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        {/* 大阶段指示器：阶段1(已完成) → 阶段2(反思进程) → 阶段3(审视与深化) */}
        <div className="flex items-center gap-1 max-w-4xl mx-auto">
          {PHASES.map((p, i) => {
            const done = i === 0 ? true : i === 1 ? maxStage >= 4 : sessionData.status === 'done'
            const active = i === currentPhase
            const clickable = i === 0 || (i === 1 && maxStage >= 1) || (i === 2 && maxStage >= 4)
            return (
              <div key={i} className="flex items-center flex-1">
                <button
                  onClick={() => handlePhaseClick(i)}
                  disabled={!clickable}
                  className={cn(
                    'w-8 h-8 rounded-full text-xs font-bold transition-all shrink-0',
                    done || active
                      ? 'bg-blue-600 text-white cursor-pointer'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed',
                    active && 'ring-4 ring-blue-100'
                  )}
                >
                  {done ? '✓' : p.short}
                </button>
                {i < PHASES.length - 1 && (
                  <div className={cn('flex-1 h-0.5 mx-1', i < currentPhase ? 'bg-blue-600' : 'bg-gray-200')} />
                )}
              </div>
            )
          })}
        </div>
        <div className="flex justify-between max-w-4xl mx-auto mt-2">
          {PHASES.map((p, i) => (
            <span key={i} className={cn(
              'text-xs flex-1 text-center',
              i === currentPhase ? 'text-blue-700 font-medium' : 'text-gray-400'
            )}>
              {p.label}
            </span>
          ))}
        </div>

        {/* 阶段2 子步骤：数据概览 → ① 明确问题 → ② 归因分析 → ③ 改进措施 */}
        {currentPhase === 1 && (
          <div className="max-w-3xl mx-auto mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center gap-1">
              {SUB_STEPS.map((s, i) => (
                <div key={i} className="flex items-center flex-1">
                  <button
                    onClick={() => i <= maxStage && void advanceStage(i)}
                    disabled={i > maxStage}
                    className={cn(
                      'h-7 px-3 rounded-full text-xs font-medium transition-all shrink-0 whitespace-nowrap',
                      i === currentStage
                        ? 'bg-blue-600 text-white'
                        : i <= maxStage
                          ? 'bg-blue-100 text-blue-700 cursor-pointer'
                          : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    )}
                  >
                    {s.label}
                  </button>
                  {i < SUB_STEPS.length - 1 && (
                    <div className={cn('flex-1 h-0.5 mx-1', i < maxStage ? 'bg-blue-400' : 'bg-gray-200')} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-2 max-w-4xl mx-auto text-center">
          <p className="text-xs font-medium text-blue-700">{PHASES[currentPhase].title}</p>
          <p className="text-xs text-gray-400 truncate mt-0.5">{sessionData.title}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {currentStage === 0 && (
          <Stage0Overview
            session={sessionData}
            onAnalyze={handleStartFromStage0}
            loading={stage1Analyzing}
            error={stage1Error}
            statusMsg={stage1StatusMsg}
            onSessionRefresh={refreshSession}
          />
        )}
        {currentStage === 1 && (
          <Stage1Problems
            session={sessionData}
            problems={problems}
            setProblems={setProblems}
            onNext={handleNextFromStage1}
            onAnalyze={runProblemsAnalysis}
            analyzing={stage1Analyzing}
            analysisError={stage1Error}
            onProblemDeleted={handleProblemDeleted}
          />
        )}
        {currentStage === 2 && (
          <Stage2Causes
            session={sessionData}
            problems={problems}
            causes={causes}
            setCauses={setCauses}
            onNext={handleNextFromStage2}
            onCauseDeleted={handleCauseDeleted}
            initialChatMessages={initialCauseChat}
          />
        )}
        {currentStage === 3 && (
          <Stage3Measures
            session={sessionData}
            problems={problems}
            causes={causes}
            measures={measures}
            setMeasures={setMeasures}
            onNext={handleNextFromStage3}
            initialChatMessages={initialMeasureChat}
          />
        )}
        {currentStage === 4 && (
          <Stage4Report
            session={sessionData}
            problems={problems}
            causes={causes}
            measures={measures}
            report={report}
            setReport={setReport}
            onFinish={handleFinishFromStage4}
            onAnalyze={runReportGeneration}
            analyzing={stage4Analyzing}
            analysisError={stage4Error}
          />
        )}
      </div>
    </div>
  )
}
