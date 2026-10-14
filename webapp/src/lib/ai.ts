import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const LLM_API_URL = process.env.LLM_API_URL ?? 'https://api.deepseek.com/v1/chat/completions'
const LLM_API_KEY = process.env.LLM_API_KEY ?? ''
const LLM_MODEL = process.env.LLM_MODEL ?? 'deepseek-chat'

export type LLMChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export async function callLLMWithMessages(messages: LLMChatMessage[], temperature = 0.7): Promise<string> {
  // 前置校验：未配置密钥时直接给出可读错误，避免透出英文 401
  if (!LLM_API_KEY) {
    throw new Error('LLM 服务未配置（LLM_API_KEY），请联系管理员在服务端完成配置后重试')
  }
  const res = await fetch(LLM_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      temperature,
      max_tokens: 4096,
    }),
  })
  if (!res.ok) throw new Error(`LLM API error: ${res.status}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

export async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  return callLLMWithMessages([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ])
}

// ─── 视觉模型（图片识别 / OCR）─────────────────────────────────
// 独立于文本 LLM 配置，需使用支持多模态的模型（如 GLM-4V、GPT-4o、qwen-vl 等 OpenAI 兼容接口）
const VISION_API_URL = process.env.VISION_API_URL ?? ''
const VISION_API_KEY = process.env.VISION_API_KEY ?? ''
const VISION_MODEL = process.env.VISION_MODEL ?? ''

export function isVisionConfigured() {
  return Boolean(VISION_API_URL && VISION_API_KEY && VISION_MODEL)
}

export async function callVisionLLM(systemPrompt: string, userPrompt: string, imageDataUrl: string): Promise<string> {
  const res = await fetch(VISION_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VISION_API_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  })
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    throw new Error(`视觉模型 API error: ${res.status} ${raw.slice(0, 200)}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  // 部分兼容接口返回分段 content 数组
  if (Array.isArray(content)) {
    return content.map((c: { text?: string }) => String(c?.text ?? '')).join('')
  }
  return ''
}


export async function authAndGetSession(supabase: ReturnType<typeof createClient>, session_id: string, user_id: string) {
  const { data: session } = await supabase
    .from('reflection_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('teacher_id', user_id)
    .single()
  return session
}
