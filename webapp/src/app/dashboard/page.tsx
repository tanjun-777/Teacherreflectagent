import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { formatDate } from '@/lib/utils'

type RepeatedHint = {
  type: '问题' | '归因' | '措施'
  text: string
  count: number
}

function normalizeText(text: string | null | undefined) {
  return (text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、“”‘’（）()【】\[\]—\-.,!?;:'"`~]/g, '')
}

function buildHints<T extends { session_id: string; description: string }>(
  items: T[],
  type: RepeatedHint['type']
) {
  const phraseToSessions = new Map<string, Set<string>>()
  const phraseToRaw = new Map<string, string>()

  items.forEach(item => {
    const key = normalizeText(item.description)
    if (!key) return
    if (!phraseToSessions.has(key)) phraseToSessions.set(key, new Set<string>())
    phraseToSessions.get(key)!.add(item.session_id)
    if (!phraseToRaw.has(key)) phraseToRaw.set(key, item.description)
  })

  return Array.from(phraseToSessions.entries())
    .map(([key, sessions]) => ({
      type,
      text: phraseToRaw.get(key) ?? '',
      count: sessions.size,
    }))
    .filter(x => x.count >= 3)
}

export default async function DashboardPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: sessions } = await supabase
    .from('reflection_sessions')
    .select('id, title, class_date, subject, current_stage, status, updated_at')
    .eq('teacher_id', user!.id)
    .order('updated_at', { ascending: false })
    .limit(20)

  const { data: doneSessions } = await supabase
    .from('reflection_sessions')
    .select('id')
    .eq('teacher_id', user!.id)
    .eq('status', 'done')

  const doneIds = (doneSessions ?? []).map(s => s.id)

  let repeatedHints: RepeatedHint[] = []
  if (doneIds.length > 0) {
    const [{ data: problems }, { data: causes }, { data: measures }] = await Promise.all([
      supabase.from('problems').select('session_id, description').eq('confirmed', true).in('session_id', doneIds),
      supabase.from('causes').select('session_id, description').eq('confirmed', true).in('session_id', doneIds),
      supabase.from('measures').select('session_id, description').eq('confirmed', true).in('session_id', doneIds),
    ])

    repeatedHints = [
      ...buildHints(problems ?? [], '问题'),
      ...buildHints(causes ?? [], '归因'),
      ...buildHints(measures ?? [], '措施'),
    ]
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
  }

  const stageLabel = ['数据录入', '问题识别', '归因分析', '改进措施', '撰写报告']
  const statusColor = { draft: 'bg-gray-100 text-gray-600', analyzing: 'bg-yellow-100 text-yellow-700', done: 'bg-green-100 text-green-700' }
  const statusLabel = { draft: '草稿', analyzing: 'AI 分析中', done: '已完成' }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">我的反思记录</h1>
          <p className="text-gray-500 text-sm mt-1">共 {sessions?.length ?? 0} 条记录</p>
        </div>
        <Link
          href="/dashboard/sessions/new"
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          <span>+</span> 新建反思
        </Link>
      </div>

      {repeatedHints.length > 0 && (
        <div className="mb-5 bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-amber-800 mb-2">重要提示：以下内容在历次反思中出现 3 次及以上，请重点整改</p>
          <div className="space-y-2">
            {repeatedHints.map((hint, idx) => (
              <p key={`${hint.type}-${idx}`} className="text-sm text-amber-700">
                [{hint.type}]（{hint.count}次）{hint.text}
              </p>
            ))}
          </div>
        </div>
      )}

      {!sessions?.length ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-5xl mb-4">📝</p>
          <p className="text-lg">还没有反思记录</p>
          <p className="text-sm mt-1">点击「新建反思」开始第一次教学反思</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {sessions.map(s => (
            <div
              key={s.id}
              className="bg-white rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all p-4 flex items-center gap-4"
            >
              <Link href={`/dashboard/sessions/${s.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-medium text-gray-900 truncate">{s.title}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${statusColor[s.status as keyof typeof statusColor]}`}>
                    {statusLabel[s.status as keyof typeof statusLabel]}
                  </span>
                </div>
                <p className="text-sm text-gray-500">
                  {s.subject && <span className="mr-2">{s.subject}</span>}
                  {s.class_date && <span>{formatDate(s.class_date)}</span>}
                </p>
              </Link>
              <div className="shrink-0 text-right">
                <p className="text-xs text-gray-400">阶段 {Math.min(s.current_stage, 4)}/4</p>
                {s.status !== 'done' && (
                  <p className="text-xs text-blue-600 font-medium">{stageLabel[Math.min(s.current_stage, 4)]}</p>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-4">
                {s.status === 'done' ? (
                  <a
                    href={`/api/dashboard/export-session-word/${s.id}`}
                    className="text-xs text-gray-600 hover:text-gray-900 hover:underline"
                  >
                    导出Word
                  </a>
                ) : (
                  <span className="text-xs text-gray-300 cursor-not-allowed">未完成不可导出</span>
                )}
                <Link href={`/dashboard/sessions/${s.id}`} className="text-gray-400 hover:text-blue-600">›</Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
