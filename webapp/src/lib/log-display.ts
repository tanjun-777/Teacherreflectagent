// 操作日志展示清洗：管理端页面与 Word 导出共用
// 背景：历史日志曾将结构化结果 JSON.stringify 直写，且 AI 回复含 Markdown 记号，
// 直接展示会出现大括号、英文键名、**加粗** 等符号噪音。

// 历史日志中 JSON 直写的深化结果 → 中文可读文本
export function humanizeLogJson(v: unknown): string {
  if (Array.isArray(v)) return v.map(x => humanizeLogJson(x)).filter(Boolean).join('；')
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const list = (key: string) => (Array.isArray(o[key]) ? (o[key] as Array<Record<string, unknown>>) : [])
    if (list('assumptions').length) {
      return `外显假设 ${list('assumptions').length} 条：` + list('assumptions').map((a, i) =>
        `${i + 1}.${String(a.explicated ?? '').trim()}（线索：${String(a.original_clue ?? '').trim()}）`).join('；')
    }
    if (list('examinations').length) {
      return `检视记录 ${list('examinations').length} 条：` + list('examinations').map((e, i) =>
        `${i + 1}.${String(e.conclusion ?? '').trim()}（方式：${String(e.method ?? '').trim()}）`).join('；')
    }
    if (list('new_understandings').length) {
      return `新认识 ${list('new_understandings').length} 条：` + list('new_understandings').map((n, i) =>
        `${i + 1}.${String(n.statement ?? '').trim()}`).join('；')
    }
    if (list('actions').length) {
      return `行动 ${list('actions').length} 条：` + list('actions').map((a, i) =>
        `${i + 1}.${String(a.method ?? '').trim()}（情境：${String(a.context ?? '').trim()}）`).join('；')
    }
    // 其他 JSON：仅提取字符串/数值内容，丢弃英文键名与大括号噪音
    const parts: string[] = []
    for (const val of Object.values(o)) {
      if (typeof val === 'string' && val.trim()) parts.push(val.trim())
      else if (typeof val === 'number' || typeof val === 'boolean') parts.push(String(val))
      else if (val && typeof val === 'object') {
        const nested = humanizeLogJson(val)
        if (nested) parts.push(nested)
      }
    }
    return parts.join('；')
  }
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v)
}

// 操作日志文本清洗：JSON → 中文、剥离 Markdown 记号与字面转义、压缩空白
export function cleanLogText(raw?: string): string {
  if (!raw) return ''
  let text = raw.trim()
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      const humanized = humanizeLogJson(parsed)
      if (humanized) text = humanized
    } catch {
      // 非合法 JSON，按普通文本继续清洗
    }
  }
  return text
    .replace(/\\n/g, ' ')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 表格内截断展示（悬停查看全文），避免长文本撑乱表格
const DISPLAY_LIMIT = 160

export function clipLogText(text: string): string {
  return text.length > DISPLAY_LIMIT ? `${text.slice(0, DISPLAY_LIMIT)}…` : text
}
