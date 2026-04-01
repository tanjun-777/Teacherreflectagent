import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // target_field: 转写结果写入哪个字段，默认 audio_transcript
  // 支持 'audio_transcript' | 'self_review' | 'peer_review'
  const { session_id, audio_url, target_field = 'audio_transcript' } = await request.json()
  if (!session_id || !audio_url) {
    return NextResponse.json({ error: 'Missing params' }, { status: 400 })
  }
  const ALLOWED_FIELDS = ['audio_transcript', 'self_review', 'peer_review']
  if (!ALLOWED_FIELDS.includes(target_field)) {
    return NextResponse.json({ error: 'Invalid target_field' }, { status: 400 })
  }

  // 验证会话归属
  const { data: session } = await supabase
    .from('reflection_sessions')
    .select('id, teacher_id')
    .eq('id', session_id)
    .eq('teacher_id', user.id)
    .single()
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    // 讯飞听见 ASR 调用（长音频转写任务提交）
    const appId = process.env.XUNFEI_APP_ID!
    const secretKey = process.env.XUNFEI_SECRET_KEY!

    // 生成讯飞请求签名
    const ts = Math.floor(Date.now() / 1000).toString()
    const { createHash } = await import('crypto')
    const baseStr = appId + ts
    const md5 = createHash('md5').update(baseStr).digest('hex')
    const signa = createHash('sha1').update(md5 + secretKey).digest('base64')

    // 提交转写任务
    const params = new URLSearchParams({
      appId,
      signa,
      ts,
      fileUrls: audio_url,
      language: 'cn',
      speakerNumber: '0',
    })

    const submitRes = await fetch('https://raasr.xfyun.cn/v2/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const submitData = await submitRes.json()

    if (submitData.code !== '000000') {
      throw new Error(`讯飞 ASR 提交失败: ${submitData.descInfo}`)
    }

    const orderId = submitData.content.orderId

    // 轮询等待结果（最多 10 分钟）
    let transcript = ''
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 10000))
      const queryParams = new URLSearchParams({ appId, signa, ts, orderId })
      const queryRes = await fetch('https://raasr.xfyun.cn/v2/api/getResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: queryParams.toString(),
      })
      const queryData = await queryRes.json()
      if (queryData.code === '000000' && queryData.content?.orderState === 4) {
        // 解析转写结果
        const lattice = queryData.content?.lattice ?? []
        transcript = lattice
          .map((seg: { json_1best?: string }) => {
            try {
              const j = JSON.parse(seg.json_1best ?? '{}')
              return j.st?.rt?.map((r: { ws?: Array<{ cw?: Array<{ w: string }> }> }) =>
                r.ws?.map((w) => w.cw?.[0]?.w ?? '').join('')
              ).join('') ?? ''
            } catch { return '' }
          })
          .join('\n')
        break
      }
    }

    if (!transcript) {
      throw new Error('音频转写超时，请稍后在会话页面重试')
    }

    await supabase
      .from('reflection_sessions')
      .update({ [target_field]: transcript })
      .eq('id', session_id)

    return NextResponse.json({ ok: true, transcript, target_field })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'ASR 失败' },
      { status: 500 }
    )
  }
}
