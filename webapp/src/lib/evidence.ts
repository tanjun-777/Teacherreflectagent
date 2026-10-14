// 证据来源标注与文本截断工具：供反思深化对话、报告生成等 API 共用，
// 保持与前端对照表一致的“证据（来源）：引文”呈现格式。

export function sourceLabel(source?: string): string {
  if (!source) return '未标注来源'
  if (source.includes('peer')) return '同伴评价'
  if (source.includes('self')) return '教师自评'
  if (source.includes('audio') || source.includes('classroom')) return '课堂教学实录'
  if (source.includes('design')) return '教学设计'
  if (source.includes('performance')) return '学生表现'
  if (source.includes('outcomes')) return '学习结果'
  if (source.includes('external')) return '外部智慧教研系统反馈'
  if (source.includes('manual')) return '自主关联'
  return source
}

type EvidenceLike = { text?: string; source?: string }

export function buildEvidenceText(problem: { evidence?: unknown; source?: unknown }): string {
  const evidence = Array.isArray(problem.evidence) ? (problem.evidence as EvidenceLike[]) : []
  const parts = evidence
    .map(e => {
      const text = String(e?.text ?? '').trim()
      return text ? `证据（${sourceLabel(typeof e?.source === 'string' ? e.source : undefined)}）：${text}` : ''
    })
    .filter(Boolean)
    .slice(0, 2)
  if (parts.length) return parts.join('；')
  const source = Array.isArray(problem.source) ? problem.source : []
  const src = source.map(s => sourceLabel(typeof s === 'string' ? s : undefined)).join('、')
  return src ? `证据来源：${src}` : '证据：暂无直接引文'
}

// 完整证据文本（不截断条数）：供 Word 导出使用，确保对照表证据完整显示
export function buildFullEvidenceText(problem: { evidence?: unknown; source?: unknown }): string {
  const evidence = Array.isArray(problem.evidence) ? (problem.evidence as EvidenceLike[]) : []
  const parts = evidence
    .map(e => {
      const text = String(e?.text ?? '').trim()
      return text ? `证据（${sourceLabel(typeof e?.source === 'string' ? e.source : undefined)}）：${text}` : ''
    })
    .filter(Boolean)
  if (parts.length) return parts.join('；')
  const source = Array.isArray(problem.source) ? problem.source : []
  const src = source.map(s => sourceLabel(typeof s === 'string' ? s : undefined)).join('、')
  return src ? `证据来源：${src}` : ''
}

export function truncateText(text: string | null | undefined, max: number): string {
  const t = (text ?? '').trim()
  if (!t) return ''
  return t.length > max ? `${t.slice(0, max)}…（后文截断）` : t
}
