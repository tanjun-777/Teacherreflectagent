'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

// 账户名 → 内部邮箱映射（Supabase Auth 需要邮箱格式）
function accountToEmail(account: string) {
  return `${account.trim().toLowerCase()}@reflect.local`
}

export default function LoginPage() {
  const router = useRouter()
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const email = accountToEmail(account)
      const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error

      // 获取角色并跳转
      const user = signInData.user
      if (user) {
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
        if (profile?.role === 'admin') {
          router.push('/admin')
        } else {
          router.push('/dashboard')
        }
      } else {
        router.push('/dashboard')
      }
    } catch (err: unknown) {
      setError('账户或密码错误，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">教师教学反思系统</h1>
          <p className="text-gray-500 mt-1 text-sm">AI 辅助教学成长平台</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">账户</label>
            <input
              type="text"
              required
              value={account}
              onChange={e => setAccount(e.target.value)}
              placeholder="请输入账户名"
              autoComplete="username"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors"
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}
