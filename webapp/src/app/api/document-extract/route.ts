import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAllowedMediaUrl } from '@/lib/url-guard'
import { signOwnedStorageUrl } from '@/lib/storage-sign'
import { callVisionLLM, isVisionConfigured } from '@/lib/ai'

export const runtime = 'nodejs'

type ExtractReq = {
  url?: string
  fileName?: string
}

// 文档内嵌图片识别：跳过小于该体积（字节）的 logo/装饰图；单文档最多识别张数（避免耗时与费用失控）
const MIN_DOC_IMAGE_BYTES = 5 * 1024
const MAX_DOC_IMAGES = 6

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
      // PDF 仅提取文本层；含关键图片的 PDF 建议教师将图片另存后走图片上传识别通道
      const mod = await import('pdf-parse')
      const pdfParse = (mod.default ?? mod) as (dataBuffer: Buffer) => Promise<{ text?: string }>
      const parsed = await pdfParse(buffer)
      text = parsed.text ?? ''
    } else {
      // docx：文本与 HTML 各解析一次（HTML 用于抽取内嵌图片的 base64）
      const mammoth = await import('mammoth')
      const [raw, html] = await Promise.all([
        mammoth.extractRawText({ buffer }).then(r => r.value ?? ''),
        mammoth.convertToHtml({ buffer }).then(r => r.value ?? ''),
      ])
      text = raw

      // 内嵌图片：过滤装饰小图 → 并发视觉识别 → 以【文档内图片N】段落并入文本
      const docImages = [...html.matchAll(/<img[^>]*src="data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)"/g)]
        .map(m => ({ mime: m[1], b64: m[2] }))
        .filter(im => im.b64.length * 0.75 >= MIN_DOC_IMAGE_BYTES)
        .slice(0, MAX_DOC_IMAGES)
      if (docImages.length > 0 && isVisionConfigured()) {
        const segments = await Promise.all(docImages.map(async (im, i) => {
          try {
            const content = await callVisionLLM(
              '你是图片文字识别助手。',
              '请提取这张图片中的全部文字内容；若无文字则用一句话简要描述图片内容。',
              `data:${im.mime};base64,${im.b64}`
            )
            return `【文档内图片${i + 1}】\n${normalizeText(content) || '（未识别到内容）'}`
          } catch {
            // 单张失败不阻断文档解析整体
            return `【文档内图片${i + 1}】（识别失败，可忽略）`
          }
        }))
        text = `${text}\n\n${segments.join('\n\n')}`
      }
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
