import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLM } from '@/lib/ai'
import { getTeachingDesignForAnalysis } from '@/lib/teaching-design'
import type { Json } from '@/types/supabase'


const SYSTEM_PROMPT = `你是经验丰富的教学督导专家，擅长为一线教师制定落地可行的教学改进策略。

## 改进措施制定要求
针对给定的单组"问题-证据-归因"，制定具体、可操作的改进措施。

## 措施设计原则
1. **针对性**：措施必须直接回应归因的根本原因，做到"因因施策"
2. **落到本课**：措施须结合本节课教学设计，指明在哪个教学环节、针对什么内容、如何调整
3. **可操作性**：措施要具体到"做什么、怎么做"，避免"加强……""注意……"等空泛表述
4. **反泛化自检**：若措施不引用本节课任何具体信息仍然成立（即适用于任何课堂），视为泛化措施，必须重写
5. **单条聚焦**：仅提供 1 条措施，聚焦核心改进点
6. **专业性**：语言规范，体现教学专业术语，适合教师专业发展档案

## 措施示例
- ✅ 好："在讲授新概念前，设计2-3个前测问题了解学生已有认知，根据反馈调整讲授起点"
- ❌ 差："要多了解学情"

## 输出格式
[
  {"description": "改进措施描述（30-80字）"}
]
只返回JSON数组，不要任何额外说明。`

const JSON_REPAIR_PROMPT = `你是 JSON 修复器。请把用户提供的内容修复为“合法 JSON 数组”，且结构必须为：
[
  {"description": "string"}
]
要求：
1) 仅返回 JSON 数组本身，不要 Markdown 代码块，不要解释。
2) 保留原有语义与字段值。
3) 自动修复单引号、缺逗号、多余文本、末尾注释等语法问题。`

type MeasureItem = {
  description: string
}

function extractJsonArrayText(raw: string) {
  const cleaned = raw.replace(/```json|```/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return '[]'
  return cleaned.slice(start, end + 1)
}

async function parseMeasureItems(raw: string) {
  const firstTry = extractJsonArrayText(raw)

  try {
    return JSON.parse(firstTry) as MeasureItem[]
  } catch {
    const repaired = await callLLM(JSON_REPAIR_PROMPT, raw)
    const secondTry = extractJsonArrayText(repaired)
    return JSON.parse(secondTry) as MeasureItem[]
  }
}


function buildExpertRole(subject?: string | null, grade?: string | null, textbookVersion?: string | null) {
  const subjectText = subject || '通用学科'
  const gradeText = grade ? `高中${grade}` : '高中学段'
  const textbookText = textbookVersion || '常用教材版本'
  return `你是${subjectText}学科${gradeText}教学改进策略专家，熟悉${textbookText}课堂实施与评价标准。请以该学科高中教材专家视角给出措施。`
}


export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { cause_id } = await request.json()
  if (!cause_id) return NextResponse.json({ error: '缺少 cause_id' }, { status: 400 })

  const { data: cause } = await supabase
    .from('causes')
    .select('*, problems!inner(*, reflection_sessions!inner(*))')
    .eq('id', cause_id)
    .eq('problems.reflection_sessions.teacher_id', user.id)
    .single()
  if (!cause) return NextResponse.json({ error: '归因不存在' }, { status: 404 })

  const problem = cause.problems as {
    id: string
    session_id: string
    description: string
    evidence: Json | null
    reflection_sessions: {
      subject: string | null
      grade: string | null
      teaching_design: string | null
    }
  }
  const session = problem.reflection_sessions

  const { data: profile } = await supabase
    .from('profiles')
    .select('subject, grade, textbook_version')
    .eq('id', user.id)
    .maybeSingle()

  try {
    const evidence = Array.isArray(problem.evidence)
      ? (problem.evidence as Array<{ text?: string; source?: string }>)
      : []
    const evidenceText = evidence.length > 0
      ? `\n问题关联证据：\n${evidence.map((e, i) => `${i + 1}. [${e.source ?? '未标注'}] ${e.text ?? ''}`).join('\n')}`
      : '\n问题关联证据：（暂无）'

    const expertRole = buildExpertRole(
      session?.subject ?? profile?.subject,
      session?.grade ?? profile?.grade,
      profile?.textbook_version
    )

    // 补充教学设计情境，使措施落到本节课的具体环节与内容
    const teachingDesign = getTeachingDesignForAnalysis(session?.teaching_design ?? null)
    const designText = teachingDesign ? `\n\n本节课教学设计:\n${teachingDesign}` : ''

    const raw = await callLLM(
      `${expertRole}\n\n${SYSTEM_PROMPT}`,
      `以下是需要制定改进措施的问题-证据-归因组合:\n\n问题: ${problem.description}${evidenceText}\n归因: ${cause.description}${designText}`
    )
    const items = await parseMeasureItems(raw)

    // 覆盖式更新：仅清除该归因上次未确认的措施（支持重新生成）
    await supabase.from('measures').delete().eq('cause_id', cause_id).eq('confirmed', false)

    const toInsert = items
      .filter(m => typeof m?.description === 'string' && m.description.trim().length > 0)
      .slice(0, 1) // AI 措施限定 1 条
      .map((m, mi) => ({
        session_id: problem.session_id,
        problem_id: problem.id,
        cause_id,
        description: m.description.trim(),
        confirmed: false,
        sort_order: mi,
      }))

    if (toInsert.length > 0) await supabase.from('measures').insert(toInsert)
    return NextResponse.json({ ok: true, count: toInsert.length })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI 分析失败' }, { status: 500 })
  }
}
