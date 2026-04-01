import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLM } from '@/lib/ai'

const SYSTEM_PROMPT = `你是经验丰富的教学督导专家，擅长为一线教师制定落地可行的教学改进策略。

## 改进措施制定要求
根据每对"问题-归因"，制定具体、可操作的改进措施。

## 措施设计原则
1. **针对性**：措施必须直接回应归因的根本原因，做到"因因施策"
2. **可操作性**：措施要具体到"做什么、怎么做"，避免"加强……""注意……"等空泛表述
3. **适度性**：每对问题-归因提供 1-2 条措施，聚焦核心改进点
4. **专业性**：语言规范，体现教学专业术语，适合教师专业发展档案

## 措施示例
- ✅ 好："在讲授新概念前，设计2-3个前测问题了解学生已有认知，根据反馈调整讲授起点"
- ❌ 差："要多了解学情"

## 输出格式
[
  {
    "problem_id": "问题ID（原样填写）",
    "cause_id": "归因ID（原样填写）",
    "measures": [
      {"description": "改进措施描述（30-80字）"}
    ]
  }
]
只返回JSON数组，不要任何额外说明。`

const JSON_REPAIR_PROMPT = `你是 JSON 修复器。请把用户提供的内容修复为“合法 JSON 数组”，且结构必须为：
[
  {
    "problem_id": "string",
    "cause_id": "string",
    "measures": [{ "description": "string" }]
  }
]
要求：
1) 仅返回 JSON 数组本身，不要 Markdown 代码块，不要解释。
2) 保留原有语义与字段值。
3) 自动修复单引号、缺逗号、多余文本、末尾注释等语法问题。`

type MeasureItem = {
  problem_id: string
  cause_id: string
  measures: Array<{ description: string }>
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

  const { session_id } = await request.json()

  const { data: session } = await supabase
    .from('reflection_sessions').select('*').eq('id', session_id).eq('teacher_id', user.id).single()
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('subject, grade, textbook_version')

    .eq('id', user.id)
    .maybeSingle()

  const [{ data: problems }, { data: causes }] = await Promise.all([
    supabase.from('problems').select('*').eq('session_id', session_id).eq('confirmed', true),
    supabase.from('causes').select('*').eq('session_id', session_id).eq('confirmed', true),
  ])

  if (!causes?.length) return NextResponse.json({ error: '请先确认至少一条归因' }, { status: 400 })

  try {
    const pairsText = causes.map(c => {
      const problem = problems?.find(p => p.id === c.problem_id)
      return `问题ID: ${c.problem_id}\n问题: ${problem?.description ?? '—'}\n归因ID: ${c.id}\n归因: ${c.description}`
    }).join('\n\n')

    const expertRole = buildExpertRole(
      session.subject ?? profile?.subject,
      session.grade ?? profile?.grade,
      profile?.textbook_version

    )

    const raw = await callLLM(`${expertRole}\n\n${SYSTEM_PROMPT}`, `以下是需要制定改进措施的问题-归因对:\n\n${pairsText}`)
    const items = await parseMeasureItems(raw)


    await supabase.from('measures').delete().eq('session_id', session_id).eq('confirmed', false)

    const toInsert = items.flatMap((item, pi) => {
      const measuresList = Array.isArray(item?.measures) ? item.measures : []
      return measuresList
        .filter(m => typeof m?.description === 'string' && m.description.trim().length > 0)
        .map((m, mi) => ({
          session_id,
          problem_id: item.problem_id,
          cause_id: item.cause_id || null,
          description: m.description.trim(),
          confirmed: false,
          sort_order: pi * 10 + mi,
        }))
    })


    if (toInsert.length > 0) await supabase.from('measures').insert(toInsert)
    return NextResponse.json({ ok: true, count: toInsert.length })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI 分析失败' }, { status: 500 })
  }
}
