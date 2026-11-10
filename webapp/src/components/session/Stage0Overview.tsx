'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ReflectionSession } from '@/types'
import { formatDate } from '@/lib/utils'
import { updateDraftSnapshotFields } from '@/lib/session-audit'
import { parseOwnedStoragePath } from '@/lib/storage-path'

// 学生表现 / 学习结果模块保存的已确认图片引用（仅数据概览回看原图，不参与 AI 分析）
type ImageRef = { name: string; url: string }

interface Props {
  session: ReflectionSession
  onAnalyze: () => void
  loading: boolean
  error: string
  statusMsg: string
  onSessionRefresh: () => Promise<unknown>
}

type PreviewData = {
  title: string
  text?: string | null
  audioUrl?: string | null
  /** 私有桶下播放用的签名地址（打开预览时生成，1 小时有效） */
  audioSrc?: string | null
}

type EditData = {
  field: string
  label: string
  value: string
}

type AudioKind = 'class' | 'self' | 'peer'

type AudioTarget = {
  kind: AudioKind
  label: string
  urlField: 'audio_url'
  snapshotKey?: never
  targetField: 'audio_transcript'
} | {
  kind: AudioKind
  label: string
  urlField?: never
  snapshotKey: 'self_review_audio_url' | 'peer_review_audio_url'
  targetField: 'self_review' | 'peer_review'
}

const AUDIO_TARGETS: Record<AudioKind, AudioTarget> = {
  class: { kind: 'class', label: '课堂', urlField: 'audio_url', targetField: 'audio_transcript' },
  self: { kind: 'self', label: '教师自评', snapshotKey: 'self_review_audio_url', targetField: 'self_review' },
  peer: { kind: 'peer', label: '同伴评价', snapshotKey: 'peer_review_audio_url', targetField: 'peer_review' },
}

export default function Stage0Overview({ session, onAnalyze, loading, error, statusMsg, onSessionRefresh }: Props) {
  const supabase = createClient()
  const snapshot = (session.draft_snapshot ?? {}) as {
    self_review_audio_url?: string
    peer_review_audio_url?: string
    student_performance_images?: ImageRef[] | null
    learning_outcomes_images?: ImageRef[] | null
  }
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [editing, setEditing] = useState<EditData | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [uploadKind, setUploadKind] = useState<AudioKind | null>(null)
  const [actionMsg, setActionMsg] = useState('')
  const [imageViewer, setImageViewer] = useState<{ name: string; src: string } | null>(null)
  // 私有桶图片的签名地址（key 为原始 URL，1 小时有效）
  const [signedImageSrcs, setSignedImageSrcs] = useState<Record<string, string>>({})

  const perfImages = snapshot.student_performance_images ?? []
  const outcomeImages = snapshot.learning_outcomes_images ?? []

  useEffect(() => {
    const urls = [...perfImages, ...outcomeImages].map(im => im.url)
    if (urls.length === 0) return
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(urls.map(async u => [u, await signedFileSrc(u)] as const))
      if (!cancelled) setSignedImageSrcs(Object.fromEntries(entries))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.draft_snapshot])

  const hasData = session.teaching_design || session.self_review || session.peer_review || session.audio_url || session.audio_transcript
    || session.student_performance || session.learning_outcomes || session.external_feedback
    || snapshot.self_review_audio_url || snapshot.peer_review_audio_url

  const selfAudioPending = !!snapshot.self_review_audio_url && !session.self_review
  const peerAudioPending = !!snapshot.peer_review_audio_url && !session.peer_review

  const items: Array<{ label: string; icon: string; field: string; value: string | null; audioPending?: boolean; audioUrl?: string | null; audioKind?: AudioKind; images?: ImageRef[] }> = [
    { label: '教学设计', icon: '📄', field: 'teaching_design', value: session.teaching_design },
    { label: '教师自评', icon: '✍️', field: 'self_review', value: session.self_review, audioPending: selfAudioPending, audioUrl: snapshot.self_review_audio_url ?? null, audioKind: 'self' },
    { label: '学生表现', icon: '🧑‍🎓', field: 'student_performance', value: session.student_performance, images: perfImages.length > 0 ? perfImages : undefined },
    { label: '学习结果', icon: '📊', field: 'learning_outcomes', value: session.learning_outcomes, images: outcomeImages.length > 0 ? outcomeImages : undefined },
    { label: '多主体同伴反馈', icon: '👥', field: 'peer_review', value: session.peer_review, audioPending: peerAudioPending, audioUrl: snapshot.peer_review_audio_url ?? null, audioKind: 'peer' },
    { label: '外部智慧教研系统反馈', icon: '🖥️', field: 'external_feedback', value: session.external_feedback },
  ]

  const classAudioUrl = session.audio_url ?? null
  const classRecordText = session.audio_transcript ?? null

  async function saveEdit() {
    if (!editing) return
    setSaving(true)
    setEditError('')
    const { error: updateError } = await supabase
      .from('reflection_sessions')
      .update({ [editing.field]: editing.value.trim() || null })
      .eq('id', session.id)
    setSaving(false)
    if (updateError) {
      setEditError(`保存失败：${updateError.message}`)
      return
    }
    setEditing(null)
    setActionMsg('资料已更新。后续环节可基于新资料重新提取问题或生成归因与措施。')
    await onSessionRefresh()
  }

  // 存储桶为私有：访问前把本站文件 URL（录音/图片等）换为 1 小时签名 URL（RLS 允许读取自己上传的文件）
  async function signedFileSrc(rawUrl: string): Promise<string> {
    try {
      const parsed = parseOwnedStoragePath(rawUrl)
      if (!parsed) return rawUrl
      const { data, error } = await supabase.storage.from(parsed.bucket).createSignedUrl(parsed.path, 3600)
      if (error || !data?.signedUrl) return rawUrl
      return data.signedUrl
    } catch {
      return rawUrl
    }
  }

  async function openPreview(title: string, text?: string | null, audioUrl?: string | null) {
    const audioSrc = audioUrl ? await signedFileSrc(audioUrl) : null
    setPreview({ title, text, audioUrl, audioSrc })
  }

  async function transcribe(audioUrl: string, targetField: 'audio_transcript' | 'self_review' | 'peer_review', label: string) {
    const res = await fetch('/api/asr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.id, audio_url: audioUrl, target_field: targetField }),
    })
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(payload?.error ?? `${label}录音转写失败`)
    }
  }

  async function handleAudioUpload(kind: AudioKind, file: File) {
    const target = AUDIO_TARGETS[kind]
    setUploadKind(kind)
    setActionMsg(`${target.label}录音上传中…`)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('登录状态失效，请重新登录后重试')

      const ext = file.name.split('.').pop()?.toLowerCase() || 'webm'
      const path = `${user.id}/${kind}_${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('audio-uploads').upload(path, file)
      if (upErr) throw new Error(`录音上传失败：${upErr.message}`)
      const { data: urlData } = supabase.storage.from('audio-uploads').getPublicUrl(path)
      const audioUrl = urlData.publicUrl

      if (target.urlField) {
        const { error: saveErr } = await supabase
          .from('reflection_sessions')
          .update({ [target.urlField]: audioUrl })
          .eq('id', session.id)
        if (saveErr) throw new Error(`保存录音地址失败：${saveErr.message}`)
      } else if (target.snapshotKey) {
        // 走串行队列读-改-写，避免与其他 draft_snapshot 写入并发互相覆盖
        try {
          await updateDraftSnapshotFields(supabase, session.id, snap => ({
            ...snap,
            [target.snapshotKey as string]: audioUrl,
          }))
        } catch (saveErr) {
          throw new Error(`保存录音地址失败：${saveErr instanceof Error ? saveErr.message : String(saveErr)}`)
        }
      }

      setActionMsg(`${target.label}录音已上传，正在转写…`)
      await transcribe(audioUrl, target.targetField, target.label)
      await onSessionRefresh()
      setActionMsg(`${target.label}录音已上传并完成转写。后续环节可基于新资料重新提取问题或生成归因与措施。`)
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : '录音上传失败')
    } finally {
      setUploadKind(null)
    }
  }

  function renderAudioUploadButton(kind: AudioKind) {
    const busy = uploadKind !== null
    const isThis = uploadKind === kind
    const label = AUDIO_TARGETS[kind].label
    return (
      <label
        className={`text-xs px-2.5 py-1 rounded-full border border-blue-200 text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors cursor-pointer shrink-0 ${busy ? 'opacity-40 pointer-events-none' : ''}`}
        title={`上传${label}录音（支持常见音频格式），上传后自动转写`}
      >
        <input
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) void handleAudioUpload(kind, file)
            e.target.value = ''
          }}
        />
        {isThis ? '转写中…' : '🎙️ 上传录音'}
      </label>
    )
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-900">阶段1 ｜ 课堂教学数据与外部反馈结果的收集与整理</h2>
        <p className="text-gray-400 text-xs mt-1">
          点击「编辑」补充或更新资料文本，点击「上传录音」补传音频（自动转写）。资料更新后，可返回阶段2 重新提取问题、生成归因与措施；确认无误后点击「下一步」继续。
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4 mb-6">
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            ['标题', session.title],
            ['学科', session.subject],
            ['年级', session.grade],
            ['上课日期', formatDate(session.class_date)],
          ].filter(([, v]) => v).map(([k, v]) => (
            <div key={k as string}>
              <span className="text-gray-400">{k}：</span>
              <span className="text-gray-800 font-medium">{v}</span>
            </div>
          ))}
        </div>

        <hr className="border-gray-100" />

        <div className="space-y-3">
          {items.map(item => (
            <div key={item.label} className="flex items-start gap-3">
              <span className="text-lg shrink-0">{item.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-700">{item.label}</p>
                {item.value ? (
                  <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{item.value}</p>
                ) : item.audioPending ? (
                  <p className="text-xs text-amber-600 mt-0.5">录音待转写（将异步处理）</p>
                ) : (
                  <p className="text-xs text-gray-300 mt-0.5">未填写</p>
                )}
                {item.images && item.images.length > 0 && (
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">
                    {item.images.map((img, i) => {
                      const src = signedImageSrcs[img.url]
                      return (
                        <button
                          key={`${img.url}-${i}`}
                          type="button"
                          onClick={() => src && setImageViewer({ name: img.name, src })}
                          title={`查看原图：${img.name}`}
                          className="shrink-0"
                        >
                          {src ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={src} alt={img.name} className="w-14 h-14 object-cover rounded border border-gray-200 hover:opacity-80 transition-opacity" />
                          ) : (
                            <span className="w-14 h-14 rounded border border-gray-200 bg-gray-50 flex items-center justify-center text-[10px] text-gray-400">加载中</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => { setEditError(''); setEditing({ field: item.field, label: item.label, value: item.value ?? '' }) }}
                  className="text-xs px-2.5 py-1 rounded-full bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200 transition-colors"
                >
                  编辑
                </button>
                {item.audioKind && renderAudioUploadButton(item.audioKind)}
                {(item.value || item.audioUrl) && (
                  <button
                    onClick={() => void openPreview(item.label, item.value, item.audioUrl)}
                    className="text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                  >
                    预览
                  </button>
                )}
                <span className={`text-xs px-2.5 py-1 rounded-full ${
                  item.value
                    ? 'bg-green-100 text-green-700'
                    : item.audioPending
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-gray-100 text-gray-400'
                }`}>
                  {item.value ? '已填写' : item.audioPending ? '录音' : '缺失'}
                </span>
              </div>
            </div>
          ))}

          <div className="flex items-start gap-3">
            <span className="text-lg shrink-0">🎙️</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-700">课堂教学实录</p>
              {session.audio_url ? (
                <p className="text-xs text-blue-600 mt-0.5">已上传{session.audio_transcript ? '（已转写）' : '（将异步转写）'}</p>
              ) : classRecordText ? (
                <p className="text-xs text-blue-600 mt-0.5">已上传文本版记录</p>
              ) : (
                <p className="text-xs text-gray-300 mt-0.5">未上传</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => { setEditError(''); setEditing({ field: 'audio_transcript', label: '课堂教学实录文本', value: classRecordText ?? '' }) }}
                className="text-xs px-2 py-0.5 rounded-full bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200 transition-colors"
              >
                编辑
              </button>
              {renderAudioUploadButton('class')}
              {(classAudioUrl || classRecordText) && (
                <button
                  onClick={() => void openPreview('课堂教学实录', classRecordText, classAudioUrl)}
                  className="text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                >
                  预览
                </button>
              )}
              <span className={`text-xs px-2.5 py-1 rounded-full shrink-0 ${(session.audio_url || session.audio_transcript) ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
                {(session.audio_url || session.audio_transcript) ? '已上传' : '缺失'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {!hasData && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6 text-sm text-yellow-800">
          ⚠️ 建议至少填写一项数据（教学设计、课堂教学实录、自评、学生表现、学习结果或外部反馈）以获得更准确的 AI 分析。
        </div>
      )}

      {actionMsg && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-6 text-sm text-blue-800 flex items-start justify-between gap-3">
          <span>{actionMsg}</span>
          {!uploadKind && (
            <button onClick={() => setActionMsg('')} className="text-blue-400 hover:text-blue-600 shrink-0" aria-label="关闭提示">×</button>
          )}
        </div>
      )}

      {statusMsg && <p className="text-sm text-blue-600 mb-4 flex items-center gap-2"><span className="animate-spin inline-block">⏳</span>{statusMsg}</p>}
      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      <button
        onClick={onAnalyze}
        disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
      >
        {loading ? (
          <><span className="animate-spin">⏳</span> {statusMsg || '处理中，请稍候…'}</>
        ) : (
          <>下一步 →</>
        )}
      </button>

      {/* 资料编辑弹窗 */}
      {editing && (() => {
        // 学生表现 / 学习结果编辑时附带原图缩略图，供对照矫正识别文本（可选操作，非强制）
        const editingImages = editing.field === 'student_performance' ? perfImages
          : editing.field === 'learning_outcomes' ? outcomeImages
          : []
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => !saving && setEditing(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
              <h3 className="font-semibold text-gray-900">编辑 · {editing.label}</h3>
              <button
                onClick={() => !saving && setEditing(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
                aria-label="关闭编辑"
              >
                ×
              </button>
            </div>
            <div className="px-5 py-4 overflow-y-auto flex-1">
              {editingImages.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-medium text-gray-500 mb-1.5">🖼️ 原图参考（点击放大，可对照矫正识别文本，非必须）</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {editingImages.map((img, i) => {
                      const src = signedImageSrcs[img.url]
                      return (
                        <button
                          key={`${img.url}-${i}`}
                          type="button"
                          onClick={() => src && setImageViewer({ name: img.name, src })}
                          title={`查看原图：${img.name}`}
                          className="shrink-0"
                        >
                          {src ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={src} alt={img.name} className="w-14 h-14 object-cover rounded border border-gray-200 hover:opacity-80 transition-opacity" />
                          ) : (
                            <span className="w-14 h-14 rounded border border-gray-200 bg-gray-50 flex items-center justify-center text-[10px] text-gray-400">加载中</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              <textarea
                value={editing.value}
                onChange={e => setEditing({ ...editing, value: e.target.value })}
                rows={14}
                placeholder={`在此输入或粘贴${editing.label}内容…`}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              />
              {editError && <p className="text-sm text-red-500 mt-2">{editError}</p>}
            </div>
            <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-3 shrink-0">
              <button
                onClick={() => !saving && setEditing(null)}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => void saveEdit()}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
        )
      })()}

      {/* 资料预览弹窗 */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
              <h3 className="font-semibold text-gray-900">{preview.title}</h3>
              <button
                onClick={() => setPreview(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
                aria-label="关闭预览"
              >
                ×
              </button>
            </div>
            <div className="px-5 py-4 overflow-y-auto space-y-4">
              {preview.audioUrl && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1.5">🎙️ 录音播放</p>
                  <audio controls src={preview.audioSrc ?? preview.audioUrl ?? undefined} className="w-full h-10" />
                </div>
              )}
              <div>
                {preview.audioUrl && <p className="text-xs font-medium text-gray-500 mb-1.5">📝 文本内容</p>}
                {preview.text ? (
                  <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{preview.text}</p>
                ) : (
                  <p className="text-sm text-amber-600">录音待转写，文本内容将在异步转写完成后显示</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 原图查看弹窗 */}
      {imageViewer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setImageViewer(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 shrink-0">
              <h3 className="font-semibold text-gray-900 truncate" title={imageViewer.name}>{imageViewer.name}</h3>
              <button
                onClick={() => setImageViewer(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
                aria-label="关闭原图"
              >
                ×
              </button>
            </div>
            <div className="px-5 py-4 overflow-auto flex-1 flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageViewer.src} alt={imageViewer.name} className="max-w-full max-h-[60vh] object-contain rounded" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
