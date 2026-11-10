'use client'
import { useMemo, useRef, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

// 常用 LaTeX 公式模板（点击追加到公式输入框）
const FORMULA_TEMPLATES: Array<{ label: string; tex: string }> = [
  { label: '分数', tex: '\\frac{a}{b}' },
  { label: '上标', tex: 'x^{2}' },
  { label: '下标', tex: 'x_{1}' },
  { label: '根号', tex: '\\sqrt{x}' },
  { label: 'n次根', tex: '\\sqrt[3]{x}' },
  { label: '求和', tex: '\\sum_{i=1}^{n}' },
  { label: '积分', tex: '\\int_{a}^{b}' },
  { label: '极限', tex: '\\lim_{x \\to 0}' },
  { label: '括号', tex: '\\left( x \\right)' },
  { label: '×', tex: '\\times' },
  { label: '÷', tex: '\\div' },
  { label: '±', tex: '\\pm' },
  { label: '≥', tex: '\\geq' },
  { label: '≤', tex: '\\leq' },
  { label: '≠', tex: '\\neq' },
  { label: '≈', tex: '\\approx' },
  { label: '角度', tex: '30^{\\circ}' },
  { label: 'π', tex: '\\pi' },
]

// 将含 $LaTeX$ 的纯文本拆分为普通文本与公式片段
function splitByDollar(text: string): Array<{ type: 'text' | 'formula'; content: string }> {
  const parts: Array<{ type: 'text' | 'formula'; content: string }> = []
  const regex = /\$([^$\n]+)\$/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push({ type: 'text', content: text.slice(lastIndex, m.index) })
    parts.push({ type: 'formula', content: m[1] })
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) parts.push({ type: 'text', content: text.slice(lastIndex) })
  return parts
}

// 渲染单个公式；语法错误时以红色源码呈现（不抛出，避免整段预览崩溃）
function renderTex(tex: string): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: false })
  } catch {
    return `<span style="color:#dc2626">${tex.replace(/</g, '&lt;')}</span>`
  }
}

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  className?: string
}

/**
 * 支持公式输入的文本域：
 * - 「插入公式」弹窗：LaTeX 输入 + KaTeX 实时预览 + 常用模板，确认后在光标处插入 $LaTeX$
 * - 「预览公式」开关：将文本中的 $...$ 渲染为公式样式，便于教师核对
 * - 存储仍为纯文本（$LaTeX$ 源码内嵌），不改变下游字段与 AI 分析链路
 */
export default function FormulaTextarea({ value, onChange, placeholder, rows = 4, className }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [texDraft, setTexDraft] = useState('')
  const [previewOn, setPreviewOn] = useState(false)
  // 打开弹窗时记录的光标/选区，插入时写入该位置
  const insertRangeRef = useRef<{ start: number; end: number } | null>(null)

  function openDialog() {
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? value.length
    const end = ta?.selectionEnd ?? start
    insertRangeRef.current = { start, end }
    // 选中的文本作为公式初始内容（便于把已输入的式子转为公式）
    setTexDraft(value.slice(start, end))
    setDialogOpen(true)
  }

  function insertFormula() {
    const tex = texDraft.trim()
    if (!tex) return
    const insertText = `$${tex}$`
    const range = insertRangeRef.current ?? { start: value.length, end: value.length }
    onChange(value.slice(0, range.start) + insertText + value.slice(range.end))
    setDialogOpen(false)
    // 恢复焦点并把光标移到插入内容之后
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const pos = range.start + insertText.length
      ta.setSelectionRange(pos, pos)
    })
  }

  const previewParts = useMemo(
    () => (previewOn ? splitByDollar(value) : []),
    [previewOn, value]
  )
  const dialogPreviewHtml = useMemo(() => {
    if (!dialogOpen || !texDraft.trim()) return ''
    return renderTex(texDraft.trim())
  }, [dialogOpen, texDraft])

  return (
    <div>
      {/* 工具栏：插入公式 + 预览开关 */}
      <div className="flex items-center gap-2 mb-1">
        <button
          type="button"
          onClick={openDialog}
          className="text-xs px-2 py-1 rounded-full border border-blue-200 text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
        >
          ƒx 插入公式
        </button>
        <button
          type="button"
          onClick={() => setPreviewOn(p => !p)}
          className={`text-xs px-2 py-1 rounded-full border transition-colors ${
            previewOn
              ? 'border-blue-300 text-blue-700 bg-blue-100'
              : 'border-gray-200 text-gray-500 bg-gray-50 hover:bg-gray-100'
          }`}
        >
          {previewOn ? '👁 预览中' : '👁 预览公式'}
        </button>
        <span className="text-[11px] text-gray-400">公式以 $LaTeX$ 形式嵌入文本</span>
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className={className}
      />

      {/* 整段预览：$...$ 渲染为公式 */}
      {previewOn && (
        <div className="mt-1.5 border border-gray-200 rounded-lg bg-white px-3 py-2 text-sm text-gray-700 leading-relaxed max-h-48 overflow-y-auto">
          {value.trim() ? (
            previewParts.map((p, i) =>
              p.type === 'text' ? (
                <span key={i} className="whitespace-pre-wrap">{p.content}</span>
              ) : (
                <span key={i} dangerouslySetInnerHTML={{ __html: renderTex(p.content) }} />
              )
            )
          ) : (
            <span className="text-gray-300">暂无内容</span>
          )}
        </div>
      )}

      {/* 公式编辑弹窗 */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setDialogOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 shrink-0">
              <h3 className="font-semibold text-gray-900">插入公式</h3>
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            <div className="px-5 py-4 overflow-y-auto flex-1 space-y-3">
              {/* 常用模板 */}
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1.5">常用公式模板（点击加入输入框）</p>
                <div className="flex flex-wrap gap-1.5">
                  {FORMULA_TEMPLATES.map(t => (
                    <button
                      key={t.label}
                      type="button"
                      onClick={() => setTexDraft(s => (s ? s + ' ' : '') + t.tex)}
                      className="text-xs px-2 py-1 rounded-md border border-gray-200 text-gray-600 bg-gray-50 hover:border-blue-300 hover:text-blue-600 transition-colors"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* LaTeX 输入 */}
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1.5">LaTeX 公式（将插入为行内公式）</p>
                <textarea
                  value={texDraft}
                  onChange={e => setTexDraft(e.target.value)}
                  rows={3}
                  placeholder="例：\\frac{3}{4} + x^{2} = 5"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      insertFormula()
                    }
                  }}
                />
              </div>

              {/* 实时预览 */}
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1.5">实时预览</p>
                <div className="border border-gray-200 rounded-lg bg-gray-50 px-3 py-2.5 min-h-[3rem] flex items-center overflow-x-auto">
                  {texDraft.trim() ? (
                    <span className="text-base" dangerouslySetInnerHTML={{ __html: dialogPreviewHtml }} />
                  ) : (
                    <span className="text-xs text-gray-400">输入公式后此处实时显示效果</span>
                  )}
                </div>
              </div>
            </div>

            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between shrink-0">
              <p className="text-[11px] text-gray-400">按 Ctrl/⌘ + Enter 快速插入</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setDialogOpen(false)}
                  className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={insertFormula}
                  disabled={!texDraft.trim()}
                  className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
                >
                  插入
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
