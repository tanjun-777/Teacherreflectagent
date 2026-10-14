import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLM } from '@/lib/ai'
import { getTeachingDesignForAnalysis } from '@/lib/teaching-design'
import { buildEvidenceText, truncateText } from '@/lib/evidence'


const SYSTEM_PROMPT = `【AI生成任务：教学反思总结与展望】

请基于以下信息生成报告中的两部分：
一、课堂概述
三、总结与展望

输入信息：
- 课堂概述基础材料
- 问题—归因—改进措施对照表
- 原始教学设计材料


【生成要求】
请在“三、总结与展望”中从以下四个方面系统展开：
1. 整体反思总结（必须）
- 提炼本节课核心问题与关键矛盾
- 不得简单重复对照表
- 使用概括性、抽象性语言（如“本质在于……”“关键问题表现为……”）

2. 教学认知提升（必须）
- 说明教师在本次反思中的新认识或理解变化
- 可涉及教学设计、教学措施、学生学习、评价方式、教育理念等
- 使用“认识到……/意识到……/进一步理解……”等表达

3. 可迁移经验（必须）
- 提炼可迁移到其他课堂或类似教学情境的一般性原则
- 表达具有普适性，避免仅局限于本节课
- 可使用“在……情境中，应……”“类似教学中，可……”等句式

4. 未来改进方向（必须）
- 提出后续教学优化方向或实践计划
- 不得简单重复“改进措施”，要体现更宏观、更长期
- 可包括教学策略优化、能力提升方向、进一步探究问题

【语言与质量要求】
- 语言学术、简洁、逻辑清晰
- 避免空泛表达（如“提高效果”“加强学习”）
- 四部分之间有内在逻辑联系
- “三、总结与展望”总字数建议 350 字以内

- 至少提出 1 个“教学规律层面”的认识
- 至少包含 1 个“因果关系明确”的表述（如“由于……导致……”）
- 至少形成 1 条可操作的通用教学原则
- 避免仅停留在现象描述

【输出格式】
严格按以下结构输出，不添加其他章节：
一、课堂概述
……

三、总结与展望
（1）整体反思总结：……
（2）教学认知提升：……
（3）可迁移经验：……
（4）未来改进方向：……`



function buildExpertRole(subject?: string | null, grade?: string | null, textbookVersion?: string | null) {
  const subjectText = subject || '通用学科'
  const gradeText = grade ? `高中${grade}` : '高中学段'
  const textbookText = textbookVersion || '常用教材版本'
  return `你是${subjectText}学科${gradeText}教学反思写作专家，熟悉${textbookText}课程标准与教学实践。请以该学科高中教材专家视角组织报告内容。`
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

  const [{ data: problems }, { data: causes }, { data: measures }] = await Promise.all([
    supabase.from('problems').select('id, description, evidence, source').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
    supabase.from('causes').select('id, problem_id, description').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
    supabase.from('measures').select('id, problem_id, cause_id, description').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
  ])


  try {
    const tableRows = (measures ?? []).map((m, i) => {
      const problem = (problems ?? []).find(p => p.id === m.problem_id)
      const cause = (causes ?? []).find(c => c.id === m.cause_id)
      const evidence = problem ? buildEvidenceText(problem) : '证据：暂无'
      return `${i + 1}. 问题：${problem?.description ?? '—'}｜${evidence}｜归因：${cause?.description ?? '—'}｜改进措施：${m.description}`
    })

    // 补齐课堂教学材料（长文本截断保护），与反思深化对话的材料范围保持一致
    const audioTranscriptText = truncateText(session.audio_transcript, 4000)
    const studentPerformanceText = truncateText(session.student_performance, 2000)
    const learningOutcomesText = truncateText(session.learning_outcomes, 2000)
    const externalFeedbackText = truncateText(session.external_feedback, 2000)

    const summary = [
      `课题：${session.lesson_topic ?? session.title}`,
      `学科：${session.subject ?? '—'}  年级：${session.grade ?? '—'}`,
      `上课日期：${session.class_date ?? '—'}`,
      '',
      ...(session.self_review ? ['【教师自评原文】', session.self_review, ''] : []),
      ...(session.peer_review ? ['【同伴评价原文】', session.peer_review, ''] : []),
      '【原始教学设计材料】',
      ...(getTeachingDesignForAnalysis(session.teaching_design) ? [getTeachingDesignForAnalysis(session.teaching_design), ''] : ['（无）', '']),
      ...(audioTranscriptText ? ['【课堂教学实录（转写）】', audioTranscriptText, ''] : []),
      ...(studentPerformanceText ? ['【学生表现】', studentPerformanceText, ''] : []),
      ...(learningOutcomesText ? ['【学习结果】', learningOutcomesText, ''] : []),
      ...(externalFeedbackText ? ['【外部智慧教研系统反馈】', externalFeedbackText, ''] : []),

      '【课堂概述基础材料】',
      ...(problems?.map((p, i) => `${i + 1}. ${p.description}`) ?? ['（无）']),
      '',
      '【问题—证据—归因—改进措施对照表】',
      ...(tableRows.length ? tableRows : ['（无）']),
    ].join('\n')



    const expertRole = buildExpertRole(
      session.subject ?? profile?.subject,
      session.grade ?? profile?.grade,
      profile?.textbook_version
    )

    const content = await callLLM(`${expertRole}\n\n${SYSTEM_PROMPT}`, summary)

    const { data: existing } = await supabase
      .from('reflection_reports').select('id').eq('session_id', session_id).maybeSingle()

    let report
    if (existing) {
      const { data } = await supabase
        .from('reflection_reports')
        .update({ ai_draft: content, content })
        .eq('id', existing.id).select().single()
      report = data
    } else {
      const { data } = await supabase
        .from('reflection_reports')
        .insert({ session_id, ai_draft: content, content })
        .select().single()
      report = data
    }

    return NextResponse.json({ ok: true, report })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI 生成失败' }, { status: 500 })
  }
}
