import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import type { ReflectionSession, Profile } from '@/types'
import DeleteSessionButton from './DeleteSessionButton'


export default async function AdminSessionsPage() {
  const supabase = createClient()
  // 列表最多展示 500 条（按更新时间倒序），并用 count 提示总数
  const PAGE_LIMIT = 500
  const [{ data: rawSessions }, { count: totalCount }] = await Promise.all([
    supabase
      .from('reflection_sessions')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(PAGE_LIMIT),
    supabase
      .from('reflection_sessions')
      .select('*', { count: 'exact', head: true }),
  ])

  const sessions = (rawSessions ?? []) as ReflectionSession[]

  const teacherIds = [...new Set(sessions.map(s => s.teacher_id))]
  let teacherMap: Record<string, Profile> = {}
  if (teacherIds.length) {
    const { data: rawTeachers } = await supabase.from('profiles').select('*').in('id', teacherIds)
    teacherMap = Object.fromEntries(((rawTeachers ?? []) as Profile[]).map(t => [t.id, t]))
  }

  const statusLabel: Record<string, string> = { draft: '草稿', analyzing: 'AI分析中', done: '已完成' }
  const statusColor: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-600',
    analyzing: 'bg-yellow-100 text-yellow-700',
    done: 'bg-green-100 text-green-700',
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">反思记录</h1>
        <div className="flex items-center gap-4">
          <a
            href="/api/admin/export-sessions"
            className="text-sm text-blue-600 hover:underline"
          >
            导出全部CSV
          </a>
          <p className="text-sm text-gray-500">
            共 {totalCount ?? sessions.length} 条
          </p>
        </div>
      </div>
      {(totalCount ?? 0) > sessions.length && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
          仅显示最近更新的 {sessions.length} 条，其余 {totalCount! - sessions.length} 条请使用导出功能查看全部数据。
        </p>
      )}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-3 font-medium text-gray-600">标题</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">教师</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">学科/年级</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">阶段</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sessions.map(s => {
              const profile = teacherMap[s.teacher_id]
              return (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900 max-w-xs truncate">{s.title}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <p>{profile?.name ?? '—'}</p>
                    <p className="text-xs text-gray-400">{profile?.school ?? '—'}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{[s.subject, s.grade].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{s.current_stage}/4</td>

                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${statusColor[s.status]}`}>
                      {statusLabel[s.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/admin/sessions/${s.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        查看详情
                      </Link>
                      <a
                        href={`/api/admin/export-session-word/${s.id}`}
                        className="text-gray-600 hover:text-gray-900 hover:underline"
                      >
                        导出Word
                      </a>
                      <DeleteSessionButton sessionId={s.id} title={s.title ?? ''} />
                    </div>

                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!sessions.length && <div className="text-center py-12 text-gray-400">暂无数据</div>}
      </div>
    </div>
  )
}
