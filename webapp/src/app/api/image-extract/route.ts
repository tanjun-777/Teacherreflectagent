import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callVisionLLM, isVisionConfigured } from '@/lib/ai'
import { isAllowedMediaUrl } from '@/lib/url-guard'
import { signOwnedStorageUrl } from '@/lib/storage-sign'

export const runtime = 'nodejs'

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
const MAX_IMAGE_SIZE = 10 * 1024 * 1024

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

const SYSTEM_PROMPT = `你是一个专业的图片文字识别与内容理解助手，服务于课堂教学反思场景（学生作业、试卷、作品、课堂记录照片等）。
- 若图片中包含文字：完整、忠实地提取全部文字内容，尽量保留原有结构（标题、题号、段落、表格），不要改写、翻译或补充内容。
- 若图片中没有文字或文字极少：用1-3句话客观描述图片内容（如学生活动场景、作品形态等）。
- 仅输出提取的文字或描述结果，不要输出任何说明、前后缀或 markdown 代码块。`

export async function POST(request: Request) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (!isVisionConfigured()) {
      return NextResponse.json(
        { error: '图片识别模型未配置（VISION_API_URL / VISION_API_KEY / VISION_MODEL），请联系管理员在环境变量中配置后重试。' },
        { status: 503 }
      )
    }

    const { url, fileName } = (await request.json()) as ExtractReq
    if (!url) return NextResponse.json({ error: '缺少图片地址' }, { status: 400 })

    const ext = getExt(fileName)
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      return NextResponse.json({ error: '仅支持识别 png / jpg / jpeg / webp / gif / bmp 格式图片。' }, { status: 400 })
    }

    // 仅允许下载本站上传的文件（防 SSRF）
    if (!isAllowedMediaUrl(url)) {
      return NextResponse.json({ error: '仅支持解析本站上传的文件。' }, { status: 400 })
    }

    // 存储桶为私有：本站文件先换为短期签名 URL 再下载
    const downloadUrl = await signOwnedStorageUrl(url)
    const fileRes = await fetch(downloadUrl)
    if (!fileRes.ok) {
      return NextResponse.json({ error: '图片下载失败，请重新上传后再试。' }, { status: 400 })
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer())
    if (buffer.byteLength > MAX_IMAGE_SIZE) {
      return NextResponse.json({ error: '图片不超过 10MB。' }, { status: 400 })
    }

    const contentType = fileRes.headers.get('content-type') || `image/${ext === 'jpg' ? 'jpeg' : ext}`
    const imageDataUrl = `data:${contentType};base64,${buffer.toString('base64')}`

    const raw = await callVisionLLM(SYSTEM_PROMPT, '请提取这张图片中的全部文字内容；若无文字则简要描述图片内容。', imageDataUrl)
    const normalized = normalizeText(String(raw ?? '').replace(/```json|```/gi, ''))

    if (!normalized) {
      return NextResponse.json({ error: '未从图片中识别到有效内容，请检查图片或改为粘贴文本。' }, { status: 400 })
    }

    return NextResponse.json({ ok: true, text: normalized.slice(0, 12000) })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '图片识别失败' },
      { status: 500 }
    )
  }
}
