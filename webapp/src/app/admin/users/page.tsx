'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatDate } from '@/lib/utils'
import type { Profile } from '@/types'
import { Plus, Pencil, Trash2, X } from 'lucide-react'

// 高中所有学科
const SUBJECTS = [
  '语文', '数学', '英语', '物理', '化学', '生物',
  '政治', '历史', '地理', '信息技术', '通用技术', '音乐', '美术', '体育'
]

// 高中年级
const GRADES = ['高一', '高二', '高三']

// 教材版本（按学科）
const TEXTBOOK_VERSIONS: Record<string, string[]> = {
  '语文': ['人教版', '部编版', '苏教版', '语文版'],
  '数学': ['人教A版', '人教B版', '北师大版', '苏教版', '湘教版'],
  '英语': ['人教版', '外研版', '译林版', '北师大版', '沪教版'],
  '物理': ['人教版', '鲁科版', '粤教版', '沪科版'],
  '化学': ['人教版', '鲁科版', '苏教版', '沪科版'],
  '生物': ['人教版', '浙科版', '苏教版', '沪科版'],
  '政治': ['人教版', '部编版'],
  '历史': ['人教版', '部编版', '岳麓版'],
  '地理': ['人教版', '湘教版', '鲁教版', '中图版'],
  '信息技术': ['人教版', '浙教版', '粤教版', '教科版'],
  '通用技术': ['人教版', '苏教版', '粤教版'],
  '音乐': ['人教版', '湘艺版', '花城版'],
  '美术': ['人教版', '湘美版', '岭南版'],
  '体育': ['人教版', '华师大版'],
}

interface UserFormData {
  id?: string
  account: string
  password: string
  name: string
  role: 'teacher' | 'admin'
  subject: string
  grade: string
  textbook_version: string
}

const emptyForm: UserFormData = {
  account: '',
  password: '',
  name: '',
  role: 'teacher',
  subject: '',
  grade: '',
  textbook_version: '',
}

export default function AdminUsersPage() {
  const supabase = createClient()
  const [users, setUsers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Profile | null>(null)
  const [form, setForm] = useState<UserFormData>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const loadUsers = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false })
    setUsers((data ?? []) as Profile[])
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setError('')
    setShowModal(true)
  }

  function openEdit(user: Profile) {
    setEditing(user)
    setForm({
      id: user.id,
      account: '', // 不显示/编辑账户名
      password: '', // 密码留空表示不修改
      name: user.name || '',
      role: (user.role as 'teacher' | 'admin') || 'teacher',
      subject: user.subject || '',
      grade: user.grade || '',
      textbook_version: user.textbook_version || '',
    })
    setError('')
    setShowModal(true)
  }

  async function handleSave() {
    setError('')
    if (!editing && !form.account) {
      setError('账户名必填')
      return
    }
    if (!editing && !form.password) {
      setError('密码必填')
      return
    }

    setSaving(true)
    try {
      if (editing) {
        // 更新
        const res = await fetch(`/api/admin/users/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name,
            role: form.role,
            subject: form.subject,
            grade: form.grade,
            textbook_version: form.textbook_version,
            password: form.password || undefined,
          }),
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || '更新失败')
        }
      } else {
        // 创建
        const res = await fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: form.account,
            password: form.password,
            name: form.name,
            role: form.role,
            subject: form.subject,
            grade: form.grade,
            textbook_version: form.textbook_version,
          }),
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || '创建失败')
        }
      }
      setShowModal(false)
      loadUsers()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(user: Profile) {
    if (!confirm(`确定删除用户 "${user.name || '未命名'}" 吗？此操作不可恢复。`)) return
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || '删除失败')
      }
      loadUsers()
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : '删除失败')
    }
  }

  // 学科变化时重置教材版本
  function handleSubjectChange(subject: string) {
    setForm(f => ({
      ...f,
      subject,
      textbook_version: '',
    }))
  }

  const textbookOptions = form.subject ? TEXTBOOK_VERSIONS[form.subject] || [] : []

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">用户管理</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> 新增用户
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-3 font-medium text-gray-600">姓名</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">角色</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">学科</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">年级</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">教材版本</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">注册时间</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{u.name ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${u.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                    {u.role === 'admin' ? '管理员' : '教师'}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">{u.subject ?? '—'}</td>
                <td className="px-4 py-3 text-gray-600">{u.grade ?? '—'}</td>
                <td className="px-4 py-3 text-gray-600">{u.textbook_version ?? '—'}</td>
                <td className="px-4 py-3 text-gray-400">{formatDate(u.created_at)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openEdit(u)}
                      className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                      title="编辑"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(u)}
                      className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!users.length && !loading && (
          <div className="text-center py-12 text-gray-400">暂无用户数据</div>
        )}
        {loading && <div className="text-center py-12 text-gray-400">加载中…</div>}
      </div>

      {/* 新增/编辑弹窗 */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">
                {editing ? '编辑用户' : '新增用户'}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {error && <p className="text-red-500 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

              {/* 账户名（仅新增时） */}
              {!editing && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">账户名 *</label>
                  <input
                    value={form.account}
                    onChange={e => setForm(f => ({ ...f, account: e.target.value }))}
                    placeholder="请输入账户名"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}

              {/* 密码 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  密码 {editing && <span className="text-gray-400 font-normal">（留空表示不修改）</span>}
                </label>
                <input
                  type="password"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={editing ? '不修改请留空' : '请输入密码'}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* 姓名 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">姓名</label>
                <input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="请输入姓名"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* 角色 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">角色</label>
                <select
                  value={form.role}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value as 'teacher' | 'admin' }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="teacher">教师</option>
                  <option value="admin">管理员</option>
                </select>
              </div>

              {/* 学科 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">学科</label>
                <select
                  value={form.subject}
                  onChange={e => handleSubjectChange(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">请选择学科</option>
                  {SUBJECTS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              {/* 年级 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">年级</label>
                <select
                  value={form.grade}
                  onChange={e => setForm(f => ({ ...f, grade: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">请选择年级</option>
                  {GRADES.map(g => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </div>

              {/* 教材版本 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">教材版本</label>
                <select
                  value={form.textbook_version}
                  onChange={e => setForm(f => ({ ...f, textbook_version: e.target.value }))}
                  disabled={!form.subject}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  <option value="">{form.subject ? '请选择教材版本' : '请先选择学科'}</option>
                  {textbookOptions.map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
