// Word 导出共用构建工具：教师端与管理端导出路由共用，保证两端结构一致。
// 包含 HTML 转义、对照表（问题/证据/归因/措施四列）、反思深化四阶段成果、对话记录渲染。

import { buildFullEvidenceText } from '@/lib/evidence'
import type { Problem, Cause, Measure } from '@/types'

export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function formatCell(value: unknown) {
  const text = String(value ?? '').trim()
  return text ? escapeHtml(text).replace(/\n/g, '<br/>') : '—'
}

export type FinalPayloadRow = {
  problem?: string
  evidence?: string
  cause?: string
  measure?: string
}

type PhaseAssumption = { original_clue?: string; explicated?: string }
type PhaseExamination = { assumption?: string; method?: string; conclusion?: string }
type PhaseNewUnderstanding = { based_on?: string; statement?: string }
type PhaseAction = { context?: string; time?: string; method?: string; expected_effect?: string }
// Phase 4 宏观行动重构（新结构：关联认识 → 基本原则 → 实践取向）
type PhaseOrientation = { linked_understanding?: string; principle?: string; orientation?: string }

export type DeepeningResults = {
  1?: { status?: string; assumptions?: PhaseAssumption[] }
  2?: { status?: string; examinations?: PhaseExamination[] }
  3?: { status?: string; new_understandings?: PhaseNewUnderstanding[] }
  4?: { status?: string; orientations?: PhaseOrientation[]; actions?: PhaseAction[] }
}

// 多记录反思深化：每条记录各自累积的四阶段成果
export type DeepeningRecordSummary = {
  order?: number
  row_index?: number
  problem?: string
  phase_results?: DeepeningResults
}

export type DialogueMessage = { role?: string; content?: string }

// 行内证据为空时，按行序用数据库完整证据兜底（不截断条数）
export function withEvidenceFallback(rows: FinalPayloadRow[], problems: Problem[]): FinalPayloadRow[] {
  return rows.map((row, i) => ({
    ...row,
    evidence: String(row.evidence ?? '').trim() || (problems[i] ? buildFullEvidenceText(problems[i]) : ''),
  }))
}

// 缺少 final_report_payload 时的兜底拼装：按 problem_id / cause_id 外键关联对齐，
// 取代旧版「按下标 zip」造成的错位关联；evidence 直接取数据库完整证据
export function buildRelationRows(
  problems: Problem[],
  causes: Cause[],
  measures: Measure[],
): FinalPayloadRow[] {
  const rows: FinalPayloadRow[] = []

  problems.forEach(p => {
    const evidence = buildFullEvidenceText(p)
    const pCauses = causes.filter(c => c.problem_id === p.id)
    const pMeasures = measures.filter(m => m.problem_id === p.id)

    if (pMeasures.length > 0) {
      pMeasures.forEach(m => {
        rows.push({
          problem: p.description,
          evidence,
          cause: pCauses.find(c => c.id === m.cause_id)?.description ?? '',
          measure: m.description,
        })
      })
      const usedCauseIds = new Set(pMeasures.map(m => m.cause_id))
      pCauses.filter(c => !usedCauseIds.has(c.id)).forEach(c => {
        rows.push({ problem: p.description, evidence, cause: c.description, measure: '' })
      })
    } else if (pCauses.length > 0) {
      pCauses.forEach(c => {
        rows.push({ problem: p.description, evidence, cause: c.description, measure: '' })
      })
    } else {
      rows.push({ problem: p.description, evidence, cause: '', measure: '' })
    }
  })

  // 数据异常兜底：未关联到任何问题的归因/措施
  const problemIds = new Set(problems.map(p => p.id))
  causes.filter(c => !problemIds.has(c.problem_id)).forEach(c => {
    const causeMeasures = measures.filter(m => m.cause_id === c.id)
    if (causeMeasures.length > 0) {
      causeMeasures.forEach(m => {
        rows.push({ problem: '（未关联问题）', evidence: '', cause: c.description, measure: m.description })
      })
    } else {
      rows.push({ problem: '（未关联问题）', evidence: '', cause: c.description, measure: '' })
    }
  })
  measures.filter(m => !problemIds.has(m.problem_id)).forEach(m => {
    rows.push({
      problem: '（未关联问题）',
      evidence: '',
      cause: causes.find(c => c.id === m.cause_id)?.description ?? '',
      measure: m.description,
    })
  })

  return rows.length ? rows : [{ problem: '', evidence: '', cause: '', measure: '' }]
}

// 问题/证据/归因/措施对照表（序号 + 四列完整显示）
export function buildComparisonTableHtml(rows: FinalPayloadRow[]): string {
  const rowsHtml = rows.length
    ? rows.map((row, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${formatCell(row.problem)}</td>
        <td>${formatCell(row.evidence)}</td>
        <td>${formatCell(row.cause)}</td>
        <td>${formatCell(row.measure)}</td>
      </tr>
    `).join('')
    : `
      <tr>
        <td>1</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
      </tr>
    `

  return `
  <table>
    <tr>
      <th style="width: 48px;">序号</th>
      <th style="width: 26%;">问题</th>
      <th style="width: 28%;">证据</th>
      <th style="width: 20%;">归因</th>
      <th style="width: 26%;">措施</th>
    </tr>
    ${rowsHtml}
  </table>`
}

function phaseItemsTable(headers: string[], widths: string[], rowsHtml: string[]): string {
  const head = `<tr>${headers.map((h, i) => `<th style="width: ${widths[i]};">${h}</th>`).join('')}</tr>`
  const body = rowsHtml.length
    ? rowsHtml.join('')
    : `<tr>${headers.map(() => '<td>—</td>').join('')}</tr>`
  return `<table>${head}${body}</table>`
}

// 教学反思审视与深化结果：四阶段结构化成果
export function buildDeepeningResultsHtml(results?: DeepeningResults | null): string {
  const emptyTip = (phase: number) => `<p>Phase ${phase}：（本阶段未产出结构化成果）</p>`

  const p1 = results?.[1]?.assumptions?.length
    ? phaseItemsTable(
        ['序号', '原文线索', '外显表述'],
        ['48px', '44%', ''],
        results[1]!.assumptions!.map((a, i) => `<tr><td>${i + 1}</td><td>${formatCell(a.original_clue)}</td><td>${formatCell(a.explicated)}</td></tr>`)
      )
    : emptyTip(1)

  const p2 = results?.[2]?.examinations?.length
    ? phaseItemsTable(
        ['序号', '检视方式', '检视结论'],
        ['48px', '32%', ''],
        results[2]!.examinations!.map((e, i) => `<tr><td>${i + 1}</td><td>${formatCell(e.method)}</td><td>${formatCell(e.conclusion)}</td></tr>`)
      )
    : emptyTip(2)

  const p3 = results?.[3]?.new_understandings?.length
    ? phaseItemsTable(
        ['序号', '依据', '新认识表述'],
        ['48px', '40%', ''],
        results[3]!.new_understandings!.map((n, i) => `<tr><td>${i + 1}</td><td>${formatCell(n.based_on)}</td><td>${formatCell(n.statement)}</td></tr>`)
      )
    : emptyTip(3)

  const p4Orientations = results?.[4]?.orientations ?? []
  const p4 = p4Orientations.length
    ? phaseItemsTable(
        ['序号', '关联的认识', '基本原则/判断标准', '实践取向'],
        ['48px', '30%', '30%', ''],
        p4Orientations.map((o, i) => `<tr><td>${i + 1}</td><td>${formatCell(o.linked_understanding)}</td><td>${formatCell(o.principle)}</td><td>${formatCell(o.orientation)}</td></tr>`)
      )
    : results?.[4]?.actions?.length
      // 兼容旧结构（actions：情境/时间/方式/预期效果）
      ? phaseItemsTable(
          ['序号', '情境', '时间', '方式', '预期效果'],
          ['48px', '24%', '14%', '30%', ''],
          results[4]!.actions!.map((a, i) => `<tr><td>${i + 1}</td><td>${formatCell(a.context)}</td><td>${formatCell(a.time)}</td><td>${formatCell(a.method)}</td><td>${formatCell(a.expected_effect)}</td></tr>`)
        )
      : emptyTip(4)

  return `
  <p><strong>Phase 1 ｜ 既有假设外显</strong></p>
  ${p1}
  <p><strong>Phase 2 ｜ 批判性检视</strong></p>
  ${p2}
  <p><strong>Phase 3 ｜ 新认识形成</strong></p>
  ${p3}
  <p><strong>Phase 4 ｜ 宏观行动重构</strong></p>
  ${p4}`
}

// 多记录反思深化结果：逐条记录呈现（每条含四阶段成果），供最终报告导出
export function buildDeepeningRecordsHtml(records: DeepeningRecordSummary[]): string {
  if (!records.length) return '<p>（本次未完成任何记录的反思深化）</p>'
  return records.map((rec, n) => {
    const rowIndex = typeof rec.row_index === 'number' ? rec.row_index : undefined
    const problemText = String(rec.problem ?? '').trim()
    const title = problemText
      ? `深化记录 ${n + 1}${rowIndex != null ? `（对照表第 ${rowIndex + 1} 条）` : ''}：${problemText.length > 80 ? `${problemText.slice(0, 80)}…` : problemText}`
      : `深化记录 ${n + 1}`
    return `
  <p><strong>${formatCell(title)}</strong></p>
  ${buildDeepeningResultsHtml(rec.phase_results)}`
  }).join('\n')
}

// 反思深化对话记录（管理端导出用）：轮次｜角色｜内容
export function buildDialogueTableHtml(messages: DialogueMessage[]): string {
  if (!messages.length) return '<p>（未记录反思深化对话过程）</p>'
  const rowsHtml = messages.map((m, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${formatCell(m.role === 'assistant' ? '引导助手' : '教师')}</td>
      <td>${formatCell(m.content)}</td>
    </tr>
  `).join('')
  return `
  <table>
    <tr>
      <th style="width: 48px;">轮次</th>
      <th style="width: 90px;">角色</th>
      <th>内容</th>
    </tr>
    ${rowsHtml}
  </table>`
}
