import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLM } from '@/lib/ai'
import { getTeachingDesignForAnalysis } from '@/lib/teaching-design'


const SYSTEM_PROMPT = `你是专业的教学诊断专家，擅长深度分析课堂教学问题的根本原因。

## 归因分析要求
针对每个教学问题，结合提供的教学材料（含自评、同伴评价），从以下维度进行归因分析：
- **教学设计层面**：学习目标设定、内容选取与组织、教学方法与活动设计
- **课堂实施层面**：时间分配、师生互动质量、提问与追问策略、课堂节奏
- **学情把握层面**：对学生已有知识/能力的预判、差异化关注
- **教师专业层面**：学科知识储备、教学语言、非语言行为

## 归因原则
1. 每个问题提供 2-4 条归因，优先选最能解释问题成因的维度
2. 归因须与问题直接对应，有逻辑关联，避免泛泛而谈
3. 语言简洁专业，每条归因 20-50 字

## 输出格式
[
  {
    "problem_id": "问题ID（原样填写）",
    "causes": [
      {"description": "归因描述"}
    ]
  }
]
只返回JSON数组，不要任何额外说明。`

function buildExpertRole(subject?: string | null, grade?: string | null, textbookVersion?: string | null) {
  const subjectText = subject || '通用学科'
  const gradeText = grade ? `高中${grade}` : '高中学段'
  const textbookText = textbookVersion || '常用教材版本'
  return `你是${subjectText}学科${gradeText}课堂归因分析专家，熟悉${textbookText}课程体系与学情特点。请以该学科高中教材专家视角进行分析。`
}


export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { session_id } = await request.json()

  const { data: session } = await supabase
    .from('reflection_sessions').select('*').eq('id', session_id).eq('teacher_id', user.id).single()
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('subject, grade, textbook_version')

    .eq('id', user.id)
    .maybeSingle()

  const { data: problems } = await supabase
    .from('problems').select('*').eq('session_id', session_id).eq('confirmed', true)
  if (!problems?.length) return NextResponse.json({ error: '请先确认至少一个问题' }, { status: 400 })

  try {
    const problemsText = problems.map(p => `ID: ${p.id}\n问题: ${p.description}`).join('\n\n')
    const contextParts: string[] = []
    const teachingDesign = getTeachingDesignForAnalysis(session.teaching_design)
    if (teachingDesign) contextParts.push(`【教学设计】\n${teachingDesign}`)

    if (session.self_review) contextParts.push(`【教师自评】\n${session.self_review}`)
    if (session.peer_review) contextParts.push(`【同伴评价】\n${session.peer_review}`)
    if (session.audio_transcript) contextParts.push(`【课堂录音转写】\n${session.audio_transcript}`)

    const userPrompt = `## 教学背景材料\n${contextParts.join('\n\n')}\n\n## 需要归因分析的问题列表\n${problemsText}`
    const expertRole = buildExpertRole(
      session.subject ?? profile?.subject,
      session.grade ?? profile?.grade,
      profile?.textbook_version

    )
    const raw = await callLLM(`${expertRole}\n\n${SYSTEM_PROMPT}`, userPrompt)
    const jsonStr = raw.match(/\[[\s\S]*\]/)?.[0] ?? '[]'
    const items = JSON.parse(jsonStr) as Array<{ problem_id: string; causes: Array<{ description: string }> }>

    await supabase.from('causes').delete().eq('session_id', session_id).eq('confirmed', false)

    const toInsert = items.flatMap((item, pi) =>
      item.causes.map((c, ci) => ({
        session_id,
        problem_id: item.problem_id,
        description: c.description,
        confirmed: false,
        sort_order: pi * 10 + ci,
      }))
    ).filter(c => problems.find(p => p.id === c.problem_id))

    if (toInsert.length > 0) await supabase.from('causes').insert(toInsert)

    return NextResponse.json({ ok: true, count: toInsert.length })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI 分析失败' }, { status: 500 })
  }
}
