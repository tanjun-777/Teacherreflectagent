'use client'
import type { ReflectionSession } from '@/types'
import { formatDate } from '@/lib/utils'

interface Props {
  session: ReflectionSession
  onAnalyze: () => void
  loading: boolean
  error: string
  statusMsg: string
}

export default function Stage0Overview({ session, onAnalyze, loading, error, statusMsg }: Props) {
  const snapshot = (session.draft_snapshot ?? {}) as {
    self_review_audio_url?: string
    peer_review_audio_url?: string
  }

  const hasData = session.teaching_design || session.self_review || session.peer_review || session.audio_url || session.audio_transcript
    || snapshot.self_review_audio_url || snapshot.peer_review_audio_url


  const selfAudioPending = !!snapshot.self_review_audio_url && !session.self_review
  const peerAudioPending = !!snapshot.peer_review_audio_url && !session.peer_review

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-900">阶段 0 — 数据概览</h2>
        <p className="text-gray-500 text-sm mt-1">确认数据后进入问题识别，系统会异步完成转写与分析</p>
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
          {[
            { label: '教学设计', value: session.teaching_design, icon: '📄' },
            { label: '教师自评', value: session.self_review, icon: '✍️', audioPending: selfAudioPending },
            { label: '同伴评价', value: session.peer_review, icon: '👥', audioPending: peerAudioPending },
          ].map(item => (
            <div key={item.label} className="flex items-start gap-3">
              <span className="text-lg shrink-0">{item.icon}</span>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-700">{item.label}</p>
                {item.value ? (
                  <p className="text-sm text-gray-500 line-clamp-2 mt-0.5">{item.value}</p>
                ) : item.audioPending ? (
                  <p className="text-sm text-amber-600 mt-0.5">录音待转写（将异步处理）</p>
                ) : (
                  <p className="text-sm text-gray-300 mt-0.5">未填写</p>
                )}
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                item.value
                  ? 'bg-green-100 text-green-700'
                  : item.audioPending
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-gray-100 text-gray-400'
              }`}>
                {item.value ? '已填写' : item.audioPending ? '录音' : '缺失'}
              </span>
            </div>
          ))}

          <div className="flex items-start gap-3">
            <span className="text-lg shrink-0">🎙️</span>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-700">课堂录音</p>
              {session.audio_url ? (
                <p className="text-sm text-blue-600 mt-0.5">已上传{session.audio_transcript ? '（已转写）' : '（将异步转写）'}</p>
              ) : session.audio_transcript ? (
                <p className="text-sm text-blue-600 mt-0.5">已上传文本版记录</p>
              ) : (
                <p className="text-sm text-gray-300 mt-0.5">未上传</p>
              )}
            </div>
            <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${(session.audio_url || session.audio_transcript) ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
              {(session.audio_url || session.audio_transcript) ? '已上传' : '缺失'}
            </span>

          </div>
        </div>
      </div>

      {!hasData && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6 text-sm text-yellow-800">
          ⚠️ 建议至少填写一项数据（教学设计、自评、同伴评价或录音）以获得更准确的 AI 分析。
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
          <>进入问题识别并异步分析 →</>
        )}
      </button>
    </div>
  )
}
