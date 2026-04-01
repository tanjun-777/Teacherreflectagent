import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { ReflectionSession, Profile } from '@/types'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: rawProfile } = await supabase.from('profiles').select('*').eq('id', user.id).single()
  const adminProfile = rawProfile as Profile | null
  if (adminProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: rawSessions } = await supabase
    .from('reflection_sessions')
    .select('*')
    .order('updated_at', { ascending: false })

  const sessions = (rawSessions ?? []) as ReflectionSession[]

  const teacherIds = [...new Set(sessions.map(s => s.teacher_id))]
  let teacherMap: Record<string, Profile> = {}
  if (teacherIds.length) {
    const { data: rawTeachers } = await supabase.from('profiles').select('*').in('id', teacherIds)
    teacherMap = Object.fromEntries(((rawTeachers ?? []) as Profile[]).map(t => [t.id, t]))
  }

  const statusLabel: Record<string, string> = { draft: '草稿', analyzing: 'AI分析中', done: '已完成' }
  const csvEscape = (value: unknown) => {
    const text = String(value ?? '')
    return `"${text.replace(/"/g, '""')}"`
  }

  const csvRows = [
    ['ID', '标题', '教师', '学校', '学科', '年级', '上课日期', '阶段', '状态', '创建时间', '更新时间']
      .map(csvEscape)
      .join(','),
    ...sessions.map(s => {
      const profile = teacherMap[s.teacher_id]
      return [
        s.id,
        s.title,
        profile?.name,
        profile?.school,
        s.subject,
        s.grade,
        s.class_date,
        `${s.current_stage}/4`,
        statusLabel[s.status] ?? s.status,
        s.created_at,
        s.updated_at,
      ]
        .map(csvEscape)
        .join(',')
    }),
  ]

  const csv = `\uFEFF${csvRows.join('\r\n')}`

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sessions-${Date.now()}.csv"`,
    },
  })
}
