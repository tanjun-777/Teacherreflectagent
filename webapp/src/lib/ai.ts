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
  const res = await fetch(LLM_API_URL, {
    method: 'POST',
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


export async function authAndGetSession(supabase: ReturnType<typeof createClient>, session_id: string, user_id: string) {
  const { data: session } = await supabase
    .from('reflection_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('teacher_id', user_id)
    .single()
  return session
}
