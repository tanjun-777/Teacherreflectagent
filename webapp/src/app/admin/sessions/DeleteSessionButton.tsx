'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  sessionId: string
  title: string
}

export default function DeleteSessionButton({ sessionId, title }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleDelete() {
    if (loading) return
    if (!confirm(`确定删除反思记录“${title || '未命名'}”吗？此操作不可恢复。`)) return

    setLoading(true)
    try {
      const res = await fetch(`/api/admin/sessions/${sessionId}`, { method: 'DELETE' })
      const payload = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) {
        throw new Error(payload?.error ?? '删除失败')
      }
      router.refresh()
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : '删除失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={loading}
      className="text-red-600 hover:text-red-700 hover:underline disabled:opacity-50"
    >
      {loading ? '删除中…' : '删除'}
    </button>
  )
}
