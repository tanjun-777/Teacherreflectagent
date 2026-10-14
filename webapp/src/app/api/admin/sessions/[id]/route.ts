import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 })
  }

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

  // 删除前取会话摘要用于审计（不存在则 404，与删除语义一致）
  const { data: session } = await supabase
    .from('reflection_sessions')
    .select('id, title, teacher_id, status, current_stage')
    .eq('id', params.id)
    .maybeSingle()
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    // 数据库对 problems/causes/measures/reflection_reports/session_operation_logs
    // 均配置了 on delete cascade，删除主表即为原子操作，避免此前逐表删除的非事务问题
    const deleteSessionRes = await fetch(`${supabaseUrl}/rest/v1/reflection_sessions?id=eq.${params.id}`, {
      method: 'DELETE',
      headers,
    })

    if (!deleteSessionRes.ok) {
      throw new Error(await deleteSessionRes.text())
    }

    // 审计：记录谁在何时删除了哪个会话（含摘要，事后可追溯）
    await fetch(`${supabaseUrl}/rest/v1/admin_audit_logs`, {
      method: 'POST',
      headers: {
        ...headers,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        admin_id: user.id,
        action: 'delete_session',
        target_type: 'reflection_session',
        target_id: params.id,
        detail: { title: session.title, teacher_id: session.teacher_id, status: session.status },
      }),
    }).catch(() => undefined)

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 500 }
    )
  }
}
