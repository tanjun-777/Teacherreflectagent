import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLM } from '@/lib/ai'
import { getTeachingDesignForAnalysis } from '@/lib/teaching-design'


const SYSTEM_PROMPT = `你是专业的教学诊断专家，擅长深度分析课堂教学问题的根本原因。

## 归因分析要求
针对给定的单个教学问题，从其关联证据出发，追溯根本原因。可从教学设计（目标/内容/活动）、课堂实施（时间/互动/提问）、学情把握、教师专业素养等角度切入，但切入角度必须由证据内容决定，不得罗列通用维度。

## 归因原则
1. 仅提供 1 条最能解释该问题根本原因的归因
2. **锚定证据**：归因须点明证据或材料中的具体表现，并说明它如何导致该问题
3. **反泛化自检**：若归因不引用本节课任何具体信息仍然成立（即适用于任何课堂），视为泛化归因，必须重写
4. 语言简洁专业，归因 20-50 字

## 输出格式
[
  {"description": "归因描述"}
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
    self_review: string | null
    peer_review: string | null
    audio_transcript: string | null
    student_performance: string | null
    learning_outcomes: string | null
    external_feedback: string | null
    subject: string | null
    grade: string | null
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('subject, grade, textbook_version')
    .eq('id', user.id)
    .maybeSingle()

  try {
    // 输入：问题 + 该问题已关联的证据
    const evidence = Array.isArray(problem.evidence)
      ? (problem.evidence as Array<{ text?: string; source?: string }>)
      : []
    const evidenceText = evidence.length > 0
      ? `\n\n## 该问题关联的证据\n${evidence.map((e, i) => `${i + 1}. [${e.source ?? '未标注'}] ${e.text ?? ''}`).join('\n')}`
      : ''

    // 材料聚焦：教学设计 + 证据来源对应的材料，减少无关材料干扰、提高归因针对性
    const contextParts: string[] = []
    const teachingDesign = getTeachingDesignForAnalysis(session.teaching_design)
    if (teachingDesign) contextParts.push(`【教学设计】\n${teachingDesign}`)
    const sourceFieldMap: Record<string, string | null> = {
      self_review: session.self_review,
      peer_review: session.peer_review,
      audio_transcript: session.audio_transcript,
      student_performance: session.student_performance,
      learning_outcomes: session.learning_outcomes,
      external_feedback: session.external_feedback,
    }
    const sourceLabels: Record<string, string> = {
      self_review: '教师自评',
      peer_review: '同伴评价',
      audio_transcript: '课堂录音转写',
      student_performance: '学生表现',
      learning_outcomes: '学习结果',
      external_feedback: '外部智慧教研系统反馈',
    }
    const usedSources = new Set(evidence.map(e => e.source ?? '').filter(Boolean))
    for (const src of usedSources) {
      const text = sourceFieldMap[src]
      if (text) contextParts.push(`【${sourceLabels[src]}】\n${text}`)
    }

    const userPrompt = `## 教学背景材料\n${contextParts.join('\n\n')}\n\n## 需要归因分析的教学问题\n${problem.description}${evidenceText}`
    const expertRole = buildExpertRole(
      session.subject ?? profile?.subject,
      session.grade ?? profile?.grade,
      profile?.textbook_version
    )
    const raw = await callLLM(`${expertRole}\n\n${SYSTEM_PROMPT}`, userPrompt)
    const jsonStr = raw.match(/\[[\s\S]*\]/)?.[0] ?? '[]'
    const items = JSON.parse(jsonStr) as Array<{ description: string }>

    // 覆盖式更新：仅清除该问题上次未确认的归因（支持重新生成）
    await supabase.from('causes').delete().eq('problem_id', problem_id).eq('confirmed', false)

    const toInsert = items
      .filter(c => c?.description?.trim())
      .slice(0, 1) // AI 归因限定 1 条
      .map((c, ci) => ({
        session_id: problem.session_id,
        problem_id,
        description: c.description.trim(),
        confirmed: false,
        sort_order: ci,
      }))

    if (toInsert.length > 0) await supabase.from('causes').insert(toInsert)

    return NextResponse.json({ ok: true, count: toInsert.length })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI 分析失败' }, { status: 500 })
  }
}
