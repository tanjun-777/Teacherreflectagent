import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// 创建用户（管理员）
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  // 验证管理员权限
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user?.id).single()
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { account, password, name, role, subject, grade, textbook_version } = body

  if (!account || !password) {
    return NextResponse.json({ error: '账户和密码必填' }, { status: 400 })
  }

  // 使用 service_role key 创建用户
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 })
  }

  const email = `${account.trim().toLowerCase()}@reflect.local`
  
  try {
    // 1. 创建 auth 用户
    const createRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: name || account, role: role || 'teacher' },
      }),
    })

    if (!createRes.ok) {
      const err = await createRes.json()
      return NextResponse.json({ error: err.message || '创建用户失败' }, { status: 400 })
    }

    const newUser = await createRes.json()

    // 2. 使用 service_role upsert profile（避免触发器时序导致字段为空）
    const profileRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/profiles?on_conflict=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify([{
        id: newUser.id,
        name: name || account,
        role: role || 'teacher',
        subject: subject || null,
        grade: grade || null,
        textbook_version: textbook_version || null,
      }]),
    })

    if (!profileRes.ok) {
      const detail = await profileRes.text()
      return NextResponse.json({ error: `用户已创建，但资料写入失败: ${detail}` }, { status: 500 })
    }

    return NextResponse.json({ success: true, user: newUser })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '创建失败' }, { status: 500 })
  }
}
