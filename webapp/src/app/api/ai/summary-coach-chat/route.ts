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
  return `你是${subjectText}学科${gradeText}教学反思元认知引导助手，熟悉${textbookText}。`
}

const BASE_SYSTEM_PROMPT = `你是一个教学反思元认知引导助手，你的任务是帮助教师对整个教学反思过程进行结构化总结与提升。
你的重点不是重复已有内容，而是引导教师完成“反思的再反思”，即分析其思维过程与认知变化。

目标模块（四部分）：
1. 整体反思过程总结
2. 教学认识提升
3. 可迁移经验
4. 未来改进方向

一、逐步提问（Process Control）
- 每次仅围绕一个子任务提问（总结/提升/迁移/展望）。
- 未完成当前子任务前，不得进入下一模块。
- 每个子任务最多进行 2–3 轮追问。

二、避免空泛表达（Specificity Constraint）
- 禁止无指向表述（如“以后要更好”“需要改进”）。
- 用户回答必须包含至少 1 个具体教学情境或行为（如某环节/某活动/某提问）；若不满足，继续追问具体化。

三、情境绑定（Context Binding）
- 所有回答必须关联本节课“已确认问题/归因/改进措施”中的至少一项。
- 若用户偏离情境，先一句提醒，再追问将其拉回当前案例。

四、逻辑判断与分支策略（Adaptive Scaffolding）
- 对话开始先判定用户输入结构：
  - 【逻辑不完整】任一满足：表达零散无结构；只描述现象无原因或无反思；无法区分总结/提升/改进。
  - 【逻辑较清晰】同时满足：表达具有一定结构性；要点清晰。
- 若为【逻辑不完整】，执行【强引导模式】：
  - 严格顺序：总结 → 提升 → 迁移 → 展望。
  - 每完成一模块，给出“完成确认 + 过渡提示”。
  - 每模块至少形成 1 条具体表述后再进入下一步。
  - 最终统一生成完整结构化输出。
- 若为【逻辑较清晰】，执行【弱引导模式】：
  - 优先补齐用户较弱模块，可非顺序优化。
  - 每个被触发模块完成后，立即输出该模块结构化结果。
  - 结束时整合已完成模块为结构化结果。

五、完成判定与过渡（Step Gating）
- 每个模块完成标准：≥1 条具体、情境化、可判定的表述。
- 完成后必须使用过渡语：
  “已完成【模块名】，是否进入下一模块【模块名】？”

六、输出契约（Output Contract，必须执行）
- 【强引导模式】最终输出必须包含：
【整体反思过程总结】
【教学认识提升】
【可迁移经验】
【未来改进方向】
- 【弱引导模式】按已完成模块逐一输出对应结构块；会话结束时再整合。

边界限制：
- 禁止长篇泛化分析：常规轮次最多 4 句，控制在 180 字以内。
- 禁止脱离当前阶段问题：只能围绕本次会话已确认的问题、归因与改进措施展开。

回复规则：
- 常规轮次默认只给“1 个聚焦问题 + 1 句简短引导”。
- 当用户明确要求“总结/输出总结与展望/结构化输出”时，按当前模式执行结构化输出契约。`

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { session_id, messages, outlookDraft } = await request.json() as {
    session_id?: string
    messages?: ReqMessage[]
    outlookDraft?: string
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

  const [{ data: profile }, { data: problems }, { data: causes }, { data: measures }] = await Promise.all([
    supabase.from('profiles').select('subject, grade, textbook_version').eq('id', user.id).maybeSingle(),
    supabase.from('problems').select('description, confirmed').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
    supabase.from('causes').select('description, confirmed').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
    supabase.from('measures').select('description, confirmed').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
  ])

  if (!(problems ?? []).length) {
    return NextResponse.json({ error: '请先完成前序阶段并确认问题后，再进行总结与展望对话。' }, { status: 400 })
  }

  const context = [
    `【已确认问题】\n${(problems ?? []).map((p, i) => `${i + 1}. ${p.description}`).join('\n') || '（无）'}`,
    `【已确认归因】\n${(causes ?? []).map((c, i) => `${i + 1}. ${c.description}`).join('\n') || '（无）'}`,
    `【已确认改进措施】\n${(measures ?? []).map((m, i) => `${i + 1}. ${m.description}`).join('\n') || '（无）'}`,
    `【教学设计】\n${getTeachingDesignForAnalysis(session.teaching_design) || '（无）'}`,
    `【课堂录音转写】\n${session.audio_transcript || '（无）'}`,
    `【教师自评】\n${session.self_review || '（无）'}`,
    `【同伴评价】\n${session.peer_review || '（无）'}`,
    `【当前总结与展望草稿】\n${String(outlookDraft ?? '').trim() || '（暂无）'}`,
  ].join('\n\n')

  const systemPrompt = `${buildExpertRole(
    profile?.subject ?? session.subject,
    profile?.grade ?? session.grade,
    profile?.textbook_version
  )}\n\n${BASE_SYSTEM_PROMPT}`

  try {
    const llmMessages: LLMChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `以下是本次会话材料，请仅用于“总结与展望”引导：\n\n${context}` },
      ...normalizedMessages,
    ]

    const reply = await callLLMWithMessages(llmMessages, 0.5)
    return NextResponse.json({ ok: true, reply: reply.trim() })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '总结与展望对话失败' },
      { status: 500 }
    )
  }
}
