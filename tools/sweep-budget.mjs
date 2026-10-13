/**
 * 预算扫描：在**真实语料**上找出"压得狠但信息不丢"的预算点。
 *
 * 只看两个数：省了多少、有多少条结果真的丢了信息（按 informationIndex 判，不看形状）。
 *
 * @module dsh-context-guard/tools/sweep-budget
 */

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { optimizeContent } from '../lib/policy.js'
import { estimateContent } from '../lib/tokens.js'

const dir = process.env.DSH_CORPUS_DIR ?? join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', '.corpus', 'raw')
const rows = []
for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'tool/result') continue
    const content = event.data?.message?.content
    if (Array.isArray(content)) rows.push(content)
  }
}

const textOf = (content) => content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
const INDEX_RE = /[A-Za-z_][\w.-]{3,}|\d{3,}|[\u4e00-\u9fff]+/g
const index = (text) => {
  const set = new Set()
  for (const m of text.matchAll(INDEX_RE)) set.add(m[0])
  return set
}
const SIGNAL = [
  /\b(?:error|Error|ERROR|failed|Failed|FAILED|panic|fatal|FATAL|Traceback)\b/,
  /^not ok\b/,
  /\b(?:assert|expected|actual|AssertionError)\b/i,
  /\bERR_[A-Z_]+\b|\bE\d{3,4}\b/,
  /:\d+:\d+/,
  /\bexit code\b|\bexit status\b/,
]

const median = (sorted) => sorted[Math.floor(sorted.length / 2)]

for (const budget of [1500, 2000, 2500, 3000, 4000, 6000, 12000]) {
  let base = 0
  let after = 0
  let lossy = 0
  const outs = []
  for (const content of rows) {
    const before = estimateContent(content)
    if (before < 60) continue
    base += before
    const result = optimizeContent({ tool: 'bash', content, isError: false }, { budgetChars: budget })
    after += estimateContent(result.content)
    const text = textOf(content)
    const outText = textOf(result.content)
    const signals = text.split('\n').filter((line) => line.trim() && SIGNAL.some((re) => re.test(line)))
    const have = index(outText)
    let missing = 0
    for (const line of signals) for (const token of index(line)) if (!have.has(token)) missing += 1
    if (missing > 0) lossy += 1
    outs.push(outText.length)
  }
  outs.sort((a, b) => a - b)
  console.log(
    `预算 ${String(budget).padStart(5)}  省 ${(((1 - after / base) * 100).toFixed(1)).padStart(5)}%` +
      `  有信息丢失的结果 ${String(lossy).padStart(4)}/${rows.length}` +
      `  产出字符中位数 ${String(median(outs)).padStart(6)}`,
  )
}
