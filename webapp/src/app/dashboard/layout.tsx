import type { ReactNode } from 'react'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  // 管理员重定向到管理后台
  if (profile?.role === 'admin') redirect('/admin')

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar profile={profile} />
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}
