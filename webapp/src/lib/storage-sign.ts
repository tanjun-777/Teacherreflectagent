// 服务端专用：将本站 Supabase Storage URL 换成短期签名 URL（service_role，绕过 RLS）。
// 桶为私有，ASR/文档解析等下游（含讯飞服务器）只能访问签名后的 URL。
// 非本站 URL 原样返回（调用方需自行做白名单校验）。
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { parseOwnedStoragePath } from './storage-path'

export async function signOwnedStorageUrl(rawUrl: string, expiresInSeconds = 600): Promise<string> {
  const parsed = parseOwnedStoragePath(rawUrl)
  if (!parsed) return rawUrl

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    throw new Error('服务端存储签名配置缺失（SUPABASE_SERVICE_ROLE_KEY）')
  }

  const admin = createSupabaseClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await admin.storage.from(parsed.bucket).createSignedUrl(parsed.path, expiresInSeconds)
  if (error || !data?.signedUrl) {
    throw new Error(`生成文件临时访问链接失败：${error?.message ?? '未知错误'}`)
  }
  return data.signedUrl
}
