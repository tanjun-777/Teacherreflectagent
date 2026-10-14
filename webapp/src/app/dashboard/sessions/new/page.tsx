'use client'
import { useState, useRef, useEffect, useMemo } from 'react'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

const DOC_EXTENSIONS = ['txt', 'pdf', 'docx'] as const
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const
const MAX_FIELD_FILES = 9
const MAX_IMAGE_SIZE = 10 * 1024 * 1024

// 两步流程的本地持久化（基本信息 + 当前步骤，刷新不丢失）
const STORAGE_KEY = 'new-reflection-wizard-v1'

function getFileExt(name: string) {
  const ext = name.split('.').pop()
  return String(ext ?? '').toLowerCase()
}

function isDocFile(name: string) {
  return DOC_EXTENSIONS.includes(getFileExt(name) as typeof DOC_EXTENSIONS[number])
}

function isImageFile(file: File) {
  return IMAGE_EXTENSIONS.includes(getFileExt(file.name) as typeof IMAGE_EXTENSIONS[number])
}

// 将底层错误信息转换为教师可读的中文提示（含中文的业务提示原样返回）
function friendlyCreateError(raw: string) {
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw
  if (/duplicate key/i.test(raw)) return '该记录可能已创建，请返回反思记录列表查看后重试'
  if (/failed to fetch|networkerror|network/i.test(raw)) return '网络连接失败，请检查网络后重试'
  if (/jwt|token|401/i.test(raw)) return '登录状态已失效，请重新登录后再试'
  return `保存失败：${raw}`
}

// ─── 录音输入组件 ─────────────────────────────────────────────
type AudioInputMode = 'text' | 'record'


interface AudioTextFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  audioBlob: Blob | null
  onAudioBlob: (b: Blob | null) => void
  docFile: File | null
  onDocFile: (f: File | null) => void
}

function AudioTextField({ label, value, onChange, placeholder, audioBlob, onAudioBlob, docFile, onDocFile }: AudioTextFieldProps) {

  const [mode, setMode] = useState<AudioInputMode>('text')
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const docRef = useRef<HTMLInputElement>(null)


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

  // 录音预览地址：memoize + 卸载/替换时 revoke，避免 object URL 泄漏
  const previewUrl = useMemo(() => (audioBlob ? URL.createObjectURL(audioBlob) : null), [audioBlob])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

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
        <div>
          <textarea
            value={value} onChange={e => onChange(e.target.value)}
            rows={4} placeholder={placeholder}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          />
          <div className="mt-2 flex items-center gap-3 text-sm">
            <input
              ref={docRef}
              type="file"
              accept=".docx,.pdf,.txt"
              className="hidden"
              onChange={e => onDocFile(e.target.files?.[0] ?? null)}
            />
            <button type="button" onClick={() => docRef.current?.click()} className="text-blue-600 hover:underline">
              {docFile ? `已选择: ${docFile.name}` : '+ 上传文档（.docx/.pdf/.txt）'}
            </button>
            {docFile && (
              <button type="button" onClick={() => onDocFile(null)} className="text-gray-500 hover:underline">
                清除
              </button>
            )}
          </div>
        </div>
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
          {previewUrl && (
            <audio controls src={previewUrl} className="w-full h-8" />
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

  // 录音预览地址：memoize + 卸载/替换时 revoke，避免 object URL 泄漏
  const previewUrl = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

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
          课堂教学实录
          <span className="text-gray-400 font-normal ml-2">（音频 ≤ 100 MB，或上传文本文档）</span>
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
          <input ref={fileRef} type="file" accept="audio/*,.docx,.pdf,.txt" className="hidden"
            onChange={e => onFile(e.target.files?.[0] ?? null)} />

          <button type="button" onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-4 py-3 text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors w-full justify-center">
            {file
              ? `已选择: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`
              : '点击选择音频文件或文档（mp3/m4a/wav 或 .docx/.pdf/.txt）'}

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
          {previewUrl && <audio controls src={previewUrl} className="w-full h-8" />}
          <p className="text-xs text-gray-400">录音将在「保存并进入分析」时自动转换为文字</p>
        </div>
      )}
    </div>
  )
}

// ─── 文本 + 文档/图片（多选，图片自动识别文字）组件 ─────────────
interface DocImageFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  files: File[]
  onFiles: (fs: File[]) => void
}

function DocImageField({ label, value, onChange, placeholder, files, onFiles }: DocImageFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  function handleSelect(list: FileList | null) {
    if (!list || list.length === 0) return
    const next = [...files]
    for (const f of Array.from(list)) {
      if (next.length >= MAX_FIELD_FILES) { alert(`「${label}」最多上传 ${MAX_FIELD_FILES} 个文件`); break }
      if (isDocFile(f.name)) {
        next.push(f)
      } else if (isImageFile(f)) {
        if (f.size > MAX_IMAGE_SIZE) { alert(`图片 ${f.name} 超过 10MB，请压缩后上传`); continue }
        next.push(f)
      } else {
        alert(`不支持的文件类型：${f.name}（仅支持 .docx / .pdf / .txt 或图片）`)
      }
    }
    onFiles(next)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        <span className="text-gray-400 font-normal ml-2">（文本，或上传文档/图片，图片自动识别文字）</span>
      </label>
      <textarea
        value={value} onChange={e => onChange(e.target.value)}
        rows={4} placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
      />
      <div className="mt-2 space-y-2">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".docx,.pdf,.txt,image/*"
          className="hidden"
          onChange={e => handleSelect(e.target.files)}
        />
        <button type="button" onClick={() => inputRef.current?.click()} className="text-sm text-blue-600 hover:underline">
          + 上传文档或图片（.docx/.pdf/.txt 或图片，支持多选）
        </button>
        {files.length > 0 && (
          <ul className="space-y-1">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm text-gray-600">
                <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${isImageFile(f) ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                  {isImageFile(f) ? '图片' : '文档'}
                </span>
                <span className="truncate flex-1">{f.name}（{(f.size / 1024).toFixed(0)} KB）</span>
                <button type="button" onClick={() => onFiles(files.filter((_, idx) => idx !== i))}
                  className="text-gray-400 hover:text-red-500 shrink-0">
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ─── 步骤指示器 ────────────────────────────────────────────────
function StepIndicator({ step }: { step: 'basic' | 'data' }) {
  const steps = [
    { key: 'basic', label: '基本信息' },
    { key: 'data', label: '阶段1 数据收集与整理' },
  ] as const
  const currentIndex = step === 'basic' ? 0 : 1

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center flex-1">
            <span
              className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center shrink-0 transition-colors ${
                i < currentIndex
                  ? 'bg-blue-600 text-white'
                  : i === currentIndex
                    ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                    : 'bg-gray-100 text-gray-400'
              }`}
            >
              {i < currentIndex ? '✓' : i + 1}
            </span>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-0.5 mx-2 ${i < currentIndex ? 'bg-blue-600' : 'bg-gray-200'}`} />
            )}
          </div>
        ))}
      </div>
      <div className="flex mt-1.5">
        {steps.map((s, i) => (
          <span key={s.key} className={`text-xs flex-1 ${i === 0 ? 'text-left' : 'text-right'} ${
            i === currentIndex ? 'text-blue-700 font-medium' : 'text-gray-400'
          }`}>
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── 主页面 ─────────────────────────────────────────────────────
type WizardStep = 'basic' | 'data'

interface PersistedWizardState {
  step: WizardStep
  form: {
    title: string
    class_date: string
    subject: string
    grade: string
    // 长文本字段（教学设计/自评/同伴评价/学生表现/学习结果/外部反馈）刷新不丢失
    teaching_design: string
    self_review: string
    peer_review: string
    student_performance: string
    learning_outcomes: string
    external_feedback: string
  }
}

export default function NewSessionPage() {
  const supabase = useMemo(() => createClient(), [])

  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState<WizardStep>('basic')
  const docRef = useRef<HTMLInputElement>(null)
  const externalDocRef = useRef<HTMLInputElement>(null)
  const [docFile, setDocFile] = useState<File | null>(null)
  const [externalDocFile, setExternalDocFile] = useState<File | null>(null)
  const [classAudioFile, setClassAudioFile] = useState<File | null>(null)
  const [classAudioBlob, setClassAudioBlob] = useState<Blob | null>(null)

  // 学生表现 / 学习结果：文档 + 图片（多选）
  const [studentPerfFiles, setStudentPerfFiles] = useState<File[]>([])
  const [learningOutcomeFiles, setLearningOutcomeFiles] = useState<File[]>([])

  // 录音 blob（教师自评 / 多主体同伴反馈）
  const [selfReviewBlob, setSelfReviewBlob] = useState<Blob | null>(null)
  const [peerReviewBlob, setPeerReviewBlob] = useState<Blob | null>(null)
  const [selfReviewDocFile, setSelfReviewDocFile] = useState<File | null>(null)
  const [peerReviewDocFile, setPeerReviewDocFile] = useState<File | null>(null)


  const [form, setForm] = useState({
    title: '',
    class_date: '',
    subject: '',
    grade: '',
    teaching_design: '',
    self_review: '',
    peer_review: '',
    student_performance: '',
    learning_outcomes: '',
    external_feedback: '',
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

  // 恢复上次的步骤与基本信息（刷新不丢失）
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as Partial<PersistedWizardState>
      if (saved.step === 'data') setStep('data')
      if (saved.form) {
        setForm(f => ({
          ...f,
          title: saved.form?.title ?? f.title,
          class_date: saved.form?.class_date ?? f.class_date,
          subject: saved.form?.subject || f.subject,
          grade: saved.form?.grade || f.grade,
          // 长文本仅在本地为空时恢复，避免覆盖 profile 自动填充之外的新输入
          teaching_design: f.teaching_design || saved.form?.teaching_design || '',
          self_review: f.self_review || saved.form?.self_review || '',
          peer_review: f.peer_review || saved.form?.peer_review || '',
          student_performance: f.student_performance || saved.form?.student_performance || '',
          learning_outcomes: f.learning_outcomes || saved.form?.learning_outcomes || '',
          external_feedback: f.external_feedback || saved.form?.external_feedback || '',
        }))
      }
    } catch {
      // 忽略损坏的本地数据
    }
  }, [])

  // 持久化步骤与基本信息
  useEffect(() => {
    try {
      const persisted: PersistedWizardState = {
        step,
        form: {
          title: form.title,
          class_date: form.class_date,
          subject: form.subject,
          grade: form.grade,
          teaching_design: form.teaching_design,
          self_review: form.self_review,
          peer_review: form.peer_review,
          student_performance: form.student_performance,
          learning_outcomes: form.learning_outcomes,
          external_feedback: form.external_feedback,
        },
      }
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
    } catch {
      // 存储不可用时静默降级
    }
  }, [step, form.title, form.class_date, form.subject, form.grade,
      form.teaching_design, form.self_review, form.peer_review,
      form.student_performance, form.learning_outcomes, form.external_feedback])

  // 切换步骤后回到页面顶部
  function goToStep(s: WizardStep) {
    setStep(s)
    window.scrollTo(0, 0)
  }

  function handleNextFromBasic() {
    if (!form.title.trim()) { setError('请填写反思标题'); return }
    setError('')
    goToStep('data')
  }


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
    if (blob.size > 100 * 1024 * 1024) throw new Error('录音文件不超过 100MB，请缩短录音时长后重试')
    const path = `${userId}/${prefix}_${Date.now()}.webm`
    const { error: upErr } = await supabase.storage.from('audio-uploads').upload(path, blob)
    if (upErr) throw new Error(getStorageUploadErrorMessage(upErr, 'audio-uploads'))
    const { data } = supabase.storage.from('audio-uploads').getPublicUrl(path)
    return data.publicUrl
  }

  async function uploadDocAndExtractText(file: File, userId: string, prefix: string, label: string) {
    const ext = getFileExt(file.name)
    if (ext === 'doc') {
      throw new Error(`${label}暂不支持 .doc 格式，请转换为 .docx / .pdf / .txt 后再上传。`)
    }
    if (!isDocFile(file.name)) {
      throw new Error(`${label}仅支持 .docx / .pdf / .txt 文件。`)
    }

    const path = `${userId}/${prefix}_${Date.now()}.${ext || 'bin'}`
    const { error: upErr } = await supabase.storage.from('doc-uploads').upload(path, file)
    if (upErr) throw new Error(getStorageUploadErrorMessage(upErr, 'doc-uploads'))
    const { data: urlData } = supabase.storage.from('doc-uploads').getPublicUrl(path)

    const extractRes = await fetch('/api/document-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlData.publicUrl, fileName: file.name }),
    })

    if (!extractRes.ok) {
      const payload = await extractRes.json().catch(() => null) as { error?: string } | null
      throw new Error(payload?.error ?? `${label}文档解析失败`)
    }

    const payload = await extractRes.json() as { text?: string }
    const extracted = String(payload.text ?? '').trim()
    if (!extracted) throw new Error(`${label}未提取到有效文本，请检查文档内容`)
    return { text: extracted, url: urlData.publicUrl }
  }

  // 上传图片并调用视觉模型识别文字
  async function uploadImageAndExtractText(file: File, userId: string, prefix: string, label: string) {
    if (!isImageFile(file)) {
      throw new Error(`${label}仅支持 png / jpg / jpeg / webp / gif / bmp 格式图片。`)
    }
    if (file.size > MAX_IMAGE_SIZE) {
      throw new Error(`${label}图片 ${file.name} 超过 10MB，请压缩后上传。`)
    }

    const ext = getFileExt(file.name) || 'png'
    const path = `${userId}/${prefix}_${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage.from('doc-uploads').upload(path, file)
    if (upErr) throw new Error(getStorageUploadErrorMessage(upErr, 'doc-uploads'))
    const { data: urlData } = await supabase.storage.from('doc-uploads').getPublicUrl(path)

    const extractRes = await fetch('/api/image-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlData.publicUrl, fileName: file.name }),
    })

    if (!extractRes.ok) {
      const payload = await extractRes.json().catch(() => null) as { error?: string } | null
      throw new Error(payload?.error ?? `${label}图片识别失败`)
    }

    const payload = await extractRes.json() as { text?: string }
    const extracted = String(payload.text ?? '').trim()
    if (!extracted) throw new Error(`${label}图片未识别到有效内容，请检查图片`)
    return { text: extracted, url: urlData.publicUrl }
  }

  // 批量处理文档/图片文件：解析并合并为带来源标注的文本段
  async function processCollectedFiles(files: File[], userId: string, prefix: string, label: string) {
    const segments: string[] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      if (isDocFile(f.name)) {
        const extracted = await uploadDocAndExtractText(f, userId, `${prefix}_${i}`, `${label}文档`)
        segments.push(`【文档解析：${f.name}】\n${extracted.text}`)
      } else if (isImageFile(f)) {
        const extracted = await uploadImageAndExtractText(f, userId, `${prefix}_${i}`, label)
        segments.push(`【图片识别：${f.name}】\n${extracted.text}`)
      } else {
        throw new Error(`${label}包含不支持的文件类型：${f.name}（仅支持 .docx / .pdf / .txt 或图片）`)
      }
    }
    return segments
  }

  async function handleSubmit(e: React.FormEvent) {

    e.preventDefault()
    if (!form.title.trim()) { setError('请填写反思标题'); return }
    setError('')
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('未登录')

      // 上传课堂录音（音频文件 / 现场录音 / 文本文档）
      let audio_url: string | undefined
      let audio_transcript: string | undefined
      if (classAudioFile) {
        if (isDocFile(classAudioFile.name)) {
          const extracted = await uploadDocAndExtractText(classAudioFile, user.id, 'class_text', '课堂录音文本')
          audio_transcript = [
            `【文档解析：${classAudioFile.name}】`,
            extracted.text,
          ].join('\n\n')
        } else {
          if (classAudioFile.size > 100 * 1024 * 1024) throw new Error('音频文件不超过 100MB')
          const ext = getFileExt(classAudioFile.name)
          const path = `${user.id}/${Date.now()}.${ext || 'bin'}`
          const { error: upErr } = await supabase.storage.from('audio-uploads').upload(path, classAudioFile)
          if (upErr) throw new Error(getStorageUploadErrorMessage(upErr, 'audio-uploads'))
          const { data: urlData } = supabase.storage.from('audio-uploads').getPublicUrl(path)
          audio_url = urlData.publicUrl
        }
      } else if (classAudioBlob) {
        if (classAudioBlob.size > 100 * 1024 * 1024) throw new Error('录音文件不超过 100MB，请缩短录音时长后重试')
        const path = `${user.id}/class_${Date.now()}.webm`
        const { error: upErr } = await supabase.storage.from('audio-uploads').upload(path, classAudioBlob)
        if (upErr) throw new Error(getStorageUploadErrorMessage(upErr, 'audio-uploads'))
        const { data: urlData } = supabase.storage.from('audio-uploads').getPublicUrl(path)
        audio_url = urlData.publicUrl
      }

      // 上传教学设计文档（如有）并提取文本用于 AI 分析
      let teaching_design = form.teaching_design
      if (docFile) {
        const extracted = await uploadDocAndExtractText(docFile, user.id, 'doc', '教学设计文档')
        teaching_design = [teaching_design.trim(), `【文档解析：${docFile.name}】`, extracted.text]
          .filter(Boolean)
          .join('\n\n')
      }

      // 上传自评/同伴评价录音或文档

      let self_review = form.self_review
      let peer_review = form.peer_review
      let self_review_audio_url: string | undefined
      let peer_review_audio_url: string | undefined

      if (selfReviewDocFile) {
        const extracted = await uploadDocAndExtractText(selfReviewDocFile, user.id, 'self_review', '教师自评文档')
        self_review = [self_review.trim(), `【文档解析：${selfReviewDocFile.name}】`, extracted.text]
          .filter(Boolean)
          .join('\n\n')
      }
      if (peerReviewDocFile) {
        const extracted = await uploadDocAndExtractText(peerReviewDocFile, user.id, 'peer_review', '同伴评价文档')
        peer_review = [peer_review.trim(), `【文档解析：${peerReviewDocFile.name}】`, extracted.text]
          .filter(Boolean)
          .join('\n\n')
      }

      if (selfReviewBlob) {
        self_review_audio_url = await uploadAudioBlob(selfReviewBlob, user.id, 'self')
      }
      if (peerReviewBlob) {
        peer_review_audio_url = await uploadAudioBlob(peerReviewBlob, user.id, 'peer')
      }

      // 学生表现 / 学习结果（文档+图片）/ 外部智慧教研系统反馈
      let student_performance = form.student_performance
      let learning_outcomes = form.learning_outcomes
      let external_feedback = form.external_feedback

      if (studentPerfFiles.length > 0) {
        const segments = await processCollectedFiles(studentPerfFiles, user.id, 'student_perf', '学生表现')
        student_performance = [student_performance.trim(), ...segments].filter(Boolean).join('\n\n')
      }
      if (learningOutcomeFiles.length > 0) {
        const segments = await processCollectedFiles(learningOutcomeFiles, user.id, 'learning_outcome', '学习结果')
        learning_outcomes = [learning_outcomes.trim(), ...segments].filter(Boolean).join('\n\n')
      }
      if (externalDocFile) {
        const extracted = await uploadDocAndExtractText(externalDocFile, user.id, 'external_feedback', '外部智慧教研系统反馈文档')
        external_feedback = [external_feedback.trim(), `【文档解析：${externalDocFile.name}】`, extracted.text]
          .filter(Boolean)
          .join('\n\n')
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
          audio_transcript: audio_transcript ?? null,
          student_performance: student_performance || null,
          learning_outcomes: learning_outcomes || null,
          external_feedback: external_feedback || null,

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
      try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* 忽略 */ }
      router.push(`/dashboard/sessions/${session.id}`)
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err)
      console.error('[新建反思] 保存失败:', err)
      setError(friendlyCreateError(raw))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">
          {step === 'basic' ? '新建反思' : '阶段1 ｜ 课堂教学数据与外部反馈结果的收集与整理'}
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          {step === 'basic'
            ? '第 1 步：填写课程基本信息，点击「下一步」进入数据收集与整理'
            : '第 2 步：收集与整理课堂教学数据及外部反馈结果，保存后 AI 将帮助你进行深度分析'}
        </p>
      </div>

      <StepIndicator step={step} />

      <form onSubmit={handleSubmit} className="space-y-6">
        {step === 'basic' ? (
          <>
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

            {error && <p className="text-red-500 text-sm">{error}</p>}

            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => router.back()}
                className="px-4 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                取消
              </button>
              <button type="button" onClick={handleNextFromBasic}
                className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors">
                下一步 →
              </button>
            </div>
          </>
        ) : (
          <>
        {/* 一、课堂教学数据收集与整理 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
          <div>
            <h2 className="font-semibold text-gray-900">一、课堂教学数据收集与整理</h2>
            <p className="text-xs text-gray-400 mt-0.5">教学设计 · 课堂教学实录 · 教师自评 · 学生表现 · 学习结果</p>
          </div>

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

          {/* 课堂教学实录：选择音频文件 or 现场录音 */}
          <ClassAudioInput
            file={classAudioFile}
            onFile={setClassAudioFile}
            blob={classAudioBlob}
            onBlob={setClassAudioBlob}
          />

          {/* 教师自评：文本 + 录音 */}
          <AudioTextField
            label="教师自评"
            value={form.self_review}
            onChange={v => setField('self_review', v)}
            placeholder="描述本节课的教学过程，自认为的亮点与不足…"
            audioBlob={selfReviewBlob}
            onAudioBlob={setSelfReviewBlob}
            docFile={selfReviewDocFile}
            onDocFile={setSelfReviewDocFile}
          />

          {/* 学生表现：文本 + 文档/图片（图片自动识别文字） */}
          <DocImageField
            label="学生表现"
            value={form.student_performance}
            onChange={v => setField('student_performance', v)}
            placeholder="记录学生课堂参与、互动、专注度等表现，或上传学生作业/作品照片（自动识别文字）…"
            files={studentPerfFiles}
            onFiles={setStudentPerfFiles}
          />

          {/* 学习结果：文本 + 文档/图片（图片自动识别文字） */}
          <DocImageField
            label="学习结果"
            value={form.learning_outcomes}
            onChange={v => setField('learning_outcomes', v)}
            placeholder="记录作业完成、测验成绩、目标达成等学习结果，或上传图片（自动识别文字）…"
            files={learningOutcomeFiles}
            onFiles={setLearningOutcomeFiles}
          />
        </div>

        {/* 二、外部反馈结果的收集与整理 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
          <div>
            <h2 className="font-semibold text-gray-900">二、外部反馈结果的收集与整理</h2>
            <p className="text-xs text-gray-400 mt-0.5">多主体同伴反馈 · 外部智慧教研系统反馈</p>
          </div>

          {/* 多主体同伴反馈：文本 + 录音 */}
          <AudioTextField
            label="多主体同伴反馈"
            value={form.peer_review}
            onChange={v => setField('peer_review', v)}
            placeholder="粘贴同事、导师、教研组等多主体的听课评价意见…"
            audioBlob={peerReviewBlob}
            onAudioBlob={setPeerReviewBlob}
            docFile={peerReviewDocFile}
            onDocFile={setPeerReviewDocFile}
          />

          {/* 外部智慧教研系统反馈：文本 + 文档（类同教学设计） */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              外部智慧教研系统反馈
              <span className="text-gray-400 font-normal ml-2">（文本输入或上传文档）</span>
            </label>
            <textarea
              value={form.external_feedback} onChange={e => setField('external_feedback', e.target.value)}
              rows={4} placeholder="粘贴外部智慧教研系统生成的课堂分析报告与数据反馈内容…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />
            <div className="mt-2">
              <input ref={externalDocRef} type="file" accept=".docx,.pdf,.txt" className="hidden"
                onChange={e => setExternalDocFile(e.target.files?.[0] ?? null)} />
              <button type="button" onClick={() => externalDocRef.current?.click()}
                className="text-sm text-blue-600 hover:underline">
                {externalDocFile ? `已选择: ${externalDocFile.name}` : '+ 上传文档（.docx/.pdf/.txt）'}
              </button>
            </div>
          </div>
        </div>

        {error && <p className="text-red-500 text-sm">{error}</p>}

        <div className="flex justify-between">
          <button type="button" onClick={() => goToStep('basic')}
            className="px-4 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
            ← 上一步
          </button>
          <button type="submit" disabled={loading}
            className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
            {loading ? '保存中…' : '保存并进入分析'}
          </button>
        </div>
          </>
        )}
      </form>
    </div>
  )
}
