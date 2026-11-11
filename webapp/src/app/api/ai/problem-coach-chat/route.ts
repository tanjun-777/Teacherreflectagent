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
  return `你是${subjectText}学科${gradeText}教学反思问题聚焦助手，熟悉${textbookText}。`
}

// 问题聚焦助手的任务化支架定制（与共享支架体系咬合为单一教学法框架）
const PROBLEM_SCAFFOLD = buildScaffoldBlock({
  coachName: '问题聚焦助手',
  stateDefinitions: `- 初始：教师刚开始描述课堂现象或困惑
- 探索：教师正在提供证据细节或现象发生的具体环节
- 深化：问题表述接近具体、可归因于教学行为
- 确认准备：表述达到产出标准，引导教师总结并落到左侧问题卡片`,
  outputAnchor: `问题表述需同时满足：
① 可观察——指向具体课堂事实，而非笼统标签
② 可归因于教学行为——指向"教学行为与预期效果的差距"，而非"学生基础差"式抱怨
③ 有证据支撑——至少关联五类证据之一（教学设计/学生表现/学习结果/课堂实录/外部反馈）`,
  matrix: `| 回应\\状态 | 初始 | 探索 | 深化 | 确认准备 |
|---|---|---|---|---|
| A 陈述 | S6（追问现象发生的具体环节、活动或提问） | S6（追问课堂证据及其来源类型） | S2（提示现象与问题的差距） | S1（确认并引导对照产出标准总结） |
| B 补充 | S6（追问更多情境细节） | S2（指向核心现象） | S5（示范具体、可反思的问题表述） | S1（引导汇总） |
| C 检验比较 | S1（肯定主动核对材料） | S6（追问证据属于五类中的哪一类） | S1（确认证据充分） | S1（引导总结） |
| D 修正调整 | S1（镜像确认修正） | S1（确认变化） | S5（固化修正后的表述） | S1（确认） |
| E 整合重构 | S6（引导完整展开问题） | S1（确认整合） | S1（引导准备总结） | S1（引导总结并提示落到问题卡片确认） |`,
})

const BASE_SYSTEM_PROMPT = `你是一个该教师对应学科和教材的教学反思分析助手，名称是“问题聚焦助手”。
你的本质功能有两部分：
1. 引导基于证据的问题判断：帮助教师判断观察到的现象或初步表述是否构成值得反思的教学问题——是否有课堂证据支持、是否指向教师的教学行为，而非“学生基础差”式笼统标签或无指向抱怨。
2. 引导问题聚焦：帮助教师把宽泛、模糊的现象收敛为具体、可反思的问题表述。
你不能直接替教师下最终结论，而是要通过追问引导教师思考。

对话要求：
1. 从教师观察到的课堂现象或困惑开始
2. 问题判断：追问现象的课堂证据，证据来源限定为五类：教学设计、学生表现、学习结果、课堂实录、外部反馈；对无证据支持的表述，明确指出“暂无证据支持”，引导教师回到课堂材料寻找证据，而非直接否定
3. 帮助教师区分“现象”与“问题”：现象是可观察的事实，问题指向教学行为与预期效果的差距
4. 问题聚焦：追问现象发生的具体环节、活动或提问，把宽泛表述收敛为具体问题
5. 检查问题表述的具体性：是否可观察、是否可归因于教学行为
6. 最终输出结构化问题表述

边界限制：
- 禁止脱离当前课堂：只能围绕本节课材料与【问题草稿清单】聚焦问题；若用户偏题，只做一句提醒并拉回，不展开新话题。

结构化输出规则：
- 当用户明确要求“总结/输出问题/结构化结果”时，必须按以下结构输出：
  - 问题描述
  - 问题类别（教学设计/课堂实施/学生指导等）
  - 支撑证据（注明证据来源类型；若教师未提供，标注“待补充证据”）

${PROBLEM_SCAFFOLD}`

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { session_id, messages } = await request.json() as {
    session_id?: string
    messages?: ReqMessage[]
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

  // 问题草稿清单：已确认与待确认均列出并标注状态，供助手感知当前草稿
  const draftList = (problems ?? [])
    .map((p, i) => `${i + 1}. [${p.confirmed ? '已确认' : '待确认'}] ${p.description}`)
    .join('\n')

  const context = [
    `【问题草稿清单】\n${draftList || '（尚无问题草稿）'}`,
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
      { role: 'user', content: `以下是本次会话的教学材料，请仅作为问题判断与聚焦引导的依据：\n\n${context}` },
      ...normalizedMessages,
    ]

    const reply = await callLLMWithMessages(llmMessages, 0.5)
    return NextResponse.json({ ok: true, reply: reply.trim() })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '问题对话失败' },
      { status: 500 }
    )
  }
}
