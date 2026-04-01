'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Profile } from '@/types'
import { cn } from '@/lib/utils'
import { BookOpen, LayoutDashboard, Settings, LogOut, ShieldCheck } from 'lucide-react'

const navItems = [
  { href: '/dashboard', label: '反思记录', icon: LayoutDashboard },
  { href: '/dashboard/profile', label: '个人信息', icon: Settings },
]

const adminItems = [
  { href: '/admin', label: '管理后台', icon: ShieldCheck },
]

export default function Sidebar({ profile }: { profile: Profile | null }) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const isAdmin = profile?.role === 'admin'

  return (
    <aside className="w-44 shrink-0 bg-white border-r border-gray-200 flex flex-col">
      <div className="px-4 py-5 border-b border-gray-100">

        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-blue-600" />
          <span className="font-semibold text-gray-900 text-sm">教学反思</span>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
              pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
                ? 'bg-blue-50 text-blue-700 font-medium'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
            )}
          >
            <item.icon className="w-4 h-4" />
            {item.label}
          </Link>
        ))}

        {isAdmin && (
          <>
            <div className="pt-3 pb-1">
              <p className="text-xs text-gray-400 px-3 uppercase tracking-wider">管理员</p>
            </div>
            {adminItems.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                  pathname.startsWith(item.href)
                    ? 'bg-blue-50 text-blue-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                )}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            ))}
          </>
        )}
      </nav>

      <div className="px-3 py-4 border-t border-gray-100">
        <div className="px-3 py-2 mb-1">
          <p className="text-sm font-medium text-gray-900 truncate">{profile?.name ?? '未设置姓名'}</p>
          <p className="text-xs text-gray-400 truncate">{profile?.school ?? '未设置学校'}</p>
        </div>
        <button
          onClick={signOut}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors w-full"
        >
          <LogOut className="w-4 h-4" />
          退出登录
        </button>
      </div>
    </aside>
  )
}
