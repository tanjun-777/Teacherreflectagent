'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/admin', label: '数据概览' },
  { href: '/admin/users', label: '用户管理' },
  { href: '/admin/sessions', label: '反思记录' },
]

export default function AdminSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="w-48 shrink-0 bg-white border-r border-gray-200 flex flex-col">
      <div className="px-4 py-4 border-b border-gray-100">
        <p className="font-semibold text-gray-900 text-sm">管理员后台</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'block px-3 py-2 rounded-lg text-sm transition-colors',
              pathname === item.href || (item.href !== '/admin' && pathname.startsWith(item.href))
                ? 'bg-blue-50 text-blue-700 font-medium'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-gray-100">
        <button
          onClick={signOut}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors w-full"
        >
          <LogOut className="w-4 h-4" />
          退出登录
        </button>
      </div>
    </aside>
  )
}
