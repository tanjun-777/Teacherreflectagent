import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLMWithMessages, type LLMChatMessage } from '@/lib/ai'
import { getTeachingDesignForAnalysis } from '@/lib/teaching-design'
import { buildScaffoldBlock } from '@/lib/coach-scaffold'

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

// 解决措施助手的任务化支架定制（与共享支架体系咬合为单一教学法框架）
const MEASURE_SCAFFOLD = buildScaffoldBlock({
  coachName: '解决措施助手',
  stateDefinitions: `- 初始：教师刚开始设想改进方向
- 探索：教师已有措施雏形
- 深化：措施接近具体可执行
- 确认准备：措施落到具体环节且可验证，引导教师总结并落到左侧措施卡片`,
  outputAnchor: `措施表述需同时满足：
① 落到本课的具体教学环节——说明在哪个环节实施
② 含可执行要素——时间、步骤、对象
③ 有验证方式——如何判断措施有效
④ 直接回应归因——针对【当前聚焦归因】设计，而非泛化建议`,
  matrix: `| 回应\\状态 | 初始 | 探索 | 深化 | 确认准备 |
|---|---|---|---|---|
| A 陈述 | S3（引导具体化：在哪个环节、分几步） | S6（追问实施细节：时间/步骤/对象） | S2（提示验证方式） | S1（引导对照产出标准总结措施） |
| B 补充 | S3（引导步骤化表述） | S6（追问现实可行性与约束） | S5（示范结构化的措施表述） | S1（引导汇总） |
| C 检验比较 | S1（肯定主动比较方案） | S6（追问如何验证哪个更有效） | S1（确认可行） | S1（引导总结） |
| D 修正调整 | S1（确认调整） | S5（帮助重新表述修正后的措施） | S1（确认） | S1（确认） |
| E 整合重构 | S1（确认整合） | S5（帮助形成步骤完整的系统性措施） | S1（引导准备总结） | S1（引导总结并提示落到措施卡片确认） |`,
})

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

边界限制：
- 禁止提供泛化建议：必须围绕【当前聚焦问题】与【当前聚焦归因】设计措施；若用户偏题，只做一句提醒并拉回，不展开新话题。

结构化输出规则：
- 当用户明确要求“总结/输出措施/结构化措施”时，必须按以下结构输出：
  - 问题的原因
  - 具体措施（步骤化）

${MEASURE_SCAFFOLD}`

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
