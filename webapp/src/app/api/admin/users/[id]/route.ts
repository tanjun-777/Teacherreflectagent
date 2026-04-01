import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// 更新用户
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user?.id).single()
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { name, role, subject, grade, textbook_version, password } = body

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 })
  }

  // 更新 profile（使用 service_role，避免 RLS 限制）
  const updateData: Record<string, unknown> = {}
  if (name !== undefined) updateData.name = name
  if (role !== undefined) updateData.role = role
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
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user?.id).single()
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 不能删除自己
  if (user?.id === params.id) {
    return NextResponse.json({ error: '不能删除当前登录账户' }, { status: 400 })
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 })
  }

  // 删除 auth 用户（级联删除 profile）
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${params.id}`, {
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
