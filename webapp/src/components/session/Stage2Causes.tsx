'use client'
import { useEffect, useMemo, useState } from 'react'

import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, Cause } from '@/types'

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

  setCauses: (c: Cause[] | ((prev: Cause[]) => Cause[])) => void
  onNext: () => void
  // 删除归因后数据库将关联措施 cause_id 置空（on delete set null），需同步向导本地状态
  onCauseDeleted?: (causeId: string) => void
  // 刷新后恢复的历史对话（draft_snapshot.cause_chat_dialogue）
  initialChatMessages?: ChatMessage[]
}

export default function Stage2Causes({ session, problems, causes, setCauses, onNext, onCauseDeleted, initialChatMessages }: Props) {


  const supabase = createClient()
  const [saving, setSaving] = useState<string | null>(null)
  const [analyzingId, setAnalyzingId] = useState<string | null>(null)
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
          content: '我是归因分析助手，我将帮助你从“现象判断”走向“因果解释”。先从这一步开始：你观察到的具体现象是什么？',
        },
      ]
  )

  const confirmedProblems = useMemo(() => problems.filter(p => p.confirmed), [problems])
  const [focusProblemId, setFocusProblemId] = useState<string>('')

  useEffect(() => {
    if (!confirmedProblems.length) {
      setFocusProblemId('')
      return
    }
    if (!focusProblemId || !confirmedProblems.some(p => p.id === focusProblemId)) {
      setFocusProblemId(confirmedProblems[0].id)
    }
  }, [confirmedProblems, focusProblemId])


  async function confirmCause(c: Cause, desc: string) {
    setSaving(c.id)
    setActionError(null)
    const nextDesc = desc.trim()
    const { data, error } = await supabase
      .from('causes')
      .update({ confirmed: true, description: nextDesc })
      .eq('id', c.id)
      .select()
      .single()
    if (error || !data) {
      setActionError(`归因保存失败：${error?.message ?? '未知错误'}。当前修改未生效，请重试或刷新页面。`)
      setSaving(null)
      return
    }
    setCauses((prev: Cause[]) => prev.map(x => x.id === c.id ? data : x))
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 2,
      action: c.confirmed ? '修改归因' : '确认归因',
      targetType: 'cause',
      targetId: c.id,
      summary: c.confirmed ? '教师修改了已确认归因描述' : '教师确认了待确认归因',
      before: c.description,
      after: nextDesc,
    })
    setSaving(null)
  }


  async function deleteCause(c: Cause) {
    setActionError(null)
    const { error } = await supabase.from('causes').delete().eq('id', c.id)
    if (error) {
      setActionError(`删除失败：${error.message}。该归因未被删除，请重试。`)
      return
    }
    setCauses((prev: Cause[]) => prev.filter(x => x.id !== c.id))
    // 数据库将引用该归因的措施 cause_id 置 null，同步本地状态避免措施在界面丢失
    onCauseDeleted?.(c.id)
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 2,
      action: '删除归因',
      targetType: 'cause',
      targetId: c.id,
      summary: '教师删除了归因条目',
      before: c.description,
    })
  }

  // 单问题按需生成归因分析线索（支持重新生成）
  async function analyzeCausesForProblem(problem: Problem) {
    setAnalyzingId(problem.id)
    setStageError(null)
    try {
      const res = await fetch('/api/ai/analyze-causes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem_id: problem.id }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '归因分析失败')
      const { data } = await supabase
        .from('causes')
        .select('*')
        .eq('problem_id', problem.id)
        .order('sort_order')
      if (data) {
        setCauses((prev: Cause[]) => [...prev.filter(c => c.problem_id !== problem.id), ...data])
        await appendSessionOperationLog(supabase, session.id, {
          at: new Date().toISOString(),
          stage: 2,
          action: '归因分析线索',
          targetType: 'problem',
          targetId: problem.id,
          summary: `AI 针对问题及其关联证据生成了 ${json.count} 条归因线索`,
        })
      }
    } catch (err) {
      setStageError(err instanceof Error ? err.message : '归因分析失败')
    } finally {
      setAnalyzingId(null)
    }
  }

  // 教师自主归因
  async function addManualCause(problem: Problem, desc: string) {
    const nextDesc = desc.trim()
    if (!nextDesc) return
    setSaving(`new-${problem.id}`)
    setActionError(null)
    const { data, error } = await supabase
      .from('causes')
      .insert({
        session_id: session.id,
        problem_id: problem.id,
        description: nextDesc,
        confirmed: true,
        sort_order: causes.filter(c => c.problem_id === problem.id).length,
      })
      .select()
      .single()
    if (error || !data) {
      setActionError(`新增归因失败：${error?.message ?? '未知错误'}。请重试。`)
      setSaving(null)
      return
    }
    setCauses((prev: Cause[]) => [...prev, data])
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 2,
      action: '自主归因',
      targetType: 'cause',
      targetId: data.id,
      summary: '教师自主添加了归因',
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
      stage: 2,
      action: '机器人对话-教师提问',
      targetType: 'cause',
      targetId: focusProblemId || undefined,
      summary: '教师向归因分析助手发送消息',
      after: content.slice(0, 2000),
    }).catch(() => undefined)

    try {
      const res = await fetch('/api/ai/cause-coach-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.id,
          problem_id: focusProblemId || undefined,
          messages: nextMessages,
        }),
      })

      const payload = await res.json().catch(() => null) as { error?: string; reply?: string } | null
      if (!res.ok) throw new Error(payload?.error ?? '归因对话失败')

      const reply = String(payload?.reply ?? '').trim() || '我已收到。请继续提供更具体的课堂现象与证据。'
      const fullMessages: ChatMessage[] = [...nextMessages, { role: 'assistant', content: reply }]
      setChatMessages(fullMessages)
      // 持久化对话到 draft_snapshot（串行队列防并发覆盖），刷新后可恢复
      void updateDraftSnapshotFields(supabase, session.id, snap => ({
        ...snap,
        cause_chat_dialogue: fullMessages.slice(-60),
      })).catch(() => undefined)
      void appendSessionOperationLog(supabase, session.id, {
        at: new Date().toISOString(),
        stage: 2,
        action: '机器人对话-助手回复',
        targetType: 'cause',
        targetId: focusProblemId || undefined,
        summary: '归因分析助手回复消息',
        after: reply.slice(0, 2000),
      }).catch(() => undefined)
    } catch (err: unknown) {
      // 回滚乐观更新：失败的消息不保留在界面上（也未持久化），内容放回输入框便于修改后重发
      setChatMessages(chatMessages)
      setChatInput(content)
      setChatError(err instanceof Error ? err.message : '归因对话失败')
    } finally {
      setChatLoading(false)
    }
  }


  const askTemplates = [
    '你观察到的具体现象是什么？',
    '你认为它属于哪一类问题？',
    '可能的根本原因是什么？',
    '有什么课堂证据支持？',
  ]

  const confirmedCauses = causes.filter(c => c.confirmed)
  const pendingCausesCount = causes.filter(c => !c.confirmed).length


  return (
    <div className="p-6 max-w-[1440px] mx-auto">
      <div className="grid grid-cols-[minmax(0,1fr)_460px] gap-6 items-start">

        <div>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-gray-900">阶段2 · 步骤2 ｜ 归因分析</h2>
              <p className="text-gray-400 text-xs mt-1">点击每个问题的「归因分析线索」由 AI 针对该问题及其证据生成，或自主添加归因（描述可直接编辑）</p>
            </div>
          </div>

          {stageError && <p className="text-red-500 text-sm mb-4">{stageError}</p>}
          {actionError && (
            <p className="text-sm mb-4 rounded-lg border border-red-200 bg-red-50 text-red-600 px-3 py-2">{actionError}</p>
          )}

          {confirmedProblems.map(problem => {
            const problemCauses = causes.filter(c => c.problem_id === problem.id)
            const pendingCauses = problemCauses.filter(c => !c.confirmed)
            const confirmedProbCauses = problemCauses.filter(c => c.confirmed)
            const evidence = (problem.evidence as Array<{ text: string; source?: string }> | null) ?? []

            return (
              <div key={problem.id} className="mb-6">
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 mb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-blue-400 font-medium mb-1">关联问题</p>
                      <p className="text-sm font-medium text-blue-800">{problem.description}</p>
                    </div>
                    <button
                      onClick={() => analyzeCausesForProblem(problem)}
                      disabled={analyzingId === problem.id}
                      className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shrink-0 whitespace-nowrap"
                    >
                      {analyzingId === problem.id ? '归因分析中…' : problemCauses.length > 0 ? '🔄 重新生成归因线索' : '🔍 归因分析线索'}
                    </button>
                  </div>
                  {evidence.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-blue-100 space-y-1">
                      <p className="text-[11px] text-blue-400 font-medium">📎 该问题关联证据</p>
                      {evidence.map((e, i) => (
                        <p key={i} className="text-[11px] text-blue-700/80 line-clamp-1">&ldquo;{e.text}&rdquo;</p>
                      ))}
                    </div>
                  )}
                </div>

                {problemCauses.length === 0 && analyzingId !== problem.id && (
                  <p className="text-xs text-gray-400 text-center py-2">暂无归因线索，点击「归因分析线索」由 AI 生成，或在下方自主归因</p>
                )}

                <div className="space-y-3">
                  {pendingCauses.map(c => (
                    <CauseCard
                      key={c.id} cause={c} saving={saving === c.id}
                      onConfirm={desc => confirmCause(c, desc)}
                      onDelete={() => deleteCause(c)}

                    />
                  ))}
                  {confirmedProbCauses.map(c => (
                    <CauseCard
                      key={c.id} cause={c} saving={saving === c.id}
                      onConfirm={desc => confirmCause(c, desc)}
                      onDelete={() => deleteCause(c)}
                      isConfirmed

                    />
                  ))}
                </div>

                <AddCauseForm
                  saving={saving === `new-${problem.id}`}
                  onAdd={desc => addManualCause(problem, desc)}
                />
              </div>
            )
          })}

          <div className="flex justify-end items-center gap-3 mt-4">
            {pendingCausesCount > 0 && (
              <span className="text-xs text-amber-600">还有 {pendingCausesCount} 条待确认归因，确认或删除后方可进入下一环节</span>
            )}
            <button
              onClick={onNext}
              disabled={confirmedCauses.length === 0 || pendingCausesCount > 0}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
            >
              进入改进措施 →
            </button>
          </div>
        </div>

        <aside className="sticky top-6 max-h-[calc(100vh-3rem)] flex flex-col rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">AI</div>
            <div>
              <p className="text-base font-semibold text-blue-900">归因分析助手</p>
              <p className="text-xs text-blue-700">帮助教师分析教学问题的原因</p>
            </div>
          </div>

          {!chatOpen ? (
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="w-full px-3 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
              disabled={confirmedProblems.length === 0}
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

              <div className="mb-3">
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

              <div className="bg-white border border-blue-100 rounded-lg p-3 flex-1 min-h-[140px] overflow-y-auto space-y-2">
                {chatMessages.map((m, idx) => (
                  <div
                    key={`${m.role}-${idx}`}
                    className={cn('text-sm px-3 py-2 rounded-lg whitespace-pre-wrap', m.role === 'assistant' ? 'bg-blue-50 text-blue-900' : 'bg-gray-100 text-gray-800')}
                  >
                    {m.content}
                  </div>
                ))}
                {chatLoading && <p className="text-xs text-blue-600">归因分析助手正在思考…</p>}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {askTemplates.map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => void sendChatMessage(t)}
                    disabled={chatLoading || confirmedProblems.length === 0}
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
                  placeholder="输入你观察到的现象、可能原因或课堂证据…"
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
                  disabled={chatLoading || !chatInput.trim() || confirmedProblems.length === 0}
                  className="px-4 py-2 h-fit bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm rounded-lg"
                >
                  发送
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">提示：按 Ctrl/⌘ + Enter 快速发送。助手仅围绕当前聚焦问题，不提供长篇泛化分析；需要结构化归因时可输入“请输出归因结果”。</p>
              {chatError && <p className="mt-2 text-sm text-red-600">{chatError}</p>}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function AddCauseForm({ saving, onAdd }: {
  saving: boolean
  onAdd: (desc: string) => void
}) {
  const [desc, setDesc] = useState('')
  return (
    <div className="mt-3 flex gap-2">
      <input
        value={desc}
        onChange={e => setDesc(e.target.value)}
        placeholder="+ 自主归因：填写你自己分析的原因…"
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

function CauseCard({ cause, saving, onConfirm, onDelete, isConfirmed }: {
  cause: Cause
  saving: boolean
  onConfirm: (desc: string) => void
  onDelete: () => void
  isConfirmed?: boolean
}) {
  const [desc, setDesc] = useState(cause.description)
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
        {isConfirmed && desc !== cause.description && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '保存修改'}
          </button>
        )}
      </div>
    </div>
  )
}
