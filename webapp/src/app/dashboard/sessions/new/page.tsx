'use client'
import { useState, useRef, useEffect, useMemo } from 'react'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// ─── 录音输入组件 ─────────────────────────────────────────────
type AudioInputMode = 'text' | 'record'

interface AudioTextFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  audioBlob: Blob | null
  onAudioBlob: (b: Blob | null) => void
}

function AudioTextField({ label, value, onChange, placeholder, audioBlob, onAudioBlob }: AudioTextFieldProps) {
  const [mode, setMode] = useState<AudioInputMode>('text')
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function startTimer() {
    setRecSeconds(0)
    timerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000)
  }
  function stopTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }

  async function startRecording() {
    chunksRef.current = []
    onAudioBlob(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      mediaRecorderRef.current = mr
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        onAudioBlob(blob)
        stream.getTracks().forEach(t => t.stop())
      }
      mr.start()
      setRecording(true)
      startTimer()
    } catch {
      alert('无法访问麦克风，请检查浏览器权限')
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop()
    setRecording(false)
    stopTimer()
  }

  function resetRecording() {
    if (recording) stopRecording()
    onAudioBlob(null)
    setRecSeconds(0)
  }

  useEffect(() => () => stopTimer(), [])

  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-gray-700">{label}</label>
        <div className="flex rounded-md overflow-hidden border border-gray-300 text-xs">
          {(['text', 'record'] as AudioInputMode[]).map(m => (
            <button
              key={m} type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1 transition-colors ${mode === m ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
            >
              {m === 'text' ? '文本' : '录音'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'text' ? (
        <textarea
          value={value} onChange={e => onChange(e.target.value)}
          rows={4} placeholder={placeholder}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />
      ) : (
        <div className="border border-gray-300 rounded-lg p-4 space-y-3 bg-gray-50">
          {/* 录音控制 */}
          <div className="flex items-center gap-3">
            {!recording && !audioBlob && (
              <button type="button" onClick={startRecording}
                className="flex items-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm rounded-lg transition-colors">
                <span className="w-2 h-2 rounded-full bg-white inline-block" /> 开始录音
              </button>
            )}
            {recording && (
              <>
                <span className="flex items-center gap-2 text-sm text-red-600 font-medium">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
                  录音中 {fmtTime(recSeconds)}
                </span>
                <button type="button" onClick={stopRecording}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white text-sm rounded-lg transition-colors">
                  录音结束
                </button>
              </>
            )}
            {!recording && audioBlob && (
              <div className="flex items-center gap-3 flex-1">
                <span className="text-sm text-green-700 font-medium flex items-center gap-1">
                  <span>✓</span> 已录制 {fmtTime(recSeconds)}
                </span>
                <button type="button" onClick={resetRecording}
                  className="px-3 py-1.5 border border-gray-300 text-sm rounded-lg hover:bg-gray-100 transition-colors">
                  重录
                </button>
              </div>
            )}
          </div>
          {/* 录音后可播放预览 */}
          {audioBlob && (
            <audio controls src={URL.createObjectURL(audioBlob)} className="w-full h-8" />
          )}
          <p className="text-xs text-gray-400">录音将在「保存并进入分析」时自动转换为文字</p>
        </div>
      )}
    </div>
  )
}

// ─── 课堂录音组件（选择文件 or 现场录音）────────────────────────
type ClassAudioMode = 'file' | 'record'

interface ClassAudioInputProps {
  file: File | null
  onFile: (f: File | null) => void
  blob: Blob | null
  onBlob: (b: Blob | null) => void
}

function ClassAudioInput({ file, onFile, blob, onBlob }: ClassAudioInputProps) {
  const [mode, setMode] = useState<ClassAudioMode>('file')
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function startTimer() {
    setRecSeconds(0)
    timerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000)
  }
  function stopTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }
  useEffect(() => () => stopTimer(), [])

  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  async function startRecording() {
    chunksRef.current = []
    onBlob(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      mediaRecorderRef.current = mr
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = () => {
        onBlob(new Blob(chunksRef.current, { type: 'audio/webm' }))
        stream.getTracks().forEach(t => t.stop())
      }
      mr.start()
      setRecording(true)
      startTimer()
    } catch {
      alert('无法访问麦克风，请检查浏览器权限')
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop()
    setRecording(false)
    stopTimer()
  }

  function resetRecording() {
    if (recording) stopRecording()
    onBlob(null)
    setRecSeconds(0)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="block text-sm font-medium text-gray-700">
          课堂录音
          <span className="text-gray-400 font-normal ml-2">（≤ 100 MB）</span>
        </label>
        <div className="flex rounded-md overflow-hidden border border-gray-300 text-xs">
          {(['file', 'record'] as ClassAudioMode[]).map(m => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={`px-3 py-1 transition-colors ${mode === m ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
              {m === 'file' ? '选择文件' : '现场录音'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'file' ? (
        <>
          <input ref={fileRef} type="file" accept="audio/*" className="hidden"
            onChange={e => onFile(e.target.files?.[0] ?? null)} />
          <button type="button" onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-4 py-3 text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors w-full justify-center">
            {file
              ? `已选择: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`
              : '点击选择音频文件（mp3 / m4a / wav）'}
          </button>
        </>
      ) : (
        <div className="border border-gray-300 rounded-lg p-4 space-y-3 bg-gray-50">
          <div className="flex items-center gap-3">
            {!recording && !blob && (
              <button type="button" onClick={startRecording}
                className="flex items-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm rounded-lg transition-colors">
                <span className="w-2 h-2 rounded-full bg-white inline-block" /> 开始录音
              </button>
            )}
            {recording && (
              <>
                <span className="flex items-center gap-2 text-sm text-red-600 font-medium">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
                  录音中 {fmtTime(recSeconds)}
                </span>
                <button type="button" onClick={stopRecording}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white text-sm rounded-lg transition-colors">
                  录音结束
                </button>
              </>
            )}
            {!recording && blob && (
              <div className="flex items-center gap-3 flex-1">
                <span className="text-sm text-green-700 font-medium flex items-center gap-1">
                  <span>✓</span> 已录制 {fmtTime(recSeconds)}
                </span>
                <button type="button" onClick={resetRecording}
                  className="px-3 py-1.5 border border-gray-300 text-sm rounded-lg hover:bg-gray-100 transition-colors">
                  重录
                </button>
              </div>
            )}
          </div>
          {blob && <audio controls src={URL.createObjectURL(blob)} className="w-full h-8" />}
          <p className="text-xs text-gray-400">录音将在「保存并进入分析」时自动转换为文字</p>
        </div>
      )}
    </div>
  )
}

// ─── 主页面 ─────────────────────────────────────────────────────
export default function NewSessionPage() {
  const supabase = useMemo(() => createClient(), [])

  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const docRef = useRef<HTMLInputElement>(null)
  const [docFile, setDocFile] = useState<File | null>(null)
  const [classAudioFile, setClassAudioFile] = useState<File | null>(null)
  const [classAudioBlob, setClassAudioBlob] = useState<Blob | null>(null)

  // 录音 blob（自评 / 同伴评价）
  const [selfReviewBlob, setSelfReviewBlob] = useState<Blob | null>(null)
  const [peerReviewBlob, setPeerReviewBlob] = useState<Blob | null>(null)

  const [form, setForm] = useState({
    title: '',
    class_date: '',
    subject: '',
    grade: '',
    teaching_design: '',
    self_review: '',
    peer_review: '',
  })

  // 从 profile 自动填入学科和年级
  useEffect(() => {
    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase.from('profiles').select('subject, grade').eq('id', user.id).single()
      if (data) {
        setForm(f => ({
          ...f,
          subject: data.subject ?? '',
          grade: data.grade ?? '',
        }))
      }
    }
    loadProfile()
  }, [supabase])


  function setField(k: string, v: string) {
    setForm(f => ({ ...f, [k]: v }))
  }

  function getStorageUploadErrorMessage(err: unknown, bucket: 'audio-uploads' | 'doc-uploads') {
    const raw = err instanceof Error ? err.message : String(err ?? '')
    const bucketLabel = bucket === 'doc-uploads' ? '教学设计文档' : '音频文件'

    if (/Bucket not found/i.test(raw)) {
      return `${bucketLabel}上传失败：存储桶 ${bucket} 未创建。请联系管理员在 Supabase Storage 中创建该桶后重试。`
    }
    if (/row-level security|permission denied|not allowed|Unauthorized/i.test(raw)) {
      return `${bucketLabel}上传失败：当前账号没有 ${bucket} 上传权限，请联系管理员检查 Storage 策略。`
    }
    return `${bucketLabel}上传失败：${raw || '未知错误'}`
  }

  // 上传录音 Blob 并返回公开 URL

  async function uploadAudioBlob(blob: Blob, userId: string, prefix: string): Promise<string> {
    const path = `${userId}/${prefix}_${Date.now()}.webm`
    const { error: upErr } = await supabase.storage.from('audio-uploads').upload(path, blob)
    if (upErr) throw new Error(getStorageUploadErrorMessage(upErr, 'audio-uploads'))
    const { data } = supabase.storage.from('audio-uploads').getPublicUrl(path)
    return data.publicUrl
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) { setError('请填写反思标题'); return }
    setError('')
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('未登录')

      // 上传课堂录音（文件 or 现场录音 blob）
      let audio_url: string | undefined
      if (classAudioFile) {
        if (classAudioFile.size > 100 * 1024 * 1024) throw new Error('音频文件不超过 100MB')
        const ext = classAudioFile.name.split('.').pop()
        const path = `${user.id}/${Date.now()}.${ext}`
        const { error: upErr } = await supabase.storage.from('audio-uploads').upload(path, classAudioFile)
        if (upErr) throw new Error(getStorageUploadErrorMessage(upErr, 'audio-uploads'))
        const { data: urlData } = supabase.storage.from('audio-uploads').getPublicUrl(path)
        audio_url = urlData.publicUrl
      } else if (classAudioBlob) {
        const path = `${user.id}/class_${Date.now()}.webm`
        const { error: upErr } = await supabase.storage.from('audio-uploads').upload(path, classAudioBlob)
        if (upErr) throw new Error(getStorageUploadErrorMessage(upErr, 'audio-uploads'))
        const { data: urlData } = supabase.storage.from('audio-uploads').getPublicUrl(path)
        audio_url = urlData.publicUrl
      }

      // 上传教学设计文档（如有）并提取文本用于 AI 分析
      let teaching_design = form.teaching_design
      if (docFile) {
        const ext = (docFile.name.split('.').pop() ?? '').toLowerCase()
        if (ext === 'doc') {
          throw new Error('暂不支持 .doc 格式，请转换为 .docx / .pdf / .txt 后再上传。')
        }

        const path = `${user.id}/doc_${Date.now()}.${ext || 'bin'}`
        const { error: upErr } = await supabase.storage.from('doc-uploads').upload(path, docFile)
        if (upErr) throw new Error(getStorageUploadErrorMessage(upErr, 'doc-uploads'))
        const { data: urlData } = supabase.storage.from('doc-uploads').getPublicUrl(path)

        const extractRes = await fetch('/api/document-extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urlData.publicUrl, fileName: docFile.name }),
        })

        if (extractRes.ok) {
          const payload = await extractRes.json() as { text?: string }
          const extracted = String(payload.text ?? '').trim()
          if (extracted) {
            teaching_design = [teaching_design.trim(), `【文档解析：${docFile.name}】`, extracted]
              .filter(Boolean)
              .join('\n\n')
          }
        } else {
          const payload = await extractRes.json().catch(() => null) as { error?: string } | null
          if (!teaching_design.trim()) {
            throw new Error(payload?.error ?? '文档已上传，但解析失败。请粘贴教学设计文本后重试。')
          }
          teaching_design = `[文档] ${urlData.publicUrl}\n\n${teaching_design}`
        }
      }


      // 上传自评/同伴评价录音 → 转文字
      let self_review = form.self_review
      let peer_review = form.peer_review
      let self_review_audio_url: string | undefined
      let peer_review_audio_url: string | undefined

      if (selfReviewBlob) {
        self_review_audio_url = await uploadAudioBlob(selfReviewBlob, user.id, 'self')
      }
      if (peerReviewBlob) {
        peer_review_audio_url = await uploadAudioBlob(peerReviewBlob, user.id, 'peer')
      }

      // 插入反思会话记录
      const { data: session, error: insErr } = await supabase
        .from('reflection_sessions')
        .insert({
          teacher_id: user.id,
          title: form.title,
          class_date: form.class_date || null,
          subject: form.subject || null,
          grade: form.grade || null,
          lesson_topic: null,
          teaching_design: teaching_design || null,
          self_review: self_review || null,
          peer_review: peer_review || null,
          audio_url: audio_url ?? null,
          draft_snapshot: (self_review_audio_url || peer_review_audio_url) ? {
            self_review_audio_url: self_review_audio_url ?? null,
            peer_review_audio_url: peer_review_audio_url ?? null,
          } : null,
          current_stage: 0,
          status: 'draft',
        })
        .select('id')
        .single()

      if (insErr) throw insErr
      router.push(`/dashboard/sessions/${session.id}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">新建反思</h1>
        <p className="text-gray-500 text-sm mt-1">填写课程信息与原始数据，AI 将帮助你进行深度分析</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* 基本信息 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h2 className="font-semibold text-gray-900">基本信息</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">反思标题 *</label>
              <input
                value={form.title} onChange={e => setField('title', e.target.value)}
                placeholder="例：第三单元《平行与垂直》教学反思"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">上课日期</label>
              <input type="date" value={form.class_date} onChange={e => setField('class_date', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">学科</label>
              <input
                value={form.subject} readOnly
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600 cursor-default"
                placeholder="（自动从个人信息获取）"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">年级</label>
              <input
                value={form.grade} readOnly
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600 cursor-default"
                placeholder="（自动从个人信息获取）"
              />
            </div>
          </div>
          {(!form.subject || !form.grade) && (
            <p className="text-xs text-amber-600">⚠ 学科/年级未设置，请先到<a href="/dashboard/profile" className="underline ml-1">个人信息</a>完善。</p>
          )}
        </div>

        {/* 原始数据 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
          <h2 className="font-semibold text-gray-900">原始数据</h2>

          {/* 教学设计 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              教学设计
              <span className="text-gray-400 font-normal ml-2">（文本输入或上传文档）</span>
            </label>
            <textarea
              value={form.teaching_design} onChange={e => setField('teaching_design', e.target.value)}
              rows={4} placeholder="粘贴教学设计内容，或在下方上传文档…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />
            <div className="mt-2">
              <input ref={docRef} type="file" accept=".docx,.pdf,.txt" className="hidden"
                onChange={e => setDocFile(e.target.files?.[0] ?? null)} />
              <button type="button" onClick={() => docRef.current?.click()}
                className="text-sm text-blue-600 hover:underline">
                {docFile ? `已选择: ${docFile.name}` : '+ 上传文档（.docx/.pdf/.txt）'}
              </button>
            </div>
          </div>

          {/* 教师自评：文本 + 录音 */}
          <AudioTextField
            label="教师自评"
            value={form.self_review}
            onChange={v => setField('self_review', v)}
            placeholder="描述本节课的教学过程，自认为的亮点与不足…"
            audioBlob={selfReviewBlob}
            onAudioBlob={setSelfReviewBlob}
          />

          {/* 同伴评价：文本 + 录音 */}
          <AudioTextField
            label="同伴评价"
            value={form.peer_review}
            onChange={v => setField('peer_review', v)}
            placeholder="粘贴同事、导师的听课评价意见…"
            audioBlob={peerReviewBlob}
            onAudioBlob={setPeerReviewBlob}
          />

          {/* 课堂录音：选择文件 or 现场录音 */}
          <ClassAudioInput
            file={classAudioFile}
            onFile={setClassAudioFile}
            blob={classAudioBlob}
            onBlob={setClassAudioBlob}
          />
        </div>

        {error && <p className="text-red-500 text-sm">{error}</p>}

        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => router.back()}
            className="px-4 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
            取消
          </button>
          <button type="submit" disabled={loading}
            className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
            {loading ? '保存中…' : '保存并进入分析'}
          </button>
        </div>
      </form>
    </div>
  )
}
