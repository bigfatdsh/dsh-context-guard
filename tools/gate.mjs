/**
 * 诊断：净收益闸门放到多少才合适。
 *
 * 用真实语料算"每条内容压得动多少"，再看不同门槛会放行几条、整体省多少。
 * 结论用来定 `minSavingRatio` 的默认值。
 *
 * @module dsh-meta-optimizer/tools/gate
 */

import { corpus } from './corpus.mjs'
import { budgetFor, planText } from '../lib/policy.js'
import { normalizeText } from '../lib/text.js'

const rows = []
for (const entry of corpus()) {
  const norm = normalizeText(entry.text, { maxBlankRun: 1 })
  const plan = planText(norm, { tool: entry.tool, budgetChars: budgetFor(entry.tool, {}, 12000), options: {} })
  rows.push({ id: entry.id, chars: norm.length, ratio: norm.length === 0 ? 0 : 1 - plan.text.length / norm.length })
}
const total = rows.reduce((sum, row) => sum + row.chars, 0)
for (const gate of [0, 0.02, 0.03, 0.05, 0.12]) {
  const kept = rows.filter((row) => row.ratio >= gate)
  const saved = kept.reduce((sum, row) => sum + row.chars * row.ratio, 0)
  console.log(`门槛 ${(gate * 100).toFixed(0)}%: 放行 ${kept.length}/${rows.length} 条, 全语料省 ${((saved / total) * 100).toFixed(1)}%`)
}
console.log()
for (const row of rows.sort((a, b) => a.chars - b.chars)) {
  console.log(`${String(row.chars).padStart(6)} 字符  压得动 ${(row.ratio * 100).toFixed(1)}%  ${row.id}`)
}
