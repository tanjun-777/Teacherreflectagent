'use client'
import { useEffect, useMemo, useState } from 'react'

import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, Cause } from '@/types'

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

  setCauses: (c: Cause[] | ((prev: Cause[]) => Cause[])) => void
  onNext: () => void
  onAnalyze: () => Promise<void>
  analyzing: boolean
  analysisError: string
}

export default function Stage2Causes({ session, problems, causes, setCauses, onNext, onAnalyze, analyzing, analysisError }: Props) {


  const supabase = createClient()
  const [saving, setSaving] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([

    {
      role: 'assistant',
      content: '我是归因分析助手，我将帮助你从“现象判断”走向“因果解释”。先从这一步开始：你观察到的具体现象是什么？',
    },
  ])

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
    const nextDesc = desc.trim()
    const { data } = await supabase
      .from('causes')
      .update({ confirmed: true, description: nextDesc })
      .eq('id', c.id)
      .select()
      .single()
    if (data) {
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
    }
    setSaving(null)
  }


  async function deleteCause(c: Cause) {
    await supabase.from('causes').delete().eq('id', c.id)
    setCauses((prev: Cause[]) => prev.filter(x => x.id !== c.id))
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
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }])
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


  return (
    <div className="p-6 max-w-[1440px] mx-auto">
      <div className="grid grid-cols-[minmax(0,1fr)_460px] gap-6 items-start">

        <div>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-gray-900">阶段 2 — 归因分析</h2>
              <p className="text-gray-500 text-sm mt-1">确认每个问题的深层原因（原因描述可直接编辑）</p>
            </div>
            <button onClick={onAnalyze} disabled={analyzing}
              className="text-sm text-blue-600 hover:underline disabled:opacity-50">
              {analyzing ? '分析中…' : '🔄 重新分析'}
            </button>
          </div>

          {analysisError && <p className="text-red-500 text-sm mb-4">{analysisError}</p>}
          {analyzing && <p className="text-blue-600 text-sm mb-4">正在自动生成归因，请稍候…</p>}

          {confirmedProblems.map(problem => {
            const problemCauses = causes.filter(c => c.problem_id === problem.id)
            const pendingCauses = problemCauses.filter(c => !c.confirmed)
            const confirmedProbCauses = problemCauses.filter(c => c.confirmed)

            return (
              <div key={problem.id} className="mb-6">
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 mb-3">
                  <p className="text-xs text-blue-400 font-medium mb-1">关联问题</p>
                  <p className="text-sm font-medium text-blue-800">{problem.description}</p>
                </div>

                {problemCauses.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">暂无 AI 分析的归因，可重新分析</p>
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
              </div>
            )
          })}

          <div className="flex justify-end gap-3 mt-4">
            <button
              onClick={onNext}
              disabled={confirmedCauses.length === 0}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
            >
              进入改进措施 →
            </button>
          </div>
        </div>

        <aside className="sticky top-6 rounded-xl border border-blue-200 bg-blue-50 p-4">
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
                  className="w-full border border-blue-200 rounded-lg px-3 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {confirmedProblems.length === 0 && <option value="">（请先确认问题）</option>}
                  {confirmedProblems.map(p => (
                    <option key={p.id} value={p.id}>{p.description}</option>
                  ))}
                </select>
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
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors">删除</button>
        {!isConfirmed && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '确认'}
          </button>
        )}
        {isConfirmed && desc !== cause.description && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '保存修改'}
          </button>
        )}
      </div>
    </div>
  )
}
