import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLMWithMessages, type LLMChatMessage } from '@/lib/ai'
import { getTeachingDesignForAnalysis } from '@/lib/teaching-design'

type ReqMessage = {
  role: 'user' | 'assistant'
  content: string
}

function buildExpertRole(subject?: string | null, grade?: string | null, textbookVersion?: string | null) {
  const subjectText = subject || '通用学科'
  const gradeText = grade ? `高中${grade}` : '高中学段'
  const textbookText = textbookVersion || '常用教材版本'
  return `你是${subjectText}学科${gradeText}教学改进设计助手，熟悉${textbookText}。`
}

const BASE_SYSTEM_PROMPT = `你是一个教学改进设计助手，名称是“解决措施助手”。
任务是帮助教师将已识别的问题原因转化为具体可执行的教学改进策略。
你不能提供泛化建议，必须引导用户形成结构化、可操作的教学措施。
你的角色是“行动支架”，重点是帮助用户从分析走向实践设计。
本质功能是：从“问题的原因解释”走向“行动设计”。

对话要求：
1. 从教学问题的归因结果开始
2. 引导用户提出具体改进措施
3. 强化可执行性（时间、步骤、对象）
4. 检查现实可行性
5. 输出结构化改进措施

核心提问策略（至少覆盖）：
- 你打算如何具体调整教学？
- 这个措施在课堂哪个环节实施？
- 谁来执行这个步骤？
- 如何验证是否有效？

边界限制：
- 禁止长篇泛化分析：常规轮次最多 4 句，控制在 180 字以内。
- 禁止脱离当前阶段问题：只能围绕【当前聚焦问题】与【当前聚焦归因】设计措施；若用户偏题，只做一句提醒并拉回，不展开新话题。

输出规则：
- 常规轮次：优先提出 1 个行动化追问 + 简短引导，不给长篇结论。
- 当用户明确要求“总结/输出措施/结构化措施”时，必须按以下结构输出：
  - 问题的原因
  - 具体措施（步骤化）`

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { session_id, messages, problem_id, cause_id } = await request.json() as {
    session_id?: string
    messages?: ReqMessage[]
    problem_id?: string
    cause_id?: string
  }

  if (!session_id || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: '参数不完整' }, { status: 400 })
  }

  const normalizedMessages = messages
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.trim() }))

  if (normalizedMessages.length === 0) {
    return NextResponse.json({ error: '缺少有效对话内容' }, { status: 400 })
  }

  const { data: session } = await supabase
    .from('reflection_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('teacher_id', user.id)
    .single()

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: profile }, { data: problems }, { data: causes }] = await Promise.all([
    supabase.from('profiles').select('subject, grade, textbook_version').eq('id', user.id).maybeSingle(),
    supabase.from('problems').select('id, description, confirmed').eq('session_id', session_id).order('sort_order'),
    supabase.from('causes').select('id, problem_id, description, confirmed').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
  ])

  if (!(causes ?? []).length) {
    return NextResponse.json({ error: '请先在阶段2确认至少一条归因，再进行措施对话。' }, { status: 400 })
  }

  const selectedProblem = (problems ?? []).find(p => p.id === problem_id) ?? (problems ?? []).find(p => p.confirmed) ?? (problems ?? [])[0]
  if (!selectedProblem) {
    return NextResponse.json({ error: '请先在阶段1确认至少一个问题，再进行措施对话。' }, { status: 400 })
  }

  const causeCandidates = (causes ?? []).filter(c => c.problem_id === selectedProblem.id)
  const selectedCause = causeCandidates.find(c => c.id === cause_id) ?? causeCandidates[0]
  if (!selectedCause) {
    return NextResponse.json({ error: '当前问题下暂无已确认归因，请先完成阶段2归因确认。' }, { status: 400 })
  }

  const context = [
    `【当前聚焦问题】\n${selectedProblem.description}`,
    `【当前聚焦归因】\n${selectedCause.description}`,
    `【教学设计】\n${getTeachingDesignForAnalysis(session.teaching_design) || '（无）'}`,
    `【课堂录音转写】\n${session.audio_transcript || '（无）'}`,
    `【教师自评】\n${session.self_review || '（无）'}`,
    `【同伴评价】\n${session.peer_review || '（无）'}`,
  ].join('\n\n')

  const systemPrompt = `${buildExpertRole(
    profile?.subject ?? session.subject,
    profile?.grade ?? session.grade,
    profile?.textbook_version
  )}\n\n${BASE_SYSTEM_PROMPT}`

  try {
    const llmMessages: LLMChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `以下是本次会话材料，请仅作为行动设计与追问依据：\n\n${context}` },
      ...normalizedMessages,
    ]

    const reply = await callLLMWithMessages(llmMessages, 0.5)
    return NextResponse.json({ ok: true, reply: reply.trim() })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '措施对话失败' },
      { status: 500 }
    )
  }
}
