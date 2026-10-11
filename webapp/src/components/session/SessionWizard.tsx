'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, Cause, Measure, ReflectionReport } from '@/types'

import { cn } from '@/lib/utils'
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

const STAGES = [
  { label: '数据概览', short: '0' },
  { label: '问题识别', short: '1' },
  { label: '归因分析', short: '2' },
  { label: '改进措施', short: '3' },
  { label: '反思深化', short: '4' },
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
  const [problems, setProblems] = useState<Problem[]>(initialProblems)
  const [causes, setCauses] = useState<Cause[]>(initialCauses)
  const [measures, setMeasures] = useState<Measure[]>(initialMeasures)
  const [report, setReport] = useState<ReflectionReport | null>(initialReport)
  const [sessionData, setSessionData] = useState(session)

  const [stage1Analyzing, setStage1Analyzing] = useState(false)
  const [stage1Error, setStage1Error] = useState('')
  const [stage1StatusMsg, setStage1StatusMsg] = useState('')

  const [stage2Analyzing, setStage2Analyzing] = useState(false)
  const [stage2Error, setStage2Error] = useState('')
  const [stage3Analyzing, setStage3Analyzing] = useState(false)
  const [stage3Error, setStage3Error] = useState('')
  const [stage4Analyzing, setStage4Analyzing] = useState(false)
  const [stage4Error, setStage4Error] = useState('')

  const autoTriggeredRef = useRef<Record<number, boolean>>({})

  const getErrorMessage = async (res: Response, fallback: string) => {
    const payload = await res.json().catch(() => null) as { error?: string } | null
    return payload?.error ?? fallback
  }

  const advanceStage = useCallback(async (toStage: number) => {
    const safeStage = Math.min(toStage, 4)
    const { data } = await supabase
      .from('reflection_sessions')
      .update({ current_stage: safeStage })
      .eq('id', session.id)
      .select('*')
      .single()

    setCurrentStage(safeStage)
    if (data) {
      setSessionData(data)
    } else {
      setSessionData(s => ({ ...s, current_stage: safeStage }))
    }
  }, [supabase, session.id])

  const updateStageMeta = useCallback(async (stage: AnalyzeStage, status: 'running' | 'done' | 'failed', error = '') => {
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

    if (data) setSessionData(data)
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

      setStage1StatusMsg('AI 正在识别问题…')
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

  const runCausesAnalysis = useCallback(async () => {
    if (stage2Analyzing) return
    setStage2Analyzing(true)
    setStage2Error('')
    await updateStageMeta(2, 'running')

    try {
      const res = await fetch('/api/ai/analyze-causes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.id }),
      })

      if (!res.ok) throw new Error(await getErrorMessage(res, 'AI 分析失败'))

      const { data: fresh } = await supabase
        .from('causes')
        .select('*')
        .eq('session_id', session.id)
        .order('sort_order')

      if (fresh) setCauses(fresh)
      await updateStageMeta(2, 'done')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'AI 分析失败'
      setStage2Error(msg)
      await updateStageMeta(2, 'failed', msg)
    } finally {
      setStage2Analyzing(false)
    }
  }, [session.id, stage2Analyzing, supabase, updateStageMeta])

  const runMeasuresAnalysis = useCallback(async () => {
    if (stage3Analyzing) return
    setStage3Analyzing(true)
    setStage3Error('')
    await updateStageMeta(3, 'running')

    try {
      const res = await fetch('/api/ai/analyze-measures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.id }),
      })

      if (!res.ok) throw new Error(await getErrorMessage(res, 'AI 分析失败'))

      const { data: fresh } = await supabase
        .from('measures')
        .select('*')
        .eq('session_id', session.id)
        .order('sort_order')

      if (fresh) setMeasures(fresh)
      await updateStageMeta(3, 'done')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'AI 分析失败'
      setStage3Error(msg)
      await updateStageMeta(3, 'failed', msg)
    } finally {
      setStage3Analyzing(false)
    }
  }, [session.id, stage3Analyzing, supabase, updateStageMeta])

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
    await advanceStage(1)
    void runProblemsAnalysis()
  }, [advanceStage, runProblemsAnalysis])

  const handleNextFromStage1 = useCallback(async () => {
    await advanceStage(2)
    void runCausesAnalysis()
  }, [advanceStage, runCausesAnalysis])

  const handleNextFromStage2 = useCallback(async () => {
    await advanceStage(3)
    void runMeasuresAnalysis()
  }, [advanceStage, runMeasuresAnalysis])

  const handleNextFromStage3 = useCallback(async () => {
    await advanceStage(4)
    void runReportGeneration()
  }, [advanceStage, runReportGeneration])

  const handleFinishFromStage4 = useCallback(() => {
    setCurrentStage(4)
    setSessionData(prev => ({ ...prev, status: 'done', current_stage: 4 }))
  }, [])

  useEffect(() => {
    if (currentStage === 1 && !autoTriggeredRef.current[1] && problems.length === 0) {
      autoTriggeredRef.current[1] = true
      void runProblemsAnalysis()
    }
    if (currentStage === 2 && !autoTriggeredRef.current[2] && causes.length === 0 && problems.some(p => p.confirmed)) {
      autoTriggeredRef.current[2] = true
      void runCausesAnalysis()
    }
    if (currentStage === 3 && !autoTriggeredRef.current[3] && measures.length === 0 && causes.some(c => c.confirmed)) {
      autoTriggeredRef.current[3] = true
      void runMeasuresAnalysis()
    }
    if (currentStage === 4 && !autoTriggeredRef.current[4] && !report && measures.some(m => m.confirmed)) {
      autoTriggeredRef.current[4] = true
      void runReportGeneration()
    }
  }, [
    currentStage,
    problems,
    causes,
    measures,
    report,
    runProblemsAnalysis,
    runCausesAnalysis,
    runMeasuresAnalysis,
    runReportGeneration,
  ])

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-1 max-w-4xl mx-auto">
          {STAGES.map((s, i) => (
            <div key={i} className="flex items-center flex-1">
              <button
                onClick={() => i <= currentStage && setCurrentStage(i)}
                disabled={i > currentStage}
                className={cn(
                  'w-8 h-8 rounded-full text-xs font-bold transition-all shrink-0',
                  i < currentStage
                    ? 'bg-blue-600 text-white cursor-pointer'
                    : i === currentStage
                      ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                )}
              >
                {i < currentStage ? '✓' : s.short}
              </button>
              {i < STAGES.length - 1 && (
                <div className={cn('flex-1 h-0.5 mx-1', i < currentStage ? 'bg-blue-600' : 'bg-gray-200')} />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between max-w-4xl mx-auto mt-2">
          {STAGES.map((s, i) => (
            <span key={i} className={cn(
              'text-xs flex-1 text-center',
              i === currentStage ? 'text-blue-700 font-medium' : 'text-gray-400'
            )}>
              {s.label}
            </span>
          ))}
        </div>
        <div className="mt-2 max-w-4xl mx-auto">
          <p className="text-sm font-medium text-gray-900 truncate">{sessionData.title}</p>
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
          />
        )}
        {currentStage === 2 && (
          <Stage2Causes
            session={sessionData}
            problems={problems}
            causes={causes}

            setCauses={setCauses}
            onNext={handleNextFromStage2}
            onAnalyze={runCausesAnalysis}
            analyzing={stage2Analyzing}
            analysisError={stage2Error}
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
            onAnalyze={runMeasuresAnalysis}
            analyzing={stage3Analyzing}
            analysisError={stage3Error}
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
