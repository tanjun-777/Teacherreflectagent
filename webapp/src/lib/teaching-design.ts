export function getTeachingDesignForAnalysis(input?: string | null) {
  const raw = String(input ?? '').trim()
  if (!raw) return ''

  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^\[文档\]\s*https?:\/\//i.test(line))
    .filter(line => !/^https?:\/\//i.test(line))

  return lines.join('\n').trim()
}
