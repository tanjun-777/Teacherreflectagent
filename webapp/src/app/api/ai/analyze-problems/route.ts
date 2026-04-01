import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLM } from '@/lib/ai'
import { getTeachingDesignForAnalysis } from '@/lib/teaching-design'


const SYSTEM_PROMPT = `你是一位专业的课堂教学诊断专家，请按以下三个步骤处理教学材料，识别课堂教学问题。

## 处理流程

### 步骤 a — 提取（保留原逻辑）
- 来源：仅「同伴评价」文本 + 「教师自评」文本
- 任务：提炼被明确提及的问题（相似项可合并）
- 证据：必须引用同伴评价/教师自评原文片段

### 步骤 b — 生成（严格约束）
- 来源：仅「教学设计」文本 + 「课堂录音转写」文本
- 禁止：不得使用同伴评价、教师自评或任何其他材料作为该步骤依据
- 若教学设计与课堂录音转写均缺失：该步骤输出 0 条，不得臆造

- 评价框架（唯一依据）：混合课堂评价模型
1) 教学设计层（Danielson）
  - 1C 教学目标设计（Instructional Outcomes）
  - 1E 教学结构设计（Coherent Instruction）
  - 1F 评价设计（Assessment Design）
  - 3B 提问设计（Questioning & Discussion Design）
  - 3C 学生活动设计（Student Activity Design）
  - 3D 反馈设计（Feedback Design）
2) 教学过程层（CLASS）
  - 情感支持：积极氛围、教师敏感性、学生视角尊重
  - 课堂组织：行为管理、课堂效率、教学组织形式
  - 教学支持：反馈质量、语言建模
3) 学习过程层（ICAP）
  - Passive / Active / Constructive / Interactive

- 每条步骤 b 生成问题必须在 evidence 中至少包含 1 条来自教学设计或课堂录音转写的文本证据。

### 步骤 c — 合并与限制
- 合并步骤 a + b，按综合相关性排序，总条目上限 15
- 来源标签：
  - 来自步骤 a 同伴评价 → source 包含 "peer_review"
  - 来自步骤 a 教师自评 → source 包含 "self_review"
  - 来自步骤 b AI模型评价 → source 包含 "ai_analysis"
- 同一问题可叠加多个标签

## 输出格式
仅输出 JSON 数组：
[
  {
    "description": "提炼后的问题描述（一句话，20-60字）",
    "evidence": [
      {"text": "证据片段", "source": "同伴评价/教师自评/课堂录音转写/教学设计"}
    ],
    "source": ["ai_analysis"]
  }
]
只返回 JSON 数组，不要任何额外说明。`

function buildExpertRole(subject?: string | null, grade?: string | null, textbookVersion?: string | null) {
  const subjectText = subject || '通用学科'
  const gradeText = grade ? `高中${grade}` : '高中学段'
  const textbookText = textbookVersion || '常用教材版本'
  return `你是${subjectText}学科${gradeText}教学诊断专家，熟悉${textbookText}的教学目标、知识结构和课堂实施要点。请以该学科高中教材专家视角进行分析。`
}

type SourceTag = 'ai_analysis' | 'peer_review' | 'self_review'
type ProblemItem = {
  description: string
  evidence?: Array<{ text: string; source?: string }>
  source?: string[]
}

function extractJsonArrayText(raw: string) {
  const cleaned = raw.replace(/```json|```/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return '[]'
  return cleaned.slice(start, end + 1)
}

function normalizeProblemItems(items: ProblemItem[]) {
  const allowed = new Set<SourceTag>(['ai_analysis', 'peer_review', 'self_review'])

  const normalized: Array<{ description: string; evidence: Array<{ text: string; source?: string }>; source: SourceTag[] }> = []

  for (const item of items) {
    const description = String(item?.description ?? '').trim()
    if (!description) continue

    const evidence = Array.isArray(item?.evidence)
      ? item.evidence
          .map(e => ({
            text: String(e?.text ?? '').trim(),
            source: typeof e?.source === 'string' ? e.source : undefined,
          }))
          .filter(e => e.text.length > 0)
          .slice(0, 3)
      : []

    let source: SourceTag[] = Array.isArray(item?.source)
      ? Array.from(new Set(item.source.filter((s): s is SourceTag => allowed.has(s as SourceTag))))
      : []

    const hasAiEvidence = evidence.some(e => /教学设计|课堂录音|录音转写/.test(`${e.source ?? ''}${e.text}`))
    if (source.includes('ai_analysis') && !hasAiEvidence) {
      source = source.filter(s => s !== 'ai_analysis')
    }

    if (source.length === 0) continue

    normalized.push({
      description,
      evidence,
      source,
    })
  }

  return normalized
}

async function callAnalyzeProblemsLLM(systemPrompt: string, userPrompt: string) {
  const raw = await callLLM(systemPrompt, userPrompt)
  const firstTry = extractJsonArrayText(raw)

  try {
    return normalizeProblemItems(JSON.parse(firstTry) as ProblemItem[])
  } catch {
    const repairedRaw = await callLLM(
      '你是JSON修复器。将用户输入修复为合法JSON数组，元素结构为 { description: string, evidence?: [{ text: string, source?: string }], source?: string[] }。仅返回JSON数组。',
      raw
    )
    const secondTry = extractJsonArrayText(repairedRaw)
    return normalizeProblemItems(JSON.parse(secondTry) as ProblemItem[])
  }
}

export async function POST(request: Request) {

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { session_id } = await request.json()

  const { data: session } = await supabase
    .from('reflection_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('teacher_id', user.id)
    .single()

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('subject, grade, textbook_version')

    .eq('id', user.id)
    .maybeSingle()

  try {
    const parts: string[] = []
    const teachingDesign = getTeachingDesignForAnalysis(session.teaching_design)
    if (teachingDesign) parts.push(`【教学设计】\n${teachingDesign}`)

    if (session.self_review) parts.push(`【教师自评】\n${session.self_review}`)
    if (session.peer_review) parts.push(`【同伴评价】\n${session.peer_review}`)
    if (session.audio_transcript) parts.push(`【课堂录音转写】\n${session.audio_transcript}`)

    if (parts.length === 0) {
      return NextResponse.json({ error: '请至少填写一项教学数据' }, { status: 400 })
    }

    const userPrompt = parts.join('\n\n')
    const expertRole = buildExpertRole(
      profile?.subject ?? session.subject,
      profile?.grade ?? session.grade,
      profile?.textbook_version
    )


    const items = await callAnalyzeProblemsLLM(`${expertRole}\n\n${SYSTEM_PROMPT}`, userPrompt)


    await supabase
      .from('problems')
      .delete()
      .eq('session_id', session_id)
      .eq('confirmed', false)

    const toInsert = items.slice(0, 15).map((item, i) => ({
      session_id,
      description: item.description,
      evidence: item.evidence ?? null,
      source: item.source ?? ['ai_analysis'],
      confirmed: false,
      sort_order: i,
    }))

    if (toInsert.length > 0) {
      await supabase.from('problems').insert(toInsert)
    }

    return NextResponse.json({ ok: true, count: toInsert.length })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'AI 分析失败' },
      { status: 500 }
    )
  }
}
