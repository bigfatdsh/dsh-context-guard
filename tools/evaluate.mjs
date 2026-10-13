/**
 * 全面测评：真实语料 + 对抗性输入，把每一项单独量出来。
 *
 * 输出一行 JSON（避免展示层把重复行折叠），由调用方解析。
 *
 * @module dsh-context-guard/tools/evaluate
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_BUDGET_TOKENS, DEFAULT_KEEP_RATIO, DEFAULT_MIN_KEEP_TOKENS, optimizeContent, planText, markerReport } from '../lib/policy.js'
import { estimateContent } from '../lib/tokens.js'
import { normalizeText } from '../lib/text.js'
import { corpus } from './corpus.mjs'

const dir = process.env.DSH_CORPUS_DIR ?? join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', '.corpus', 'raw')

/** 出厂默认档（与 lib/schema.js 同源）。 */
const DEFAULTS = { keepRatio: DEFAULT_KEEP_RATIO, minKeepTokens: DEFAULT_MIN_KEEP_TOKENS }

const SIGNAL = [
  /\b(?:error|Error|ERROR|failed|Failed|FAILED|panic|fatal|FATAL|Traceback)\b/,
  /^not ok\b/,
  /\b(?:assert|expected|actual|AssertionError)\b/i,
  /\bERR_[A-Z_]+\b|\bE\d{3,4}\b/,
  /:\d+:\d+/,
  /\bexit code\b|\bexit status\b/,
]
const IDX = /[A-Za-z_][A-Za-z0-9_.-]{3,}|[A-Za-z0-9_.-]+\/[\w./-]+|\d{4,}|[\u4e00-\u9fff]{2,}/g
const index = (text) => {
  const set = new Set()
  for (const m of text.matchAll(IDX)) set.add(m[0])
  return set
}
const textOf = (content) => content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')

/** 读真实语料。 */
function loadReal() {
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
  return rows.map((e) => ({
    tool: names.get(e.data.message.toolCallId) ?? 'unknown',
    content: e.data.message.content,
  }))
}

const report = { sections: {} }

// ── 1. 真实语料：每个工具单独量 ────────────────────────────────────────────
{
  const rows = loadReal()
  const byTool = new Map()
  let base = 0
  let after = 0
  let lossy = 0
  let overClaim = 0
  let grew = 0
  let changed = 0
  const times = []
  for (const row of rows) {
    const text = textOf(row.content)
    const before = estimateContent(row.content)
    if (before < 30) continue
    base += before
    const started = process.hrtime.bigint()
    const r = optimizeContent({ tool: row.tool, content: row.content, isError: false }, DEFAULTS)
    times.push(Number(process.hrtime.bigint() - started) / 1e6)
    const at = estimateContent(r.content)
    after += at
    if (r.changed) changed++
    if (at > before) grew++
    const outText = textOf(r.content)
    const rep = markerReport(outText)
    const gone = text.split('\n').length - outText.split('\n').length
    if (rep.lines > gone) overClaim++
    const have = index(outText)
    let missing = 0
    for (const line of text.split('\n')) {
      if (!line.trim() || !SIGNAL.some((re) => re.test(line))) continue
      for (const t of index(line)) if (!have.has(t)) missing++
    }
    if (missing > 0) lossy++
    const bucket = byTool.get(row.tool) ?? { n: 0, base: 0, after: 0, lossy: 0 }
    bucket.n++; bucket.base += before; bucket.after += at
    if (missing > 0) bucket.lossy++
    byTool.set(row.tool, bucket)
  }
  times.sort((a, b) => a - b)
  const pct = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))]
  report.sections.realCorpus = {
    results: rows.length,
    baseTokens: base,
    afterTokens: after,
    savedPct: +((1 - after / base) * 100).toFixed(1),
    changed,
    invariants: { overClaim, grew, lossy },
    latencyMs: { p50: +pct(0.5).toFixed(2), p90: +pct(0.9).toFixed(2), p99: +pct(0.99).toFixed(2), max: +times[times.length - 1].toFixed(1) },
    byTool: [...byTool.entries()].sort((a, b) => b[1].base - a[1].base).slice(0, 12).map(([tool, k]) => ({
      tool, n: k.n, base: k.base, after: k.after,
      savedPct: +((1 - k.after / k.base) * 100).toFixed(1), lossy: k.lossy,
    })),
  }
}

// ── 2. 合成语料：类型覆盖面 ────────────────────────────────────────────────
{
  const rows = []
  for (const entry of corpus()) {
    const r = optimizeContent({ tool: entry.tool, content: [{ type: 'text', text: entry.text }], isError: false }, DEFAULTS)
    const before = estimateContent([{ type: 'text', text: entry.text }])
    const after = estimateContent(r.content)
    rows.push({ id: entry.id, before, after, savedPct: +((1 - after / before) * 100).toFixed(1), steps: r.steps.join('+') || '-', grew: after > before })
  }
  report.sections.synthetic = rows
}

// ── 3. 闸门行为（该透传的一律透传） ─────────────────────────────────────────
{
  const big = 'x'.repeat(50000)
  const huge = JSON.stringify({ a: Array.from({ length: 400 }, (_, i) => ({ i, s: 'y'.repeat(40) })) }, null, 2)
  const cases = [
    ['错误结果', { tool: 'bash', content: [{ type: 'text', text: huge }], isError: true }],
    ['开关关闭', { tool: 'bash', content: [{ type: 'text', text: huge }], isError: false }],
    ['短结果', { tool: 'bash', content: [{ type: 'text', text: 'short' }], isError: false }],
    ['黑名单工具(skipTools)', { tool: 'bash', content: [{ type: 'text', text: huge }], isError: false }, { ...DEFAULTS, skipTools: ['bash'] }],
    ['高风险工具(read)', { tool: 'read', content: [{ type: 'text', text: huge }], isError: false }],
    ['二进制内容', { tool: 'bash', content: [{ type: 'text', text: `a\u0000${big}` }], isError: false }],
    ['只有富内容块', { tool: 'bash', content: [{ type: 'image', data: big }], isError: false }],
  ]
  const out = []
  for (const [name, input, override] of cases) {
    const options = override ?? (name === '开关关闭' ? { enabled: false } : DEFAULTS)
    const r = optimizeContent(input, options)
    out.push({ case: name, changed: r.changed, saved: r.saved, steps: r.steps.join('+') || '-' })
  }
  report.sections.gates = out
}

// ── 4. 对抗性输入：不允许抛错、不允许放大 ──────────────────────────────────
{
  const cases = [
    ['空字符串', ''],
    ['只有换行', '\n'.repeat(5000)],
    ['单个超长行', 'a'.repeat(200000)],
    ['纯 ANSI', '\u001B[31m'.repeat(10000)],
    ['大量 \\r', 'progress\r'.repeat(20000)],
    ['嵌套 JSON 到极限', JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ i, a: { b: { c: [1, 2, 3] } } })))],
    ['未闭合 JSON', '{"a": [1, 2,'.repeat(2000)],
    ['全是分隔线', '=====\n'.repeat(5000)],
    ['超长行 + 高信息', `${'z'.repeat(100000)}\nERROR: boom\n${'z'.repeat(100000)}`],
    ['只有 emoji', '🎉'.repeat(50000)],
    ['CRLF 混合', 'line\r\n'.repeat(20000)],
    ['制表符表格', Array.from({ length: 2000 }, (_, i) => `col1\tcol2\t${i}`).join('\n')],
    ['base64 大块', 'A'.repeat(200000)],
    ['全角空格', '\u3000'.repeat(50000)],
  ]
  const out = []
  for (const [name, text] of cases) {
    let threw = null
    let grew = null
    let saved = null
    try {
      const r = optimizeContent({ tool: 'bash', content: [{ type: 'text', text }], isError: false }, DEFAULTS)
      const before = estimateContent([{ type: 'text', text }])
      const after = estimateContent(r.content)
      grew = after > before
      saved = before - after
    } catch (error) {
      threw = String(error?.message ?? error)
    }
    out.push({ case: name, threw, grew, saved })
  }
  report.sections.adversarial = out
}

// ── 5. 幂等：连压三次只看第一次 ────────────────────────────────────────────
{
  const rows = []
  for (const entry of corpus()) {
    const first = planText(normalizeText(entry.text, { maxBlankRun: 1 }), { tool: entry.tool, budgetTokens: DEFAULT_BUDGET_TOKENS, options: { keepRatio: DEFAULT_KEEP_RATIO, minKeepTokens: DEFAULT_MIN_KEEP_TOKENS } })
    const second = planText(first.text, { tool: entry.tool, budgetTokens: DEFAULT_BUDGET_TOKENS, options: { keepRatio: DEFAULT_KEEP_RATIO, minKeepTokens: DEFAULT_MIN_KEEP_TOKENS } })
    const third = planText(second.text, { tool: entry.tool, budgetTokens: DEFAULT_BUDGET_TOKENS, options: { keepRatio: DEFAULT_KEEP_RATIO, minKeepTokens: DEFAULT_MIN_KEEP_TOKENS } })
    rows.push({ id: entry.id, l1: first.text.length, l2: second.text.length, l3: third.text.length, drift: third.text.length - second.text.length })
  }
  report.sections.idempotence = rows
}

writeFileSync(process.env.EVAL_OUT ?? '/tmp/evaluate.json', `${JSON.stringify(report, null, 1)}\n`)
process.stdout.write('eval-done\n')
