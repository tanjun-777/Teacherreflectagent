'use client'
import { useState, useCallback, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, Cause, Measure } from '@/types'

import { DragDropContext, Droppable, Draggable, type DropResult, type DraggableProvidedDragHandleProps } from 'react-beautiful-dnd'

import { cn } from '@/lib/utils'
import { appendSessionOperationLog } from '@/lib/session-audit'


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
  onAnalyze: () => Promise<void>
  analyzing: boolean
  analysisError: string
}

const CONFIRMED_DROPPABLE_ID = 'confirmed-priority'



export default function Stage3Measures({ session, problems, causes, measures, setMeasures, onNext, onAnalyze, analyzing, analysisError }: Props) {

  const supabase = createClient()
  const [saving, setSaving] = useState<string | null>(null)
  const [sortingGroup, setSortingGroup] = useState<string | null>(null)
  const [sortError, setSortError] = useState('')

  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([

    {
      role: 'assistant',
      content: '我是解决措施助手，我将帮助你从“原因解释”走向“行动设计”。先从这一步开始：你打算如何具体调整教学？',
    },
  ])

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






  const persistConfirmedPriority = useCallback(async (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return

    const current = measures
      .filter(m => m.confirmed)
      .sort((a, b) => a.sort_order - b.sort_order)

    if (!current.length) return
    if (toIndex < 0 || toIndex >= current.length) return

    const reordered = Array.from(current)

    const [moved] = reordered.splice(fromIndex, 1)
    if (!moved) return
    reordered.splice(toIndex, 0, moved)

    const baseSort = current[0]?.sort_order ?? 0
    const updates = reordered.map((m, idx) => ({ id: m.id, sort_order: baseSort + idx }))
    const updateMap = new Map(updates.map(u => [u.id, u.sort_order]))

    setSortError('')
    setSortingGroup(CONFIRMED_DROPPABLE_ID)

    setMeasures(prev => prev.map(m => {
      const nextSort = updateMap.get(m.id)
      return typeof nextSort === 'number' ? { ...m, sort_order: nextSort } : m
    }))

    try {
      await Promise.all(
        updates.map(u => supabase.from('measures').update({ sort_order: u.sort_order }).eq('id', u.id))
      )
      await appendSessionOperationLog(supabase, session.id, {
        at: new Date().toISOString(),
        stage: 3,
        action: '调整措施优先级',
        targetType: 'measure',
        targetId: moved.id,
        summary: `教师调整已确认措施优先级：${fromIndex + 1} → ${toIndex + 1}`,
        before: moved.description,
      })
    } catch {
      setSortError('优先级保存失败，请重试')
    } finally {
      setSortingGroup(null)
    }

  }, [measures, session.id, setMeasures, supabase])


  const handleDragEnd = useCallback((result: DropResult) => {
    const { source, destination } = result
    if (!destination) return
    if (source.droppableId !== destination.droppableId) return
    if (source.droppableId !== CONFIRMED_DROPPABLE_ID) return

    void persistConfirmedPriority(source.index, destination.index)
  }, [persistConfirmedPriority])



  async function confirmMeasure(m: Measure, desc: string) {
    setSaving(m.id)
    const nextDesc = desc.trim()
    const { data } = await supabase
      .from('measures')
      .update({ confirmed: true, description: nextDesc })
      .eq('id', m.id)
      .select().single()
    if (data) {
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
    }
    setSaving(null)
  }


  async function deleteMeasure(m: Measure) {
    await supabase.from('measures').delete().eq('id', m.id)
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
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }])
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
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-gray-900">阶段 3 — 改进措施</h2>
              <p className="text-gray-500 text-sm mt-1">确认针对每个问题-归因的改进措施（描述可直接编辑）</p>
            </div>
            <button onClick={onAnalyze} disabled={analyzing}
              className="text-sm text-blue-600 hover:underline disabled:opacity-50">
              {analyzing ? '分析中…' : '🔄 重新分析'}
            </button>
          </div>

          {analysisError && <p className="text-red-500 text-sm mb-4">{analysisError}</p>}
          {sortError && <p className="text-red-500 text-sm mb-4">{sortError}</p>}
          {analyzing && <p className="text-blue-600 text-sm mb-4">正在自动生成改进措施，请稍候…</p>}

          {confirmedProblems.map(problem => {
            const problemMeasures = measures
              .filter(m => m.problem_id === problem.id && !m.confirmed && !m.cause_id)
              .sort((a, b) => a.sort_order - b.sort_order)
            const relatedCauses = causes.filter(c => c.problem_id === problem.id && c.confirmed)

            return (
              <div key={problem.id} className="mb-6">
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 mb-3">
                  <p className="text-xs text-blue-400 font-medium mb-1">关联问题</p>
                  <p className="text-sm font-medium text-blue-800">{problem.description}</p>
                </div>

                {relatedCauses.map(cause => {
                  const causeMeasures = measures
                    .filter(m => m.problem_id === problem.id && m.cause_id === cause.id && !m.confirmed)
                    .sort((a, b) => a.sort_order - b.sort_order)

                  return (
                    <div key={cause.id} className="mb-4">
                      <div className="bg-orange-50 border border-orange-100 rounded-lg p-2.5 mb-2">
                        <p className="text-xs text-orange-400 font-medium mb-0.5">归因</p>
                        <p className="text-sm text-orange-800">{cause.description}</p>
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
                        {causeMeasures.length === 0 && (
                          <p className="text-xs text-gray-400">暂无措施，可重新分析</p>
                        )}
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
            <DragDropContext onDragEnd={handleDragEnd}>
              <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-6">
                <p className="text-sm font-medium text-green-800 mb-2">✅ 已确认措施（{confirmedMeasures.length} 条）</p>
                <p className="text-xs text-green-700 mb-3">可在此拖拽或使用上下按钮调整优先级</p>
                <Droppable droppableId={CONFIRMED_DROPPABLE_ID}>
                  {(provided) => (
                    <div ref={provided.innerRef} {...provided.droppableProps} className="space-y-2">
                      {confirmedMeasures.map((m, i) => (
                        <Draggable key={`confirmed-${m.id}`} draggableId={`confirmed-${m.id}`} index={i}>
                          {(dragProvided, snapshot) => (
                            <div
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                              className={cn(
                                'flex items-start gap-2 text-sm text-green-700 py-1 rounded',
                                snapshot.isDragging && 'bg-green-100'
                              )}
                            >
                              <span className="shrink-0 w-5 h-5 bg-green-200 rounded-full flex items-center justify-center text-xs font-bold mt-0.5">{i + 1}</span>
                              <span className="flex-1">{m.description}</span>
                              <button
                                type="button"
                                {...dragProvided.dragHandleProps}
                                disabled={sortingGroup === CONFIRMED_DROPPABLE_ID}
                                className="text-xs px-2 py-1 rounded border border-green-300 text-green-700 cursor-grab active:cursor-grabbing disabled:opacity-40"
                              >
                                拖拽
                              </button>
                              <button
                                type="button"
                                onClick={() => void persistConfirmedPriority(i, i - 1)}
                                disabled={i === 0 || sortingGroup === CONFIRMED_DROPPABLE_ID}
                                className="text-xs px-2 py-1 rounded border border-green-300 text-green-700 disabled:opacity-40"
                              >
                                ↑上移
                              </button>
                              <button
                                type="button"
                                onClick={() => void persistConfirmedPriority(i, i + 1)}
                                disabled={i === confirmedMeasures.length - 1 || sortingGroup === CONFIRMED_DROPPABLE_ID}
                                className="text-xs px-2 py-1 rounded border border-green-300 text-green-700 disabled:opacity-40"
                              >
                                ↓下移
                              </button>
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </div>
            </DragDropContext>
          )}

          <div className="flex justify-end">
            <button
              onClick={onNext}
              disabled={confirmedMeasures.length === 0}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
            >
              进入撰写报告 →
            </button>
          </div>
        </div>

        <aside className="sticky top-6 rounded-xl border border-blue-200 bg-blue-50 p-4">
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
                    className="w-full border border-blue-200 rounded-lg px-3 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                    className="w-full border border-blue-200 rounded-lg px-3 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {focusCauseOptions.length === 0 && <option value="">（该问题暂无已确认归因）</option>}
                    {focusCauseOptions.map(c => (
                      <option key={c.id} value={c.id}>{c.description}</option>
                    ))}
                  </select>
                </div>
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
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors">删除</button>
        {!isConfirmed && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '确认'}
          </button>
        )}
        {isConfirmed && desc !== measure.description && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '保存修改'}
          </button>
        )}
      </div>
    </div>
  )
}
