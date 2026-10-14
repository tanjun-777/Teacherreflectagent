'use client'
import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, Cause, Measure } from '@/types'

import { cn } from '@/lib/utils'
import { appendSessionOperationLog, updateDraftSnapshotFields } from '@/lib/session-audit'


type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

interface Props {
  session: ReflectionSession
  problems: Problem[]
  causes: Cause[]
  measures: Measure[]

  setMeasures: (m: Measure[] | ((prev: Measure[]) => Measure[])) => void
  onNext: () => void
  // 刷新后恢复的历史对话（draft_snapshot.measure_chat_dialogue）
  initialChatMessages?: ChatMessage[]
}


export default function Stage3Measures({ session, problems, causes, measures, setMeasures, onNext, initialChatMessages }: Props) {

  const supabase = createClient()
  const [saving, setSaving] = useState<string | null>(null)
  const [analyzingCauseId, setAnalyzingCauseId] = useState<string | null>(null)
  const [stageError, setStageError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(
    initialChatMessages?.length
      ? initialChatMessages
      : [
        {
          role: 'assistant',
          content: '我是解决措施助手，我将帮助你从“原因解释”走向“行动设计”。先从这一步开始：你打算如何具体调整教学？',
        },
      ]
  )

  const confirmedProblems = useMemo(() => problems.filter(p => p.confirmed), [problems])
  const confirmedCauses = useMemo(() => causes.filter(c => c.confirmed), [causes])
  const confirmedMeasures = useMemo(() => measures
    .filter(m => m.confirmed)
    .sort((a, b) => a.sort_order - b.sort_order), [measures])

  const [focusProblemId, setFocusProblemId] = useState<string>('')
  const [focusCauseId, setFocusCauseId] = useState<string>('')

  useEffect(() => {
    const firstProblemWithCause = confirmedProblems.find(p => confirmedCauses.some(c => c.problem_id === p.id))
    if (!firstProblemWithCause) {
      setFocusProblemId('')
      return
    }
    if (!focusProblemId || !confirmedProblems.some(p => p.id === focusProblemId) || !confirmedCauses.some(c => c.problem_id === focusProblemId)) {
      setFocusProblemId(firstProblemWithCause.id)
    }
  }, [confirmedCauses, confirmedProblems, focusProblemId])

  const focusCauseOptions = useMemo(
    () => confirmedCauses.filter(c => c.problem_id === focusProblemId),
    [confirmedCauses, focusProblemId]
  )

  useEffect(() => {
    if (!focusCauseOptions.length) {
      setFocusCauseId('')
      return
    }
    if (!focusCauseId || !focusCauseOptions.some(c => c.id === focusCauseId)) {
      setFocusCauseId(focusCauseOptions[0].id)
    }
  }, [focusCauseId, focusCauseOptions])






  async function confirmMeasure(m: Measure, desc: string) {
    setSaving(m.id)
    setActionError(null)
    const nextDesc = desc.trim()
    const { data, error } = await supabase
      .from('measures')
      .update({ confirmed: true, description: nextDesc })
      .eq('id', m.id)
      .select().single()
    if (error || !data) {
      setActionError(`措施保存失败：${error?.message ?? '未知错误'}。当前修改未生效，请重试或刷新页面。`)
      setSaving(null)
      return
    }
    setMeasures((prev: Measure[]) => prev.map(x => x.id === m.id ? data : x))
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 3,
      action: m.confirmed ? '修改措施' : '确认措施',
      targetType: 'measure',
      targetId: m.id,
      summary: m.confirmed ? '教师修改了已确认措施描述' : '教师确认了待确认措施',
      before: m.description,
      after: nextDesc,
    })
    setSaving(null)
  }


  async function deleteMeasure(m: Measure) {
    setActionError(null)
    const { error } = await supabase.from('measures').delete().eq('id', m.id)
    if (error) {
      setActionError(`删除失败：${error.message}。该措施未被删除，请重试。`)
      return
    }
    setMeasures((prev: Measure[]) => prev.filter(x => x.id !== m.id))
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 3,
      action: '删除措施',
      targetType: 'measure',
      targetId: m.id,
      summary: '教师删除了改进措施条目',
      before: m.description,
    })
  }

  // 单归因按需生成改进措施参考（支持重新生成）
  async function analyzeMeasuresForCause(problem: Problem, cause: Cause) {
    setAnalyzingCauseId(cause.id)
    setStageError(null)
    try {
      const res = await fetch('/api/ai/analyze-measures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cause_id: cause.id }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '改进措施生成失败')
      const { data } = await supabase
        .from('measures')
        .select('*')
        .eq('cause_id', cause.id)
        .order('sort_order')
      if (data) {
        setMeasures((prev: Measure[]) => [...prev.filter(m => m.cause_id !== cause.id), ...data])
        await appendSessionOperationLog(supabase, session.id, {
          at: new Date().toISOString(),
          stage: 3,
          action: '改进措施参考',
          targetType: 'cause',
          targetId: cause.id,
          summary: `AI 针对该问题-证据-归因组合生成了 ${json.count} 条措施参考`,
        })
      }
    } catch (err) {
      setStageError(err instanceof Error ? err.message : '改进措施生成失败')
    } finally {
      setAnalyzingCauseId(null)
    }
  }

  // 教师自主添加措施
  async function addManualMeasure(problem: Problem, cause: Cause, desc: string) {
    const nextDesc = desc.trim()
    if (!nextDesc) return
    setSaving(`new-${cause.id}`)
    setActionError(null)
    const { data, error } = await supabase
      .from('measures')
      .insert({
        session_id: session.id,
        problem_id: problem.id,
        cause_id: cause.id,
        description: nextDesc,
        confirmed: true,
        sort_order: measures.filter(m => m.cause_id === cause.id).length,
      })
      .select().single()
    if (error || !data) {
      setActionError(`新增措施失败：${error?.message ?? '未知错误'}。请重试。`)
      setSaving(null)
      return
    }
    setMeasures((prev: Measure[]) => [...prev, data])
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 3,
      action: '自主添加措施',
      targetType: 'measure',
      targetId: data.id,
      summary: '教师自主添加了改进措施',
      after: nextDesc,
    })
    setSaving(null)
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
      stage: 3,
      action: '机器人对话-教师提问',
      targetType: 'measure',
      targetId: focusCauseId || focusProblemId || undefined,
      summary: '教师向解决措施助手发送消息',
      after: content.slice(0, 2000),
    }).catch(() => undefined)

    try {
      const res = await fetch('/api/ai/measure-coach-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.id,
          problem_id: focusProblemId || undefined,
          cause_id: focusCauseId || undefined,
          messages: nextMessages,
        }),
      })

      const payload = await res.json().catch(() => null) as { error?: string; reply?: string } | null
      if (!res.ok) throw new Error(payload?.error ?? '措施对话失败')

      const reply = String(payload?.reply ?? '').trim() || '我已收到。请继续补充实施步骤与效果验证方式。'
      const fullMessages: ChatMessage[] = [...nextMessages, { role: 'assistant', content: reply }]
      setChatMessages(fullMessages)
      // 持久化对话到 draft_snapshot（串行队列防并发覆盖），刷新后可恢复
      void updateDraftSnapshotFields(supabase, session.id, snap => ({
        ...snap,
        measure_chat_dialogue: fullMessages.slice(-60),
      })).catch(() => undefined)
      void appendSessionOperationLog(supabase, session.id, {
        at: new Date().toISOString(),
        stage: 3,
        action: '机器人对话-助手回复',
        targetType: 'measure',
        targetId: focusCauseId || focusProblemId || undefined,
        summary: '解决措施助手回复消息',
        after: reply.slice(0, 2000),
      }).catch(() => undefined)
    } catch (err: unknown) {
      // 回滚乐观更新：失败的消息不保留在界面上（也未持久化），内容放回输入框便于修改后重发
      setChatMessages(chatMessages)
      setChatInput(content)
      setChatError(err instanceof Error ? err.message : '措施对话失败')
    } finally {
      setChatLoading(false)
    }
  }


  const askTemplates = [
    '你打算如何具体调整教学？',
    '这个措施在课堂哪个环节实施？',
    '谁来执行这个步骤？',
    '如何验证是否有效？',
  ]


  return (

    <div className="p-6 max-w-[1440px] mx-auto">
      <div className="grid grid-cols-[minmax(0,1fr)_460px] gap-6 items-start">

        <div>
          <div className="mb-6">
            <h2 className="text-xl font-bold text-gray-900">阶段2 · 步骤3 ｜ 改进措施</h2>
            <p className="text-gray-400 text-xs mt-1">点击每个归因的「改进措施参考」由 AI 针对该问题-证据-归因组合生成，或自主添加措施（描述可直接编辑）</p>
          </div>

          {stageError && <p className="text-red-500 text-sm mb-4">{stageError}</p>}
          {actionError && (
            <p className="text-sm mb-4 rounded-lg border border-red-200 bg-red-50 text-red-600 px-3 py-2">{actionError}</p>
          )}

          {confirmedProblems.map(problem => {
            const problemMeasures = measures
              .filter(m => m.problem_id === problem.id && !m.cause_id)
              .sort((a, b) => a.sort_order - b.sort_order)
            const relatedCauses = causes.filter(c => c.problem_id === problem.id && c.confirmed)
            const evidence = (problem.evidence as Array<{ text: string; source?: string }> | null) ?? []

            return (
              <div key={problem.id} className="mb-6">
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 mb-3">
                  <p className="text-xs text-blue-400 font-medium mb-1">关联问题</p>
                  <p className="text-sm font-medium text-blue-800">{problem.description}</p>
                  {evidence.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-blue-100 space-y-1">
                      <p className="text-[11px] text-blue-400 font-medium">📎 该问题关联证据</p>
                      {evidence.map((e, i) => (
                        <p key={i} className="text-[11px] text-blue-700/80 line-clamp-1">&ldquo;{e.text}&rdquo;</p>
                      ))}
                    </div>
                  )}
                </div>

                {relatedCauses.map(cause => {
                  const causeMeasures = measures
                    .filter(m => m.cause_id === cause.id)
                    .sort((a, b) => a.sort_order - b.sort_order)
                  const causeHasAny = measures.some(m => m.cause_id === cause.id)

                  return (
                    <div key={cause.id} className="mb-4">
                      <div className="bg-orange-50 border border-orange-100 rounded-lg p-2.5 mb-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs text-orange-400 font-medium mb-0.5">归因</p>
                            <p className="text-sm text-orange-800">{cause.description}</p>
                          </div>
                          <button
                            onClick={() => analyzeMeasuresForCause(problem, cause)}
                            disabled={analyzingCauseId === cause.id}
                            className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shrink-0 whitespace-nowrap"
                          >
                            {analyzingCauseId === cause.id ? '生成中…' : causeHasAny ? '🔄 重新生成措施参考' : '💡 改进措施参考'}
                          </button>
                        </div>
                      </div>
                      <div className="space-y-3 pl-3">
                        {causeMeasures.map(m => (
                          <MeasureCard
                            key={m.id}
                            measure={m}
                            saving={saving === m.id}
                            onConfirm={desc => confirmMeasure(m, desc)}
                            onDelete={() => deleteMeasure(m)}
                            isConfirmed={m.confirmed}
                          />
                        ))}
                        {causeMeasures.length === 0 && analyzingCauseId !== cause.id && (
                          <p className="text-xs text-gray-400">暂无措施，点击「改进措施参考」由 AI 生成，或在下方自主添加</p>
                        )}
                        <AddMeasureForm
                          saving={saving === `new-${cause.id}`}
                          onAdd={desc => addManualMeasure(problem, cause, desc)}
                        />
                      </div>
                    </div>
                  )
                })}

                {problemMeasures.length > 0 && (
                  <div className="mt-3 space-y-3 pl-3">
                    {problemMeasures.map(m => (
                      <MeasureCard
                        key={m.id}
                        measure={m}
                        saving={saving === m.id}
                        onConfirm={desc => confirmMeasure(m, desc)}
                        onDelete={() => deleteMeasure(m)}
                        isConfirmed={m.confirmed}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {confirmedMeasures.length > 0 && (
            <p className="text-sm text-gray-500 mb-2">
              措施进度：已确认 <span className="font-medium text-green-700">{confirmedMeasures.length}</span> 条
              {measures.filter(m => !m.confirmed).length > 0 && (
                <> / 待确认 <span className="font-medium text-amber-600">{measures.filter(m => !m.confirmed).length}</span> 条</>
              )}
            </p>
          )}

          <div className="flex justify-end items-center gap-3">
            {measures.filter(m => !m.confirmed).length > 0 && (
              <span className="text-xs text-amber-600">还有 {measures.filter(m => !m.confirmed).length} 条待确认措施，确认或删除后方可进入下一环节</span>
            )}
            <button
              onClick={onNext}
              disabled={confirmedMeasures.length === 0 || measures.some(m => !m.confirmed)}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
            >
              进入反思审视与深化 →
            </button>
          </div>
        </div>

        <aside className="sticky top-6 max-h-[calc(100vh-3rem)] flex flex-col rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">AI</div>
            <div>
              <p className="text-base font-semibold text-blue-900">解决措施助手</p>
              <p className="text-xs text-blue-700">帮助教师把问题原因转化为可执行改进措施</p>
            </div>
          </div>

          {!chatOpen ? (
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="w-full px-3 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
              disabled={!focusProblemId || !focusCauseId}
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

              <div className="grid grid-cols-1 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">当前聚焦问题</label>
                  <select
                    value={focusProblemId}
                    onChange={e => setFocusProblemId(e.target.value)}
                    className="w-full border border-blue-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {confirmedProblems.length === 0 && <option value="">（请先确认问题）</option>}
                    {confirmedProblems.map(p => (
                      <option key={p.id} value={p.id}>{p.description}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">当前聚焦归因</label>
                  <select
                    value={focusCauseId}
                    onChange={e => setFocusCauseId(e.target.value)}
                    className="w-full border border-blue-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {focusCauseOptions.length === 0 && <option value="">（该问题暂无已确认归因）</option>}
                    {focusCauseOptions.map(c => (
                      <option key={c.id} value={c.id}>{c.description}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="bg-white border border-blue-100 rounded-lg p-3 flex-1 min-h-[140px] overflow-y-auto space-y-2">
                {chatMessages.map((m, idx) => (
                  <div
                    key={`${m.role}-${idx}`}
                    className={cn('text-sm px-3 py-2 rounded-lg whitespace-pre-wrap', m.role === 'assistant' ? 'bg-blue-50 text-blue-900' : 'bg-gray-100 text-gray-800')}
                  >
                    {m.content}
                  </div>
                ))}
                {chatLoading && <p className="text-xs text-blue-600">解决措施助手正在思考…</p>}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {askTemplates.map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => void sendChatMessage(t)}
                    disabled={chatLoading || !focusProblemId || !focusCauseId}
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
                  placeholder="输入你的教学调整方案、实施环节、执行者与验证方式…"
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
                  disabled={chatLoading || !chatInput.trim() || !focusProblemId || !focusCauseId}
                  className="px-4 py-2 h-fit bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm rounded-lg"
                >
                  发送
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">提示：按 Ctrl/⌘ + Enter 快速发送。助手仅围绕当前问题与归因，不提供长篇泛化分析；需要结构化措施时可输入“请输出结构化措施”。</p>
              {chatError && <p className="mt-2 text-sm text-red-600">{chatError}</p>}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function AddMeasureForm({ saving, onAdd }: {
  saving: boolean
  onAdd: (desc: string) => void
}) {
  const [desc, setDesc] = useState('')
  return (
    <div className="flex gap-2">
      <input
        value={desc}
        onChange={e => setDesc(e.target.value)}
        placeholder="+ 自主添加措施：填写你自己的改进措施…"
        className="flex-1 border border-dashed border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        onKeyDown={e => {
          if (e.key === 'Enter' && desc.trim()) {
            onAdd(desc)
            setDesc('')
          }
        }}
      />
      <button
        onClick={() => { if (desc.trim()) { onAdd(desc); setDesc('') } }}
        disabled={saving || !desc.trim()}
        className="px-4 py-2 bg-gray-600 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
      >
        {saving ? '添加中…' : '添加'}
      </button>
    </div>
  )
}

function MeasureCard({
  measure,
  saving,
  onConfirm,
  onDelete,
  isConfirmed,
}: {
  measure: Measure
  saving: boolean
  onConfirm: (desc: string) => void
  onDelete: () => void
  isConfirmed?: boolean
}) {

  const [desc, setDesc] = useState(measure.description)

  return (
    <div className={cn('bg-white rounded-xl border p-4', isConfirmed ? 'border-green-200 bg-green-50/30' : 'border-gray-200')}>


      <textarea
        value={desc} onChange={e => setDesc(e.target.value)} rows={2}
        className="w-full text-sm text-gray-800 border border-transparent hover:border-gray-200 focus:border-blue-300 rounded-lg px-2 py-1.5 resize-none focus:outline-none transition-colors bg-transparent"
      />
      <div className="flex justify-end gap-2 mt-3">
        <button onClick={onDelete}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors">删除</button>
        {!isConfirmed && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '确认'}
          </button>
        )}
        {isConfirmed && desc !== measure.description && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '保存修改'}
          </button>
        )}
      </div>
    </div>
  )
}
