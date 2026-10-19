'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, SourceTag, EvidenceSourceTag } from '@/types'
import { SOURCE_LABEL, SOURCE_COLOR, EVIDENCE_SOURCE_LABEL } from '@/types'
import { cn } from '@/lib/utils'
import { appendSessionOperationLog, updateDraftSnapshotFields } from '@/lib/session-audit'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

interface Props {
  session: ReflectionSession
  problems: Problem[]
  setProblems: (p: Problem[] | ((prev: Problem[]) => Problem[])) => void
  onNext: () => void
  onAnalyze: () => Promise<void>
  analyzing: boolean
  analysisError: string
  // 删除问题后数据库会级联删除其归因/措施，需同步清理向导本地状态
  onProblemDeleted?: (problemId: string) => void
  // 刷新后恢复的历史对话（draft_snapshot.problem_chat_dialogue）
  initialChatMessages?: ChatMessage[]
}

const MANUAL_SOURCE_OPTIONS: Array<{ value: SourceTag; label: string }> = [
  { value: 'teacher_manual', label: '教师自主新增' },
  { value: 'self_review', label: '教师自评' },
  { value: 'peer_review', label: '多主体同伴评价' },
  { value: 'external_feedback', label: '外部智慧教研系统反馈' },
]

const EVIDENCE_SOURCE_OPTIONS: EvidenceSourceTag[] = ['teaching_design', 'student_performance', 'learning_outcomes', 'classroom_record', 'external_feedback']

export default function Stage1Problems({ session, problems, setProblems, onNext, onAnalyze, analyzing, analysisError, onProblemDeleted, initialChatMessages }: Props) {
  const supabase = createClient()
  const [newDesc, setNewDesc] = useState('')
  const [newSource, setNewSource] = useState<SourceTag>('teacher_manual')
  const [saving, setSaving] = useState<string | null>(null)
  const [linkingId, setLinkingId] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [extractTried, setExtractTried] = useState(false)
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
          content: '我是问题聚焦助手，我将帮助你完成两件事：先基于课堂证据判断观察到的现象是否构成教学问题，再把问题聚焦得具体、可反思。先从这一步开始：你观察到的课堂现象是什么？',
        },
      ]
  )

  // 问题聚焦助手对话：基于证据的问题判断＋问题聚焦引导（追问式，不代答）
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
      stage: 1,
      action: '机器人对话-教师提问',
      targetType: 'problem',
      summary: '教师向问题聚焦助手发送消息',
      after: content.slice(0, 2000),
    }).catch(() => undefined)

    try {
      const res = await fetch('/api/ai/problem-coach-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.id,
          messages: nextMessages,
        }),
      })

      const payload = await res.json().catch(() => null) as { error?: string; reply?: string } | null
      if (!res.ok) throw new Error(payload?.error ?? '问题对话失败')

      const reply = String(payload?.reply ?? '').trim() || '我已收到。请继续提供更具体的课堂现象与证据。'
      const fullMessages: ChatMessage[] = [...nextMessages, { role: 'assistant', content: reply }]
      setChatMessages(fullMessages)
      // 持久化对话到 draft_snapshot（串行队列防并发覆盖），刷新后可恢复
      void updateDraftSnapshotFields(supabase, session.id, snap => ({
        ...snap,
        problem_chat_dialogue: fullMessages.slice(-60),
      })).catch(() => undefined)
      void appendSessionOperationLog(supabase, session.id, {
        at: new Date().toISOString(),
        stage: 1,
        action: '机器人对话-助手回复',
        targetType: 'problem',
        summary: '问题聚焦助手回复消息',
        after: reply.slice(0, 2000),
      }).catch(() => undefined)
    } catch (err: unknown) {
      // 回滚乐观更新：失败的消息不保留在界面上（也未持久化），内容放回输入框便于修改后重发
      setChatMessages(chatMessages)
      setChatInput(content)
      setChatError(err instanceof Error ? err.message : '问题对话失败')
    } finally {
      setChatLoading(false)
    }
  }

  const askTemplates = [
    '你观察到的课堂现象是什么？',
    '有什么课堂证据支持？',
    '这个现象反映了哪个教学问题？',
    '这个问题的表述是否具体、可归因？',
  ]

  const confirmed = problems.filter(p => p.confirmed)
  const pending = problems.filter(p => !p.confirmed)

  async function handleAnalyze() {
    setExtractTried(true)
    await onAnalyze()
  }

  async function confirmProblem(p: Problem, desc: string) {
    setSaving(p.id)
    setActionError(null)
    const nextDesc = desc.trim()
    const { data, error } = await supabase
      .from('problems')
      .update({ confirmed: true, description: nextDesc })
      .eq('id', p.id)
      .select()
      .single()
    if (error || !data) {
      setActionError(`问题保存失败：${error?.message ?? '未知错误'}。当前修改未生效，请重试或刷新页面。`)
      setSaving(null)
      return
    }
    setProblems((prev: Problem[]) => prev.map(x => x.id === p.id ? data : x))
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 1,
      action: p.confirmed ? '修改问题' : '确认问题',
      targetType: 'problem',
      targetId: p.id,
      summary: p.confirmed ? '教师修改了已确认问题描述' : '教师确认了待确认问题',
      before: p.description,
      after: nextDesc,
    })
    setSaving(null)
  }


  async function deleteProblem(p: Problem) {
    setActionError(null)
    const { error } = await supabase.from('problems').delete().eq('id', p.id)
    if (error) {
      setActionError(`删除失败：${error.message}。该问题未被删除，请重试。`)
      return
    }
    setProblems((prev: Problem[]) => prev.filter(x => x.id !== p.id))
    // 数据库外键级联删除该问题下归因(measures.cause_id set null / problems cascade)，同步本地状态避免幽灵条目
    onProblemDeleted?.(p.id)
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 1,
      action: '删除问题',
      targetType: 'problem',
      targetId: p.id,
      summary: '教师删除了问题条目',
      before: p.description,
    })
  }

  async function linkEvidence(p: Problem) {
    setLinkingId(p.id)
    setLinkError(null)
    try {
      const res = await fetch('/api/ai/link-evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem_id: p.id }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '证据关联失败')
      const { data } = await supabase.from('problems').select('*').eq('id', p.id).single()
      if (data) {
        setProblems((prev: Problem[]) => prev.map(x => x.id === p.id ? data : x))
        await appendSessionOperationLog(supabase, session.id, {
          at: new Date().toISOString(),
          stage: 1,
          action: '证据关联',
          targetType: 'problem',
          targetId: p.id,
          summary: `AI 为问题关联了 ${json.count} 条证据（教学设计/学生表现/学习结果/课堂实录/外部反馈）`,
        })
      }
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : '证据关联失败')
    } finally {
      setLinkingId(null)
    }
  }

  async function saveEvidence(p: Problem, evidence: Array<{ text: string; source?: string }>, summary: string, action: string) {
    setSaving(`ev-${p.id}`)
    setActionError(null)
    const { data, error } = await supabase
      .from('problems')
      .update({ evidence })
      .eq('id', p.id)
      .select()
      .single()
    if (error || !data) {
      setActionError(`证据保存失败：${error?.message ?? '未知错误'}。请重试。`)
      setSaving(null)
      return
    }
    setProblems((prev: Problem[]) => prev.map(x => x.id === p.id ? data : x))
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 1,
      action,
      targetType: 'problem',
      targetId: p.id,
      summary,
    })
    setSaving(null)
  }

  async function addManual() {
    if (!newDesc.trim()) return
    setSaving('new')
    setActionError(null)
    const { data, error } = await supabase
      .from('problems')
      .insert({
        session_id: session.id,
        description: newDesc.trim(),
        source: [newSource],
        confirmed: true,
        sort_order: problems.length,
      })
      .select()
      .single()
    if (error || !data) {
      setActionError(`新增问题失败：${error?.message ?? '未知错误'}。请重试。`)
      setSaving(null)
      return
    }
    setProblems((prev: Problem[]) => [...prev, data])
    await appendSessionOperationLog(supabase, session.id, {
      at: new Date().toISOString(),
      stage: 1,
      action: '新增问题',
      targetType: 'problem',
      targetId: data.id,
      summary: `教师手动新增问题（来源：${SOURCE_LABEL[newSource]}）`,
      after: data.description,
    })
    setNewDesc('')
    setSaving(null)
  }


  return (
    <div className="p-6 max-w-[1440px] mx-auto">
      <div className="grid grid-cols-[minmax(0,1fr)_460px] gap-6 items-start">
        <div>
          <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">阶段2 · 步骤1 ｜ 明确问题</h2>
          <p className="text-gray-400 text-xs mt-1">问题从教师自评、多主体同伴评价与外部智慧教研系统反馈中提取；资料中无问题时由教师自主判断、手动输入（共 {problems.length} 条）</p>
        </div>
        <button onClick={handleAnalyze} disabled={analyzing}
          className="text-sm text-blue-600 hover:underline disabled:opacity-50 whitespace-nowrap ml-4">
          {analyzing ? '提取中…' : '🔄 从反馈资料提取问题'}
        </button>
      </div>

      {analysisError && <p className="text-red-500 text-sm mb-4">{analysisError}</p>}
      {actionError && (
        <p className="text-sm mb-4 rounded-lg border border-red-200 bg-red-50 text-red-600 px-3 py-2">{actionError}</p>
      )}
      {linkError && <p className="text-red-500 text-sm mb-4">证据关联失败：{linkError}</p>}
      {analyzing && <p className="text-blue-600 text-sm mb-4">正在从反馈资料中提取问题，请稍候…</p>}
      {extractTried && !analyzing && problems.length === 0 && (!analysisError || analysisError.includes('缺少可分析的反馈文本')) && (
        <p className="text-sm mb-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 px-3 py-2">
          未从反馈资料中提取到教学问题（资料为空或未提及问题），请教师自主判断，在下方手动添加教学问题。
        </p>
      )}

      {pending.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-600 mb-3">
            待确认 ({pending.length})
          </h3>
          <div className="space-y-3">
            {pending.map(p => (
              <ProblemCard
                key={p.id}
                problem={p}
                saving={saving === p.id}
                evSaving={saving === `ev-${p.id}`}
                linking={linkingId === p.id}
                onConfirm={desc => confirmProblem(p, desc)}
                onDelete={() => deleteProblem(p)}
                onLinkEvidence={() => linkEvidence(p)}
                onSaveEvidence={(ev, summary, action) => saveEvidence(p, ev, summary, action)}
              />
            ))}
          </div>
        </div>
      )}

      {confirmed.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-600 mb-3">
            已确认 ({confirmed.length})
          </h3>
          <div className="space-y-3">
            {confirmed.map(p => (
              <ProblemCard
                key={p.id}
                problem={p}
                saving={saving === p.id}
                evSaving={saving === `ev-${p.id}`}
                linking={linkingId === p.id}
                onConfirm={desc => confirmProblem(p, desc)}
                onDelete={() => deleteProblem(p)}
                onLinkEvidence={() => linkEvidence(p)}
                onSaveEvidence={(ev, summary, action) => saveEvidence(p, ev, summary, action)}
                isConfirmed
              />
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-dashed border-gray-300 p-4 mb-6">
        <p className="text-sm font-medium text-gray-700 mb-2">+ 手动添加问题</p>
        <div className="flex gap-2">
          <input
            value={newDesc} onChange={e => setNewDesc(e.target.value)}
            placeholder="描述一个反馈文本中未提及的教学问题…"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={e => e.key === 'Enter' && addManual()}
          />
          <select
            value={newSource}
            onChange={e => setNewSource(e.target.value as SourceTag)}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {MANUAL_SOURCE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button onClick={addManual} disabled={saving === 'new' || !newDesc.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
            添加
          </button>
        </div>
      </div>

      <div className="flex justify-end items-center gap-3">
        {pending.length > 0 && (
          <span className="text-xs text-amber-600">还有 {pending.length} 条待确认问题，确认或删除后方可进入下一环节</span>
        )}
        <button
          onClick={onNext}
          disabled={confirmed.length === 0 || pending.length > 0}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          进入归因分析 →
        </button>
      </div>
        </div>

        <aside className="sticky top-6 max-h-[calc(100vh-3rem)] flex flex-col rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">AI</div>
            <div>
              <p className="text-base font-semibold text-blue-900">问题聚焦助手</p>
              <p className="text-xs text-blue-700">基于证据判断并聚焦教学问题</p>
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

              <div className="bg-white border border-blue-100 rounded-lg p-3 flex-1 min-h-[140px] overflow-y-auto space-y-2">
                {chatMessages.map((m, idx) => (
                  <div
                    key={`${m.role}-${idx}`}
                    className={cn('text-sm px-3 py-2 rounded-lg whitespace-pre-wrap', m.role === 'assistant' ? 'bg-blue-50 text-blue-900' : 'bg-gray-100 text-gray-800')}
                  >
                    {m.content}
                  </div>
                ))}
                {chatLoading && <p className="text-xs text-blue-600">问题聚焦助手正在思考…</p>}
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
                  placeholder="输入你观察到的课堂现象、困惑或初步的问题想法…"
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
              <p className="mt-1 text-xs text-gray-500">提示：按 Ctrl/⌘ + Enter 快速发送。助手仅围绕本节课材料聚焦问题，不提供长篇泛化分析；需要结构化问题时可输入“请输出问题”。</p>
              {chatError && <p className="mt-2 text-sm text-red-600">{chatError}</p>}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

type EvidenceItem = { text: string; source?: string }

function evidenceSourceLabel(source?: string) {
  if (source === 'manual') return '自主关联' // 兼容历史数据
  return EVIDENCE_SOURCE_LABEL[source as EvidenceSourceTag] ?? source ?? '未标注'
}

function ProblemCard({
  problem, saving, evSaving, linking, onConfirm, onDelete, onLinkEvidence, onSaveEvidence, isConfirmed
}: {
  problem: Problem
  saving: boolean
  evSaving: boolean
  linking: boolean
  onConfirm: (desc: string) => void
  onDelete: () => void
  onLinkEvidence: () => void
  onSaveEvidence: (evidence: Array<{ text: string; source?: string }>, summary: string, action: string) => void
  isConfirmed?: boolean
}) {
  const [desc, setDesc] = useState(problem.description)
  const evidence = (problem.evidence as EvidenceItem[] | null) ?? []
  // 本地编辑态：初始为数据库值
  const [evDraft, setEvDraft] = useState<EvidenceItem[]>(evidence)
  const [evDirty, setEvDirty] = useState(false)
  const [addingEvidence, setAddingEvidence] = useState(false)
  const [newEvidenceText, setNewEvidenceText] = useState('')
  const [newEvidenceSource, setNewEvidenceSource] = useState<EvidenceSourceTag>('teaching_design')
  const evKey = JSON.stringify(evidence)
  if (!evDirty && JSON.stringify(evDraft) !== evKey) {
    setEvDraft(evidence)
  }

  const shownSources = problem.source ?? []

  return (

    <div className={cn(
      'bg-white rounded-xl border p-4',
      isConfirmed ? 'border-green-200 bg-green-50/30' : 'border-gray-200'
    )}>
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {shownSources.map(s => (
          <span key={s} className={cn('text-xs px-2 py-0.5 rounded-full font-medium', SOURCE_COLOR[s as SourceTag] ?? 'bg-gray-100 text-gray-600')}>
            {SOURCE_LABEL[s as SourceTag] ?? s}
          </span>
        ))}
      </div>


      <textarea
        value={desc}
        onChange={e => setDesc(e.target.value)}
        rows={2}
        className="w-full text-sm text-gray-800 border border-transparent hover:border-gray-200 focus:border-blue-300 rounded-lg px-2 py-1.5 resize-none focus:outline-none transition-colors bg-transparent"
      />

      {/* 证据关联区 */}
      <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50/50 p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-gray-500 font-medium">📎 关联证据（{evidence.length}）</p>
          <button
            onClick={onLinkEvidence}
            disabled={linking}
            className="text-sm px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {linking ? '证据关联中…' : evidence.length > 0 ? '🔄 重新关联证据' : '📎 证据关联'}
          </button>
        </div>

        {evidence.length === 0 && !linking && (
          <p className="text-xs text-gray-400">尚无关联证据，点击「证据关联」由 AI 检索，或在下方自主关联</p>
        )}

        {evDraft.length > 0 && (
          <div className="space-y-2">
            {evDraft.map((e, i) => (
              <div key={i} className="bg-white rounded-lg border border-gray-100 p-2">
                <div className="flex items-center justify-between mb-1">
                  <span className={cn(
                    'text-[11px] px-1.5 py-0.5 rounded-full font-medium',
                    e.source === 'manual' ? 'bg-teal-100 text-teal-700' : 'bg-blue-50 text-blue-600'
                  )}>
                    {evidenceSourceLabel(e.source)}
                  </span>
                  <button
                    onClick={() => {
                      const next = evDraft.filter((_, j) => j !== i)
                      setEvDraft(next)
                      setEvDirty(true)
                      onSaveEvidence(next, '教师删除了一条关联证据', '删除证据')
                    }}
                    className="text-[11px] text-gray-400 hover:text-red-600"
                  >
                    删除
                  </button>
                </div>
                <textarea
                  value={e.text}
                  onChange={ev => {
                    const next = evDraft.map((x, j) => j === i ? { ...x, text: ev.target.value } : x)
                    setEvDraft(next)
                    setEvDirty(true)
                  }}
                  rows={2}
                  className="w-full text-xs text-gray-700 border border-transparent hover:border-gray-200 focus:border-blue-300 rounded px-1.5 py-1 resize-none focus:outline-none transition-colors bg-transparent"
                />
              </div>
            ))}
          </div>
        )}

        {evDirty && (
          <button
            onClick={() => {
              onSaveEvidence(evDraft.filter(e => e.text.trim()), '教师编辑了关联的证据内容', '编辑证据')
              setEvDirty(false)
            }}
            disabled={evSaving}
            className="mt-2 text-sm px-3 py-1.5 rounded-lg bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
          >
            {evSaving ? '保存中…' : '保存证据修改'}
          </button>
        )}

        {/* 自主关联证据 */}
        {!addingEvidence ? (
          <button
            onClick={() => setAddingEvidence(true)}
            className="mt-2 text-xs text-blue-600 hover:underline"
          >
            + 自主关联证据
          </button>
        ) : (
          <div className="mt-2 pt-2 border-t border-gray-100 space-y-1.5">
            <textarea
              value={newEvidenceText}
              onChange={e => setNewEvidenceText(e.target.value)}
              rows={2}
              placeholder="填写要关联的证据内容（源自教学材料原文）…"
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
            <div className="flex gap-2">
              <select
                value={newEvidenceSource}
                onChange={e => setNewEvidenceSource(e.target.value as EvidenceSourceTag)}
                className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {EVIDENCE_SOURCE_OPTIONS.map(s => (
                  <option key={s} value={s}>{EVIDENCE_SOURCE_LABEL[s]}</option>
                ))}
              </select>
              <button
                onClick={() => {
                  if (!newEvidenceText.trim()) return
                  const next = [...evDraft, { text: newEvidenceText.trim(), source: newEvidenceSource }]
                  setEvDraft(next)
                  setEvDirty(false)
                  onSaveEvidence(next, `教师自主关联了证据（来源：${EVIDENCE_SOURCE_LABEL[newEvidenceSource]}）`, '自主关联证据')
                  setNewEvidenceText('')
                  setAddingEvidence(false)
                }}
                disabled={!newEvidenceText.trim()}
                className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                添加
              </button>
              <button
                onClick={() => { setAddingEvidence(false); setNewEvidenceText('') }}
                className="px-3 py-1.5 text-sm border border-gray-200 text-gray-500 rounded-lg hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 mt-3">
        <button onClick={onDelete}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors">
          删除
        </button>
        {!isConfirmed && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '确认'}
          </button>
        )}
        {isConfirmed && desc !== problem.description && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '保存修改'}
          </button>
        )}
      </div>
    </div>
  )
}
