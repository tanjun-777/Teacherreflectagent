import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceKey || !supabaseUrl) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 })
  }

  const headers = {
    'Content-Type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  }

  const deleteBySession = async (table: string) => {
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?session_id=eq.${params.id}`, {
      method: 'DELETE',
      headers,
    })
    if (!res.ok) {
      throw new Error(await res.text())
    }
  }

  try {
    await deleteBySession('problems')
    await deleteBySession('causes')
    await deleteBySession('measures')
    await deleteBySession('reflection_reports')

    const deleteSessionRes = await fetch(`${supabaseUrl}/rest/v1/reflection_sessions?id=eq.${params.id}`, {
      method: 'DELETE',
      headers,
    })

    if (!deleteSessionRes.ok) {
      throw new Error(await deleteSessionRes.text())
    }

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 500 }
    )
  }
}
