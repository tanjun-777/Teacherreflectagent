'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession, Problem, SourceTag } from '@/types'
import { SOURCE_LABEL, SOURCE_COLOR } from '@/types'
import { cn } from '@/lib/utils'
import { appendSessionOperationLog } from '@/lib/session-audit'


interface Props {
  session: ReflectionSession
  problems: Problem[]
  setProblems: (p: Problem[] | ((prev: Problem[]) => Problem[])) => void
  onNext: () => void
  onAnalyze: () => Promise<void>
  analyzing: boolean
  analysisError: string
}

export default function Stage1Problems({ session, problems, setProblems, onNext, onAnalyze, analyzing, analysisError }: Props) {
  const supabase = createClient()
  const [newDesc, setNewDesc] = useState('')
  const [saving, setSaving] = useState<string | null>(null)

  const confirmed = problems.filter(p => p.confirmed)
  const pending = problems.filter(p => !p.confirmed)

  async function confirmProblem(p: Problem, desc: string) {
    setSaving(p.id)
    const nextDesc = desc.trim()
    const { data } = await supabase
      .from('problems')
      .update({ confirmed: true, description: nextDesc })
      .eq('id', p.id)
      .select()
      .single()
    if (data) {
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
    }
    setSaving(null)
  }


  async function deleteProblem(p: Problem) {
    await supabase.from('problems').delete().eq('id', p.id)
    setProblems((prev: Problem[]) => prev.filter(x => x.id !== p.id))
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


  async function addManual() {
    if (!newDesc.trim()) return
    setSaving('new')
    const { data } = await supabase
      .from('problems')
      .insert({
        session_id: session.id,
        description: newDesc.trim(),
        source: ['self_review'],
        confirmed: true,
        sort_order: problems.length,
      })
      .select()
      .single()
    if (data) {
      setProblems((prev: Problem[]) => [...prev, data])
      await appendSessionOperationLog(supabase, session.id, {
        at: new Date().toISOString(),
        stage: 1,
        action: '新增问题',
        targetType: 'problem',
        targetId: data.id,
        summary: '教师手动新增并确认问题',
        after: data.description,
      })
    }
    setNewDesc('')
    setSaving(null)
  }


  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">阶段 1 — 问题识别</h2>
          <p className="text-gray-500 text-sm mt-1">确认、编辑或删除 AI 识别的问题（共 {problems.length} 条，最多 15 条）</p>
        </div>
        <button onClick={onAnalyze} disabled={analyzing}
          className="text-sm text-blue-600 hover:underline disabled:opacity-50">
          {analyzing ? '分析中…' : '🔄 重新分析'}
        </button>
      </div>

      {analysisError && <p className="text-red-500 text-sm mb-4">{analysisError}</p>}
      {analyzing && <p className="text-blue-600 text-sm mb-4">正在自动识别问题，请稍候…</p>}

      {pending.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-600 mb-3">
            待确认 ({pending.length})
          </h3>
          <div className="space-y-3">
            {pending.map(p => (
              <ProblemCard
                key={p.id}
                problem={p}
                saving={saving === p.id}
                onConfirm={desc => confirmProblem(p, desc)}
                onDelete={() => deleteProblem(p)}
              />

            ))}
          </div>
        </div>
      )}

      {confirmed.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-600 mb-3">
            已确认 ({confirmed.length})
          </h3>
          <div className="space-y-3">
            {confirmed.map(p => (
              <ProblemCard
                key={p.id}
                problem={p}
                saving={saving === p.id}
                onConfirm={desc => confirmProblem(p, desc)}
                onDelete={() => deleteProblem(p)}
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
            placeholder="描述一个 AI 未能识别的教学问题…"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={e => e.key === 'Enter' && addManual()}
          />
          <button onClick={addManual} disabled={saving === 'new' || !newDesc.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
            添加
          </button>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={onNext}
          disabled={confirmed.length === 0}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          进入归因分析 →
        </button>
      </div>
    </div>
  )
}

function ProblemCard({
  problem, saving, onConfirm, onDelete, isConfirmed
}: {
  problem: Problem
  saving: boolean
  onConfirm: (desc: string) => void
  onDelete: () => void
  isConfirmed?: boolean
}) {
  const [desc, setDesc] = useState(problem.description)
  const evidence = (problem.evidence as Array<{ text: string; source?: string }> | null) ?? []

  return (
    <div className={cn(
      'bg-white rounded-xl border p-4',
      isConfirmed ? 'border-green-200 bg-green-50/30' : 'border-gray-200'
    )}>
      {problem.source && problem.source.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {problem.source.map(s => (
            <span key={s} className={cn('text-xs px-2 py-0.5 rounded-full font-medium', SOURCE_COLOR[s as SourceTag] ?? 'bg-gray-100 text-gray-600')}>
              {SOURCE_LABEL[s as SourceTag] ?? s}
            </span>
          ))}
        </div>
      )}

      <textarea
        value={desc}
        onChange={e => setDesc(e.target.value)}
        rows={2}
        className="w-full text-sm text-gray-800 border border-transparent hover:border-gray-200 focus:border-blue-300 rounded-lg px-2 py-1.5 resize-none focus:outline-none transition-colors bg-transparent"
      />

      {evidence.length > 0 && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-gray-400 font-medium">📎 关键证据</p>
          {evidence.map((e, i) => (
            <p key={i} className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1 line-clamp-1">
              &ldquo;{e.text}&rdquo;
            </p>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 mt-3">
        <button onClick={onDelete}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors">
          删除
        </button>
        {!isConfirmed && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '确认'}
          </button>
        )}
        {isConfirmed && desc !== problem.description && (
          <button onClick={() => onConfirm(desc)} disabled={saving}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors">
            {saving ? '保存…' : '保存修改'}
          </button>
        )}
      </div>
    </div>
  )
}

