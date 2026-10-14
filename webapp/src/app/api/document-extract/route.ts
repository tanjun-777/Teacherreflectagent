import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAllowedMediaUrl } from '@/lib/url-guard'
import { signOwnedStorageUrl } from '@/lib/storage-sign'

export const runtime = 'nodejs'

type ExtractReq = {
  url?: string
  fileName?: string
}

function normalizeText(raw: string) {
  return raw
    .replace(/\r/g, '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function getExt(fileName?: string) {
  const lower = String(fileName ?? '').toLowerCase()
  const idx = lower.lastIndexOf('.')
  return idx >= 0 ? lower.slice(idx + 1) : ''
}

export async function POST(request: Request) {
  try {
    // 登录校验：文档解析需为已登录教师
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { url, fileName } = (await request.json()) as ExtractReq
    if (!url) return NextResponse.json({ error: '缺少文档地址' }, { status: 400 })

    const ext = getExt(fileName)
    if (!['txt', 'pdf', 'docx'].includes(ext)) {
      return NextResponse.json({ error: '仅支持解析 .txt / .pdf / .docx 文档，请先转换后再上传。' }, { status: 400 })
    }

    // 仅允许下载本站上传的文件（防 SSRF）
    if (!isAllowedMediaUrl(url)) {
      return NextResponse.json({ error: '仅支持解析本站上传的文件。' }, { status: 400 })
    }

    // 存储桶为私有：本站文件先换为短期签名 URL 再下载
    const downloadUrl = await signOwnedStorageUrl(url)
    const fileRes = await fetch(downloadUrl)
    if (!fileRes.ok) {
      return NextResponse.json({ error: '文档下载失败，请重新上传后再试。' }, { status: 400 })
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer())
    let text = ''

    if (ext === 'txt') {
      text = new TextDecoder('utf-8').decode(buffer)
    } else if (ext === 'pdf') {
      const mod = await import('pdf-parse')
      const pdfParse = (mod.default ?? mod) as (dataBuffer: Buffer) => Promise<{ text?: string }>
      const parsed = await pdfParse(buffer)
      text = parsed.text ?? ''
    } else {
      const mammoth = await import('mammoth')
      const parsed = await mammoth.extractRawText({ buffer })
      text = parsed.value ?? ''
    }

    const normalized = normalizeText(text)
    if (!normalized || normalized.length < 20) {
      return NextResponse.json({ error: '未从文档中提取到有效文本，请检查文档内容或改为粘贴文本。' }, { status: 400 })
    }

    return NextResponse.json({ ok: true, text: normalized.slice(0, 12000) })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '文档解析失败' },
      { status: 500 }
    )
  }
}
