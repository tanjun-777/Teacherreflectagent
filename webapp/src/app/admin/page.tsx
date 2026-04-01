import { createClient } from '@/lib/supabase/server'

export default async function AdminDashboardPage() {
  const supabase = createClient()

  const [{ count: userCount }, { count: sessionCount }, { count: doneCount }] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('reflection_sessions').select('*', { count: 'exact', head: true }),
    supabase.from('reflection_sessions').select('*', { count: 'exact', head: true }).eq('status', 'done'),
  ])

  const stats = [
    { label: '注册教师', value: userCount ?? 0, color: 'text-blue-600' },
    { label: '反思总数', value: sessionCount ?? 0, color: 'text-green-600' },
    { label: '已完成', value: doneCount ?? 0, color: 'text-purple-600' },
    { label: '完成率', value: sessionCount ? `${Math.round((doneCount ?? 0) / sessionCount * 100)}%` : '—', color: 'text-orange-600' },
  ]

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">数据概览</h1>
      <div className="grid grid-cols-4 gap-4 mb-8">
        {stats.map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-sm text-gray-500">{s.label}</p>
            <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
