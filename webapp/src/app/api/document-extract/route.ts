import { NextResponse } from 'next/server'

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
    const { url, fileName } = (await request.json()) as ExtractReq
    if (!url) return NextResponse.json({ error: '缺少文档地址' }, { status: 400 })

    const ext = getExt(fileName)
    if (!['txt', 'pdf', 'docx'].includes(ext)) {
      return NextResponse.json({ error: '仅支持解析 .txt / .pdf / .docx 文档，请先转换后再上传。' }, { status: 400 })
    }

    const fileRes = await fetch(url)
    if (!fileRes.ok) {
      return NextResponse.json({ error: '文档下载失败，请确认文件可访问。' }, { status: 400 })
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
