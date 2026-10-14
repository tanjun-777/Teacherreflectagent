'use client'
import { useState, useEffect, useMemo } from 'react'

import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import type { Profile } from '@/types'

// 高中所有学科
const SUBJECTS = [
  '语文', '数学', '英语', '物理', '化学', '生物',
  '历史', '地理', '政治（思想政治）', '信息技术', '通用技术',
  '音乐', '美术', '体育与健康', '心理健康',
]

// 高中年级
const GRADES = ['高一', '高二', '高三']

// 各学科对应教材版本
const TEXTBOOK_VERSIONS: Record<string, string[]> = {
  '语文': ['人教版（必修）', '人教版（选择性必修）', '苏教版', '北师大版'],
  '数学': ['人教A版', '人教B版', '北师大版', '湘教版', '苏教版'],
  '英语': ['人教版（PEP）', '外研版', '北师大版', '牛津译林版', '冀教版'],
  '物理': ['人教版', '粤教版', '教科版', '沪科版'],
  '化学': ['人教版', '苏教版', '鲁科版'],
  '生物': ['人教版（2019）', '苏教版', '北师大版'],
  '历史': ['人教版（中外历史纲要）', '岳麓版', '北师大版'],
  '地理': ['人教版', '湘教版', '中图版', '鲁教版'],
  '政治（思想政治）': ['人教版（2019）', '北师大版'],
  '信息技术': ['人教版（2019）', '粤教版', '中图版'],
  '通用技术': ['苏教版', '粤教版', '教科版'],
  '音乐': ['人教版', '湘艺版'],
  '美术': ['人教版', '湘美版'],
  '体育与健康': ['人教版', '粤教版'],
  '心理健康': ['人教版', '北师大版'],
}

export default function ProfilePage() {
  const supabase = useMemo(() => createClient(), [])

  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [form, setForm] = useState({
    name: '',
    school: '',
    subject: '',
    grade: '',
    textbook_version: '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  // 加载完成前禁用表单，防止异步 load() 返回时整体覆盖用户刚做的选择（如学科联动被冲掉）
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (data) {
        setProfile(data)
        setForm({
          name: data.name ?? '',
          school: data.school ?? '',
          subject: data.subject ?? '',
          grade: data.grade ?? '',
          textbook_version: (data as Record<string, unknown>).textbook_version as string ?? '',
        })
      }
      setLoading(false)
    }
    load()
  }, [router, supabase])


  // 切换学科时清空教材版本
  function handleSubjectChange(subject: string) {
    setForm(f => ({ ...f, subject, textbook_version: '' }))
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { error } = await supabase.from('profiles').update(form).eq('id', user.id)
    if (error) setError(error.message)
    else { setSaved(true); setTimeout(() => setSaved(false), 2000) }
    setSaving(false)
  }

  const versionOptions = form.subject ? (TEXTBOOK_VERSIONS[form.subject] ?? []) : []

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">个人信息</h1>
      <form onSubmit={handleSave} className="bg-white rounded-xl border border-gray-200 p-6">
        <fieldset disabled={loading} className="space-y-4">

        {/* 姓名 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">姓名</label>
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="请输入真实姓名"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* 学校 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">所属学校</label>
          <input
            value={form.school}
            onChange={e => setForm(f => ({ ...f, school: e.target.value }))}
            placeholder="请输入学校名称"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* 任教学科 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">任教学科</label>
          <select
            value={form.subject}
            onChange={e => handleSubjectChange(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="">请选择学科</option>
            {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* 任教年级 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">任教年级</label>
          <select
            value={form.grade}
            onChange={e => setForm(f => ({ ...f, grade: e.target.value }))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="">请选择年级</option>
            {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>

        {/* 教材版本 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">所授教材版本</label>
          <select
            value={form.textbook_version}
            onChange={e => setForm(f => ({ ...f, textbook_version: e.target.value }))}
            disabled={!form.subject}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white disabled:bg-gray-50 disabled:text-gray-400"
          >
            <option value="">{form.subject ? '请选择教材版本' : '请先选择学科'}</option>
            {versionOptions.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        {error && <p className="text-red-500 text-sm">{error}</p>}
        {saved && <p className="text-green-600 text-sm">已保存</p>}

        <div className="flex justify-end">
          <button type="submit" disabled={saving}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            {loading ? '加载中…' : saving ? '保存中…' : '保存'}
          </button>
        </div>
        </fieldset>
      </form>

      {profile && (
        <div className="mt-4 bg-gray-50 rounded-xl border border-gray-200 p-4">
          <p className="text-sm text-gray-500">角色：<span className="font-medium text-gray-700">{profile.role === 'admin' ? '管理员' : '教师'}</span></p>
        </div>
      )}
    </div>
  )
}
