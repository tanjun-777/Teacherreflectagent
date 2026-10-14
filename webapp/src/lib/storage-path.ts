// 解析本站 Supabase Storage 对象 URL（公开形式 /storage/v1/object/public/{bucket}/{path}
// 或签名形式 /storage/v1/object/{bucket}/{path}），返回 bucket 与对象路径。
// 非本站域名或非 storage 路径返回 null。前后端通用（NEXT_PUBLIC_ 变量两端可见）。
export function parseOwnedStoragePath(rawUrl: string): { bucket: string; path: string } | null {
  try {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (!base) return null
    const u = new URL(rawUrl)
    if (u.hostname !== new URL(base).hostname) return null
    const m = u.pathname.match(/^\/storage\/v1\/object\/(?:public\/)?([^/]+)\/(.+)$/)
    if (!m) return null
    return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}
