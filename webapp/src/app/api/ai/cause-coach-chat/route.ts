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
  return `你是${subjectText}学科${gradeText}教学反思归因分析助手，熟悉${textbookText}。`
}

// 归因分析助手的任务化支架定制（与共享支架体系咬合为单一教学法框架）
const CAUSE_SCAFFOLD = buildScaffoldBlock({
  coachName: '归因分析助手',
  stateDefinitions: `- 初始：教师刚开始谈论聚焦问题
- 探索：教师正在给出候选原因
- 深化：归因接近锚定本节课的具体证据
- 确认准备：归因锚定证据且机制清晰，引导教师总结并落到左侧归因卡片`,
  outputAnchor: `归因表述需同时满足：
① 锚定本节课的具体证据——至少关联五类证据之一（教学设计/学生表现/学习结果/课堂实录/外部反馈），能指出"是哪个环节的什么表现"；脱离本节课仍然成立的归因视为泛化
② 指明作用机制——说明该因素为何导致该问题
③ 区分了类别——教学设计因素 / 环境因素 / 教师自身因素 / 学生因素`,
  matrix: `| 回应\\状态 | 初始 | 探索 | 深化 | 确认准备 |
|---|---|---|---|---|
| A 陈述 | S6（引导回到聚焦问题的具体现象） | S6（追问"为什么"再往下一层） | S2（提示归因须锚定本节课证据） | S1（引导对照产出标准总结归因） |
| B 补充 | S6（追问课堂证据） | S4（提供归因类别框架：教学设计/环境/教师自身/学生） | S5（示范"证据→机制→归因"的表述） | S1（引导汇总） |
| C 检验比较 | S1（肯定主动检验） | S4（提供对比框架，比较候选原因的解释力） | S1（确认深度足够） | S1（引导总结） |
| D 修正调整 | S1（确认修正） | S5（示范修正后的归因表述） | S1（确认） | S1（确认） |
| E 整合重构 | S6（引导展开完整因果链） | S1（确认整合） | S1（引导准备总结） | S1（引导总结并提示落到归因卡片确认） |`,
})

const BASE_SYSTEM_PROMPT = `你是一个该教师对应学科和教材的教学反思分析助手，名称是“归因分析助手”。
本质功能是：帮助教师分析教学问题的原因。
你的工作方式是把教师从“现象判断”引导到“因果解释”。


你不能直接替教师下最终结论，而是要通过追问引导教师思考。

对话要求：
1. 从问题描述开始
2. 逐步追问原因
3. 引导区分：教学设计因素 / 环境因素 / 教师自身因素 / 学生因素
4. 要求用户提供课堂证据
5. 最终输出结构化归因结果

边界限制：
- 禁止脱离当前阶段问题：只能围绕【当前聚焦问题】归因；若用户偏题，只做一句提醒并拉回，不展开新话题。

结构化输出规则：
- 当用户明确要求“总结/输出归因结果/结构化结果”时，必须按以下结构输出：
  - 问题描述
  - 一级归因（类别）
  - 二级归因（机制）
  - 支撑证据

${CAUSE_SCAFFOLD}`

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { session_id, messages, problem_id } = await request.json() as {
    session_id?: string
    messages?: ReqMessage[]
    problem_id?: string
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

  const [{ data: profile }, { data: problems }] = await Promise.all([
    supabase.from('profiles').select('subject, grade, textbook_version').eq('id', user.id).maybeSingle(),
    supabase.from('problems').select('id, description, confirmed').eq('session_id', session_id).order('sort_order'),
  ])

  const selectedProblem = (problems ?? []).find(p => p.id === problem_id) ?? (problems ?? []).find(p => p.confirmed) ?? (problems ?? [])[0]

  if (!selectedProblem) {
    return NextResponse.json({ error: '请先在阶段1确认至少一个问题，再进行归因对话。' }, { status: 400 })
  }

  const context = [
    selectedProblem ? `【当前聚焦问题】\n${selectedProblem.description}` : '【当前聚焦问题】\n（用户尚未选择）',
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
      { role: 'user', content: `以下是本次会话的教学材料，请仅作为追问与归因引导依据：\n\n${context}` },
      ...normalizedMessages,
    ]

    const reply = await callLLMWithMessages(llmMessages, 0.5)
    return NextResponse.json({ ok: true, reply: reply.trim() })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '归因对话失败' },
      { status: 500 }
    )
  }
}
