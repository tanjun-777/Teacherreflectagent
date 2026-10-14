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
  const { account, password, name, role, school, subject, grade, textbook_version } = body

  if (!account || !password) {
    return NextResponse.json({ error: '账户和密码必填' }, { status: 400 })
  }

  // 账户名将拼接为 `${account}@reflect.local` 邮箱，必须为合法邮箱前缀（不含 @ 等）
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(String(account).trim())) {
    return NextResponse.json({ error: '账户名需为 3-32 位字母、数字或 . _ - 组合（不含中文、空格和 @）' }, { status: 400 })
  }

  if (String(password).length < 6) {
    return NextResponse.json({ error: '密码至少需要 6 位' }, { status: 400 })
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
      const err = await createRes.json().catch(() => ({} as { code?: string; msg?: string; message?: string }))
      // Supabase 重复注册返回英文提示，转为中文便于管理员理解
      const msg = String(err.msg ?? err.message ?? '')
      if (err.code === 'email_exists' || /already (exists|registered)/i.test(msg)) {
        return NextResponse.json({ error: `账户名 "${account.trim()}" 已存在，请更换` }, { status: 400 })
      }
      if (/valid email/i.test(msg)) {
        return NextResponse.json({ error: '账户名格式不合法，请更换' }, { status: 400 })
      }
      return NextResponse.json({ error: msg || '创建用户失败' }, { status: 400 })
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
        school: school || null,
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
