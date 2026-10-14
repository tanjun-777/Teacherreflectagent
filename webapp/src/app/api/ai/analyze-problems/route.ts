import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLM } from '@/lib/ai'


const SYSTEM_PROMPT = `你是专业的教学问题诊断专家，擅长从多主体反馈文本中精准定位教学问题。

## 任务
仅从以下三类反馈文本中提取教师存在的教学问题：
1. 教师自评（source: self_review）
2. 多主体同伴评价（source: peer_review）
3. 外部智慧教研系统反馈（source: external_feedback）

## 提取要求
1. 严格基于三类文本的原文表述提取，不得虚构、不得从教学设计等其他材料推断问题
2. 每条问题的 source 只允许取上述三类之一或多类；同一问题被多个来源提及时合并为一条并标注全部来源
3. 合并语义重复的表述，按重要性排序，最多 8 条
4. 每条问题用陈述句，15-60 字
5. 若三类文本中确实没有任何教学问题表述，返回空数组 []

## 输出格式
[
  {"description": "问题描述", "source": ["self_review"]}
]
只返回JSON数组，不要任何额外说明。`

function buildExpertRole(subject?: string | null, grade?: string | null, textbookVersion?: string | null) {
  const subjectText = subject || '通用学科'
  const gradeText = grade ? `高中${grade}` : '高中学段'
  const textbookText = textbookVersion || '常用教材版本'
  return `你是${subjectText}学科${gradeText}教学问题诊断专家，熟悉${textbookText}课程体系与课堂教学评价标准。请以该学科教学专家视角分析。`
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

  // 问题仅来源于三类反馈文本：教师自评 / 多主体同伴评价 / 外部智慧教研系统反馈
  const feedbackParts: string[] = []
  if (session.self_review) feedbackParts.push(`【教师自评】\n${session.self_review}`)
  if (session.peer_review) feedbackParts.push(`【多主体同伴评价】\n${session.peer_review}`)
  if (session.external_feedback) feedbackParts.push(`【外部智慧教研系统反馈】\n${session.external_feedback}`)
  if (feedbackParts.length === 0) {
    return NextResponse.json({ error: '缺少可分析的反馈文本（教师自评/同伴评价/外部反馈）' }, { status: 400 })
  }

  try {
    const expertRole = buildExpertRole(
      session.subject ?? profile?.subject,
      session.grade ?? profile?.grade,
      profile?.textbook_version
    )
    const raw = await callLLM(`${expertRole}\n\n${SYSTEM_PROMPT}`, feedbackParts.join('\n\n'))
    const jsonStr = raw.match(/\[[\s\S]*\]/)?.[0] ?? '[]'
    const items = JSON.parse(jsonStr) as Array<{
      description: string
      source: string[]
    }>

    const validSources = ['self_review', 'peer_review', 'external_feedback']

    // 覆盖式更新：清除上次未确认的 AI 问题
    await supabase.from('problems').delete().eq('session_id', session_id).eq('confirmed', false)

    const toInsert = items
      .filter(item => item?.description?.trim())
      .map((item, i) => ({
        session_id,
        description: item.description.trim(),
        source: Array.isArray(item.source)
          ? item.source.filter(s => validSources.includes(s))
          : [],
        confirmed: false,
        sort_order: i,
      }))
      .filter(item => item.source.length > 0)

    if (toInsert.length > 0) await supabase.from('problems').insert(toInsert)

    return NextResponse.json({ ok: true, count: toInsert.length })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI 分析失败' }, { status: 500 })
  }
}
