import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLM } from '@/lib/ai'
import { getTeachingDesignForAnalysis } from '@/lib/teaching-design'


const SYSTEM_PROMPT = `你是专业的教学证据分析专家，擅长从多源教学材料中为指定教学问题检索、关联支撑证据。

## 任务
针对给定的教学问题，仅从以下五类材料中检索与该问题直接相关的证据原文：
1. 教学设计（source: teaching_design）
2. 学生表现（source: student_performance）
3. 学习结果（source: learning_outcomes）
4. 课堂教学实录（source: classroom_record）
5. 外部智慧教研系统反馈报告（source: external_feedback）

## 证据关联原则
1. 证据内容必须严格来源于上述五类材料的原文（可适当摘录关键句），严禁虚构、严禁改编
2. 每条证据必须标注其来源，只允许上述五类 source 值
3. 证据必须与问题直接相关、有逻辑支撑关系；某类材料中无相关证据时不强行关联
4. 仅关联 1 条与该问题最直接相关的证据；若五类材料中确实均无相关证据，返回空数组 []
5. 每条证据 20-120 字

## 输出格式
[
  {"text": "证据原文摘录", "source": "teaching_design"}
]
只返回JSON数组，不要任何额外说明。`

function buildExpertRole(subject?: string | null, grade?: string | null, textbookVersion?: string | null) {
  const subjectText = subject || '通用学科'
  const gradeText = grade ? `高中${grade}` : '高中学段'
  const textbookText = textbookVersion || '常用教材版本'
  return `你是${subjectText}学科${gradeText}教学证据分析专家，熟悉${textbookText}课程体系与课堂观察方法。请以该学科教学专家视角检索证据。`
}


export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { problem_id } = await request.json()
  if (!problem_id) return NextResponse.json({ error: '缺少 problem_id' }, { status: 400 })

  const { data: problem } = await supabase
    .from('problems')
    .select('*, reflection_sessions!inner(*)')
    .eq('id', problem_id)
    .eq('reflection_sessions.teacher_id', user.id)
    .single()
  if (!problem) return NextResponse.json({ error: '问题不存在' }, { status: 404 })

  const session = problem.reflection_sessions as {
    teaching_design: string | null
    student_performance: string | null
    learning_outcomes: string | null
    audio_transcript: string | null
    external_feedback: string | null
    subject: string | null
    grade: string | null
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('subject, grade, textbook_version')
    .eq('id', user.id)
    .maybeSingle()

  // 证据仅来源于五类材料
  const materialParts: string[] = []
  const teachingDesign = getTeachingDesignForAnalysis(session.teaching_design)
  if (teachingDesign) materialParts.push(`【教学设计】\n${teachingDesign}`)
  if (session.student_performance) materialParts.push(`【学生表现】\n${session.student_performance}`)
  if (session.learning_outcomes) materialParts.push(`【学习结果】\n${session.learning_outcomes}`)
  if (session.audio_transcript) materialParts.push(`【课堂教学实录】\n${session.audio_transcript}`)
  if (session.external_feedback) materialParts.push(`【外部智慧教研系统反馈报告】\n${session.external_feedback}`)
  if (materialParts.length === 0) {
    return NextResponse.json({ error: '缺少可关联的证据材料（教学设计/学生表现/学习结果/课堂实录/外部反馈）' }, { status: 400 })
  }

  try {
    const expertRole = buildExpertRole(
      session.subject ?? profile?.subject,
      session.grade ?? profile?.grade,
      profile?.textbook_version
    )
    const userPrompt = `## 需要关联证据的教学问题\n${problem.description}\n\n## 可检索的教学材料\n${materialParts.join('\n\n')}`
    const raw = await callLLM(`${expertRole}\n\n${SYSTEM_PROMPT}`, userPrompt)
    const jsonStr = raw.match(/\[[\s\S]*\]/)?.[0] ?? '[]'
    const items = JSON.parse(jsonStr) as Array<{ text: string; source: string }>

    const validSources = ['teaching_design', 'student_performance', 'learning_outcomes', 'classroom_record', 'external_feedback']
    const evidence = items
      .filter(item => item?.text?.trim())
      .map(item => ({
        text: item.text.trim(),
        source: validSources.includes(item.source) ? item.source : 'teaching_design',
      }))
      .slice(0, 1) // AI 关联证据限定 1 条

    // 覆盖式更新该问题的证据（支持重新生成）
    const { error } = await supabase
      .from('problems')
      .update({ evidence })
      .eq('id', problem_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ ok: true, count: evidence.length })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI 分析失败' }, { status: 500 })
  }
}
