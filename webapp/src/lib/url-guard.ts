// 服务端下载用户传入 URL 前的白名单校验（防 SSRF）
// 优先严格限定为本站 Supabase 域（storage 与 API 同域）；未配置时退化为拦截内网/回环地址
export function isAllowedMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false

    const base = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (base) {
      try {
        return u.hostname === new URL(base).hostname
      } catch {
        // 环境变量异常时走下方兜底规则
      }
    }

    const h = u.hostname.toLowerCase()
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]' || h === '::1') return false
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
    if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.localhost')) return false
    return true
  } catch {
    return false
  }
}
