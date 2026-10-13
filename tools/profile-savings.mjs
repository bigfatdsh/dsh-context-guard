/**
 * 省量归因：把 123 万 token 拆开，看"哪些内容、哪一步"吃掉了预算。
 *
 * 输出一行 JSON，方便外部解析（展示层会折叠只差数字的行）。
 *
 * @module dsh-meta-optimizer/tools/profile-savings
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_KEEP_RATIO, DEFAULT_MIN_KEEP_TOKENS, optimizeContent } from '../lib/policy.js'
import { estimateContent } from '../lib/tokens.js'

const dir = process.env.DSH_CORPUS_DIR ?? join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', '.corpus', 'raw')
const DEFAULTS = { keepRatio: DEFAULT_KEEP_RATIO, minKeepTokens: DEFAULT_MIN_KEEP_TOKENS }

const names = new Map()
const rows = []
for (const file of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (line.length === 0) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'tool/call' && event.data?.callId) names.set(event.data.callId, event.data.name)
    else if (event.type === 'tool/result') rows.push(event)
  }
}

const textOf = (c) => c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
/** 按"内容形态"分类，不看工具名——同一类内容用同一把刀。 */
function shapeOf(text) {
  const t = text.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) return 'json-like'
  const lines = text.split('\n')
  if (lines.filter((l) => /^[\w./@+-]+$/.test(l.trim())).length > lines.length * 0.6) return 'path-list'
  if (lines.filter((l) => /^[-dlbcps][rwxsStT-]{9}/.test(l)).length > 3) return 'ls-long'
  if (lines.filter((l) => /^\s*\d+[:\t→]/.test(l)).length > lines.length * 0.5) return 'numbered'
  if (lines.filter((l) => /^[+-]/.test(l)).length > 3) return 'diff-like'
  if (lines.filter((l) => /^\[?\d{4}-\d{2}-\d{2}|^\[?\d{2}:\d{2}:\d{2}/.test(l)).length > 3) return 'log'
  if (lines.filter((l) => l.length > 400).length > 0) return 'has-long-line'
  return 'plain'
}

const byShape = new Map()
const byStep = new Map()
let base = 0
let after = 0
for (const event of rows) {
  const content = event.data.message.content
  const before = estimateContent(content)
  if (before < 30) continue
  const text = textOf(content)
  const shape = shapeOf(text)
  const tool = names.get(event.data.message.toolCallId) ?? 'unknown'
  const result = optimizeContent({ tool, content, isError: false }, DEFAULTS)
  const at = estimateContent(result.content)
  base += before
  after += at

  const bucket = byShape.get(shape) ?? { n: 0, base: 0, after: 0 }
  bucket.n += 1; bucket.base += before; bucket.after += at
  byShape.set(shape, bucket)

  const key = result.steps.filter((s) => s !== 'normalize').join('+') || 'none'
  const stepBucket = byStep.get(key) ?? { n: 0, base: 0, after: 0 }
  stepBucket.n += 1; stepBucket.base += before; stepBucket.after += at
  byStep.set(key, stepBucket)
}

const rowsOut = (map) => [...map.entries()]
  .sort((a, b) => b[1].base - a[1].base)
  .map(([key, v]) => ({ key, n: v.n, base: v.base, after: v.after, savedPct: +((1 - v.after / v.base) * 100).toFixed(1), tokensLeft: v.after }))

writeFileSync(process.env.PROFILE_OUT ?? '/tmp/profile-savings.json', `${JSON.stringify({
  base, after, savedPct: +((1 - after / base) * 100).toFixed(1),
  byShape: rowsOut(byShape),
  byStep: rowsOut(byStep),
}, null, 1)}\n`)
process.stdout.write('profile-done\n')
