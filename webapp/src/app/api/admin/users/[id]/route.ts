import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 管理操作审计：删除用户等不可逆操作写入 admin_audit_logs（service_role 直写，需先执行迁移脚本建表）
async function writeAudit(supabaseUrl: string, serviceKey: string, entry: {
  admin_id: string; action: string; target_type: string; target_id: string; detail?: Record<string, unknown>
}) {
  await fetch(`${supabaseUrl}/rest/v1/admin_audit_logs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
           apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(entry),
  }).catch(() => undefined) // 审计失败不阻断主流程，但会被 catch 吞掉——可接受
}

// 更新用户
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user?.id).single()
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { name, role, school, subject, grade, textbook_version, password } = body

  // 角色白名单校验，防止写入任意字符串
  if (role !== undefined && !['teacher', 'admin'].includes(role)) {
    return NextResponse.json({ error: '角色只能是 teacher 或 admin' }, { status: 400 })
  }

  // 管理员不能修改自己的角色，避免误操作导致失去管理端权限
  if (role !== undefined && user?.id === params.id && role !== 'admin') {
    return NextResponse.json({ error: '不能修改自己的管理员角色' }, { status: 400 })
  }

  if (password !== undefined && password !== '' && String(password).length < 6) {
    return NextResponse.json({ error: '密码至少需要 6 位' }, { status: 400 })
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 })
  }

  // 更新 profile（使用 service_role，避免 RLS 限制）
  const updateData: Record<string, unknown> = {}
  if (name !== undefined) updateData.name = name
  if (role !== undefined) updateData.role = role
  if (school !== undefined) updateData.school = school
  if (subject !== undefined) updateData.subject = subject
  if (grade !== undefined) updateData.grade = grade
  if (textbook_version !== undefined) updateData.textbook_version = textbook_version

  const profileRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/profiles?id=eq.${params.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(updateData),
  })

  if (!profileRes.ok) {
    return NextResponse.json({ error: `更新资料失败: ${await profileRes.text()}` }, { status: 500 })
  }

  // 如果提供了密码，更新 auth 密码
  if (password) {
    const passRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${params.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ password }),
    })

    if (!passRes.ok) {
      return NextResponse.json({ error: `资料已更新，但密码更新失败: ${await passRes.text()}` }, { status: 500 })
    }
  }

  return NextResponse.json({ success: true })
}

// 删除用户
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 不能删除自己
  if (user.id === params.id) {
    return NextResponse.json({ error: '不能删除当前登录账户' }, { status: 400 })
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceKey || !supabaseUrl) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 })
  }

  // 防止删除最后一个管理员导致管理端失守（被删对象是管理员时）
  const { data: victim } = await supabase.from('profiles').select('name, role, school').eq('id', params.id).maybeSingle()
  if (victim?.role === 'admin') {
    const { count } = await supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin')
    if ((count ?? 0) <= 1) {
      return NextResponse.json({ error: '系统仅剩一个管理员账户，不能删除' }, { status: 400 })
    }
  }

  // 删除前记录审计日志（含被删用户摘要，便于事后追溯）
  await writeAudit(supabaseUrl, serviceKey, {
    admin_id: user.id,
    action: 'delete_user',
    target_type: 'user',
    target_id: params.id,
    detail: { profile: victim ?? null },
  })

  // 删除 auth 用户（级联删除 profile 及其全部反思数据）
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${params.id}`, {
    method: 'DELETE',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
  })

  if (!res.ok && res.status !== 404) {
    return NextResponse.json({ error: '删除失败' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
