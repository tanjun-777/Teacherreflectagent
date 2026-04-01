import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatDate } from '@/lib/utils'
import type { ReflectionSession, Profile } from '@/types'
import DeleteSessionButton from './DeleteSessionButton'


export default async function AdminSessionsPage() {
  const supabase = createClient()
  const { data: rawSessions } = await supabase
    .from('reflection_sessions')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(100)

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
        <p className="text-sm text-gray-500">支持按条导出 Word（含列表字段、反思详情与过程记录）</p>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-3 font-medium text-gray-600">标题</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">教师</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">学科/年级</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">阶段</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">更新时间</th>
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
                  <td className="px-4 py-3 text-gray-400">{formatDate(s.updated_at)}</td>
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
