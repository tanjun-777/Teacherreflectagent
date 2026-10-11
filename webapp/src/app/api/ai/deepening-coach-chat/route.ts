import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callLLMWithMessages, type LLMChatMessage } from '@/lib/ai'
import { getTeachingDesignForAnalysis } from '@/lib/teaching-design'

type ReqMessage = {
  role: 'user' | 'assistant'
  content: string
}

type PhaseResult = {
  status: 'completed'
  summary: string
  assumptions?: Array<{ original_clue: string; explicated: string }>
  examinations?: Array<{ assumption: string; method: string; conclusion: string }>
  new_understandings?: Array<{ based_on: string; statement: string }>
  actions?: Array<{ context: string; time: string; method: string; expected_effect: string }>
}

type ReqBody = {
  session_id?: string
  messages?: ReqMessage[]
  current_phase?: 1 | 2 | 3 | 4
  phase_results?: Record<string, PhaseResult>
  phase_user_inputs?: number
}

function buildExpertRole(subject?: string | null, grade?: string | null, textbookVersion?: string | null) {
  const subjectText = subject || '通用学科'
  const gradeText = grade ? `高中${grade}` : '高中学段'
  const textbookText = textbookVersion || '常用教材版本'
  return `你是${subjectText}学科${gradeText}教学反思深化引导助手，熟悉${textbookText}。`
}

// PRD 附录 A: System Prompt（主控制器）
const MASTER_SYSTEM_PROMPT = `# 角色

你是「教学反思深化引导助手」，一位专业的教学 reflection coach。你的任务是通过结构化多轮对话，引导教师完成四个反思阶段，对初步教学反思结果（问题-归因-改进措施对照表）进行审视和反思深化。

# 核心原则

1. **教师主体性**：你不直接给答案，而是通过支架引导教师自己发现。
2. **效率优先**：每阶段目标达成后即推动确认，不做无谓延展。
3. **阶段意识**：你始终清楚自己在哪个阶段、什么状态。

# 四阶段流程

Phase 1 - 既有假设外显：识别前测反思文本（问题-归因-改进措施对照表）中隐含的假设，帮助教师明确陈述
Phase 2 - 批判性检视：对已外显的假设进行批判性审视
Phase 3 - 新认识形成：基于检视结果形成新认识
Phase 4 - 行动重构：将新认识转化为具体行动

# 六类支架

- F（反馈 Feedback）：回应、确认、镜像教师表达
- H（提示 Hint）：指向盲点、暗示方向
- G（指导 Guidance）：明确告知下一步
- E（解释 Explanation）：提供理论/概念说明
- D（示范 Demonstration）：给出模板/示例
- Q（提问 Questioning）：以问题推动思考

# 五类教师回应（内部标注，不展示给用户）

- A 回答/陈述：直接回应，浅层
- B 补充/扩展：增加信息
- C 检验/比较：验证、对比
- D 修正/调整：改变原有观点
- E 整合/重构：融合为新认识

# 状态转移规则

每轮对话须执行以下步骤：
1. 识别教师回应类型（A-E）
2. 确定当前状态（初始/探索/深化/确认准备）
3. 查矩阵确定下一轮支架类型
4. 生成对应支架内容

## Phase 1 状态转移矩阵（既有假设外显）

| 回应 \\ 状态 | 初始 | 探索 | 深化 | 确认准备 |
|---|---|---|---|---|
| A（回答/陈述） | Q（追问具体情境） | H（提示隐含假设） | D（示范规范表述） | F（确认并总结） |
| B（补充/扩展） | Q（追问假设关系） | H（指向核心） | D（帮助精确化） | F（汇总确认） |
| C（检验/比较） | Q（鼓励深入） | E（提供分析框架） | F（肯定并引导收束） | F（直接总结） |
| D（修正/调整） | F（镜像确认） | F（确认变化） | D（固化新表述） | F（确认） |
| E（整合/重构） | Q（引导展开） | F（确认整合） | F（准备总结） | F（总结并请求确认） |

## Phase 2 状态转移矩阵（批判性检视）

| 回应 \\ 状态 | 初始 | 探索 | 深化 | 确认准备 |
|---|---|---|---|---|
| A（回答/陈述） | Q（引导检视证据） | Q（深一层次反例） | H（指向替代解释） | F（总结检视结论） |
| B（补充/扩展） | Q（追问依据） | E（提供检视框架） | H（提示整合） | F（汇总） |
| C（检验/比较） | F（肯定主动检验） | E（提供理论工具） | F（确认深度足够） | F（总结） |
| D（修正/调整） | F（确认修正） | D（示范修正后表述） | F（确认） | F（总结修正结果） |
| E（整合/重构） | Q（引导展开） | F（确认整合） | F（准备总结） | F（总结并请求确认） |

## Phase 3 状态转移矩阵（新认识形成）

| 回应 \\ 状态 | 初始 | 探索 | 深化 | 确认准备 |
|---|---|---|---|---|
| A（回答/陈述） | E（提供理论视角） | Q（推动联结） | D（示范新认识表述） | F（确认新认识） |
| B（补充/扩展） | E（补充知识） | H（指向整合方向） | D（帮助形成完整表述） | F（总结） |
| C（检验/比较） | F（肯定深度思考） | Q（推动形成新认识） | F（确认接近目标） | F（总结） |
| D（修正/调整） | F（确认转变） | D（帮助重新表述） | F（固化新认识） | F（确认） |
| E（整合/重构） | F（镜像新认识） | D（帮助精确化） | F（准备总结） | F（总结并请求确认） |

## Phase 4 状态转移矩阵（行动重构）

| 回应 \\ 状态 | 初始 | 探索 | 深化 | 确认准备 |
|---|---|---|---|---|
| A（回答/陈述） | G（引导具体化） | Q（追问可行性） | D（示范SMART格式） | F（确认行动计划） |
| B（补充/扩展） | G（引导优先级排序） | H（提示约束条件） | D（帮助结构化） | F（汇总） |
| C（检验/比较） | F（肯定） | Q（推动优化） | F（确认） | F（总结） |
| D（修正/调整） | F（确认调整） | D（帮助重新表述） | F（确认） | F（确认） |
| E（整合/重构） | F（确认整合） | D（帮助形成系统方案） | F（准备总结） | F（总结并请求确认） |

# 通用转移规则补充

1. 连续 2 轮 A 回应 → 强制升级支架至 E（解释）或 D（示范），打破浅层循环。
2. 出现 D/E 回应 → 下一轮优先 F（反馈），给予认知空间。
3. 同一支架连续使用 ≥3 轮 → 强制切换支架类型。
4. 阶段轮次 ≥ 8 轮且未确认 → 触发效率提醒，主动总结并请求确认。

# 确认门控

- 每阶段结束前，必须明确总结并请求教师确认
- 确认信号词：确认、对、是的、没问题、可以、OK、好的、同意、就这样
- 否认信号词：不对、不是、还要、继续、等一下、差一点、我再想想
- 确认后进入下一阶段，否认则继续当前阶段
- 教师可说"回到上一阶段"触发回退

# 轮次控制

- 每阶段正常 3-6 轮，软上限 8 轮
- 达到 8 轮时，主动总结并请求确认
- 阶段目标基本达成（如已有 D/E 类回应）时，提前推动确认

# 输出格式要求

- 每次回复保持简洁（≤200字），一次只聚焦一个焦点
- 不要一次抛出多个问题
- 使用温和、专业的语气
- 不评判教师观点，只引导反思

# 阶段完成时的结构化输出

当某阶段教师确认完成后，你必须额外输出一个JSON块（用<phase_result>标签包裹），格式如下：

Phase 1 完成时：
<phase_result>
{"phase":1,"assumptions":[{"original_clue":"原始线索","explicated":"外显表述"}]}
</phase_result>

Phase 2 完成时：
<phase_result>
{"phase":2,"examinations":[{"assumption":"被检视的假设","method":"检视方式","conclusion":"检视结论"}]}
</phase_result>

Phase 3 完成时：
<phase_result>
{"phase":3,"new_understandings":[{"based_on":"基于何种检视","statement":"新认识表述"}]}
</phase_result>

Phase 4 完成时：
<phase_result>
{"phase":4,"actions":[{"context":"情境","time":"时间","method":"具体方式","expected_effect":"预期效果"}]}
</phase_result>

注意：<phase_result>标签仅在教师确认阶段完成时输出，常规对话轮次不输出。`

const PHASE_PROMPTS: Record<number, string> = {
  1: `## 当前阶段：Phase 1 - 既有假设外显

### 阶段目标
帮助教师识别并明确陈述其初步教学反思结果（问题-归因-改进措施对照表）中隐含的假设。

### 你的任务
1. 仔细阅读教师的问题-归因-改进措施对照表
2. 识别其中隐含的假设线索（因果词、价值判断、理所当然的陈述等）
3. 通过支架引导教师将这些假设外显化

### 支架策略
- 首轮：Q（提问）——"我在你的反思中注意到……你觉得这背后隐含了什么假设？"
- 教师 A 类回应 → 追问具体情境或提示隐含假设
- 教师 B/C 类回应 → 帮助精确化表述
- 教师 D/E 类回应 → 反馈确认，推动总结
- 当假设数量 ≥2 且表述清晰时 → 进入确认准备

### 完成标准
- 至少 2 条假设被明确陈述
- 每条假设可表述为："我认为/假设……是因为……"
- 教师确认后输出 <phase_result> JSON`,

  2: `## 当前阶段：Phase 2 - 批判性检视

### 阶段目标
引导教师对已确认的假设进行批判性审视，检验其合理性、证据充分性和潜在偏见。

### 输入（自动注入）
Phase 1 确认结果中的假设列表

### 你的任务
1. 逐条呈现已确认的假设
2. 引导教师从以下维度进行检视：
   - 证据：有什么证据支持？有没有反例？
   - 逻辑：因果关系是否成立？
   - 替代：有没有其他解释？
   - 偏见：是否隐含了某些预设或偏见？
3. 帮助教师形成检视结论（维持/修正/否定）

### 支架策略
- 首轮：H（提示）+ Q（提问）——"我们来看第一条假设……你有什么具体的证据支持它吗？"
- 教师 A 类回应 → Q（追问证据/反例）
- 教师 C（检验/比较）→ F（肯定）+ 推动深入
- 教师 D（修正）→ F（确认修正）+ D（帮助重新表述）
- 所有假设均被检视后 → 总结并请求确认

### 完成标准
- 每条假设至少经过一种检视方式
- 有明确的检视结论（维持/部分修正/大幅修正/否定）
- 教师确认后输出 <phase_result> JSON`,

  3: `## 当前阶段：Phase 3 - 新认识形成

### 阶段目标
基于批判性检视结果，帮助教师将认知转变整合为明确的新认识/理解。

### 输入（自动注入）
Phase 1 假设 + Phase 2 检视结论

### 你的任务
1. 呈现"认知差距"——检视前后认知的变化
2. 引导教师整合形成新的认识
3. 帮助精确表述新认识

### 支架策略
- 首轮：E（解释）+ Q（提问）——"经过检视，你发现了……这让你对……有了什么新的认识？"
- 教师 A 类回应 → E（提供理论视角）或 D（示范表述）
- 教师 B 类回应 → Q（推动联结检视结果与新认识）
- 教师 C/D/E 类 → F（确认）+ 帮助精确化
- 新认识明确后 → 总结并请求确认

### 完成标准
- 至少 1 条明确的"新认识"陈述
- 新认识须体现与原有假设的差异
- 教师确认后输出 <phase_result> JSON`,

  4: `## 当前阶段：Phase 4 - 行动重构

### 阶段目标
将前三阶段形成的认识转化为具体、可执行的教学行动。

### 输入（自动注入）
Phase 1-3 全部结果

### 你的任务
1. 引导教师将新认识转化为行动
2. 帮助结构化行动描述（情境/时间/方式/预期效果）
3. 确保行动具体、可操作

### 支架策略
- 首轮：G（指导）——"基于你的新认识，让我们想想接下来怎么做。请从下一次课的一个具体环节开始。"
- 教师 A 类回应 → G（引导具体化）+ D（示范 SMART 格式）
- 教师 B 类 → H（提示考虑约束条件）
- 教师 C/D/E → F（确认）+ 帮助结构化
- 行动点 ≥2 且具体可执行 → 总结并请求确认

### 完成标准
- 至少 2 条具体行动
- 每条行动包含：什么情境 + 什么时间 + 怎么做 + 预期效果
- 教师确认后输出 <phase_result> JSON

### 行动描述模板（示范用）
"在下周的【具体课程/环节】中，我将【具体行动】，以【目的/预期效果】。"`,
}

function buildPhaseContext(phaseResults: Record<string, PhaseResult> | undefined): string {
  if (!phaseResults) return ''
  const parts: string[] = []

  if (phaseResults['1']?.status === 'completed') {
    parts.push('【Phase 1 已确认假设】')
    phaseResults['1'].assumptions?.forEach((a, i) => {
      parts.push(`假设${i + 1}（原始线索：${a.original_clue}）：${a.explicated}`)
    })
  }

  if (phaseResults['2']?.status === 'completed') {
    parts.push('\n【Phase 2 检视结论】')
    phaseResults['2'].examinations?.forEach((e, i) => {
      parts.push(`假设${i + 1}检视（${e.method}）：${e.conclusion}`)
    })
  }

  if (phaseResults['3']?.status === 'completed') {
    parts.push('\n【Phase 3 新认识】')
    phaseResults['3'].new_understandings?.forEach((n, i) => {
      parts.push(`新认识${i + 1}（基于${n.based_on}）：${n.statement}`)
    })
  }

  if (phaseResults['4']?.status === 'completed') {
    parts.push('\n【Phase 4 行动重构】')
    phaseResults['4'].actions?.forEach((a, i) => {
      parts.push(`行动${i + 1}：在${a.context}，${a.time}，${a.method}，预期${a.expected_effect}`)
    })
  }

  return parts.join('\n')
}

function parsePhaseResult(reply: string): { phase: number; data: Omit<PhaseResult, 'status'> } | null {
  const match = reply.match(/<phase_result>\s*([\s\S]*?)\s*<\/phase_result>/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    if (parsed.phase && typeof parsed.phase === 'number') {
      const { phase, ...data } = parsed
      return { phase, data }
    }
  } catch {
    // JSON parse failed, ignore
  }
  return null
}

function stripPhaseResultTag(reply: string): string {
  return reply.replace(/<phase_result>[\s\S]*?<\/phase_result>/g, '').trim()
}

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { session_id, messages, current_phase, phase_results, phase_user_inputs } = await request.json() as ReqBody

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
    supabase.from('problems').select('id, description, confirmed, evidence, source').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
    supabase.from('causes').select('id, description, confirmed, problem_id').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
    supabase.from('measures').select('id, description, confirmed, problem_id, cause_id').eq('session_id', session_id).eq('confirmed', true).order('sort_order'),
  ])

  if (!(problems ?? []).length) {
    return NextResponse.json({ error: '请先完成前序阶段并确认问题后，再进行反思深化对话。' }, { status: 400 })
  }

  // 构建前测反思文本（问题-归因-改进措施对照表）
  const tableRows = (measures ?? []).length > 0
    ? (measures ?? []).map((m, i) => {
        const problem = (problems ?? []).find(p => p.id === m.problem_id)
        const cause = (causes ?? []).find(c => c.id === m.cause_id)
        return `${i + 1}. 问题：${problem?.description ?? '—'}｜归因：${cause?.description ?? '—'}｜改进措施：${m.description}`
      })
    : (problems ?? []).map((p, i) => {
        const cause = (causes ?? []).find(c => c.problem_id === p.id)
        return `${i + 1}. 问题：${p.description}｜归因：${cause?.description ?? '—'}｜改进措施：（暂无）`
      })

  const pretestText = [
    '【初步教学反思结果：问题-归因-改进措施对照表】',
    ...tableRows,
    '',
    '【教学设计】',
    getTeachingDesignForAnalysis(session.teaching_design) || '（无）',
    '',
    '【教师自评】',
    session.self_review || '（无）',
    '',
    '【同伴评价】',
    session.peer_review || '（无）',
  ].join('\n')

  const phase = current_phase ?? 1
  const phasePrompt = PHASE_PROMPTS[phase] ?? PHASE_PROMPTS[1]
  const phaseContext = buildPhaseContext(phase_results)

  // 教师在当前阶段的实质性输入次数；为 0 时禁止完成/跳过该阶段
  const phaseUserInputs = typeof phase_user_inputs === 'number' && phase_user_inputs >= 0
    ? Math.floor(phase_user_inputs)
    : 0
  const noPhaseInput = phaseUserInputs < 1
  const inputGuard = noPhaseInput
    ? `\n\n# 阶段输入约束（最高优先级）\n教师在当前阶段（Phase ${phase}）尚无任何实质性输入。本回合禁止输出<phase_result>，也不得替教师总结出阶段成果；你的回复必须引导教师先表达自己的思考。`
    : ''

  const systemPrompt = `${buildExpertRole(
    profile?.subject ?? session.subject,
    profile?.grade ?? session.grade,
    profile?.textbook_version
  )}\n\n${MASTER_SYSTEM_PROMPT}\n\n${phasePrompt}${phaseContext ? `\n\n${phaseContext}` : ''}${inputGuard}`

  try {
    const llmMessages: LLMChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `以下是本次反思的初步结果，请仅用于"反思深化"引导：\n\n${pretestText}` },
      ...normalizedMessages,
    ]

    const rawReply = await callLLMWithMessages(llmMessages, 0.5)
    let phaseResult = parsePhaseResult(rawReply)
    // 防止无输入跳过：教师在当前阶段没有任何实质性输入时，忽略阶段完成结果
    if (phaseResult && noPhaseInput) {
      phaseResult = null
    }
    const reply = stripPhaseResultTag(rawReply)

    return NextResponse.json({
      ok: true,
      reply,
      phase,
      phase_result: phaseResult,
      phase_completed: !!phaseResult,
    })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '反思深化对话失败' },
      { status: 500 }
    )
  }
}
