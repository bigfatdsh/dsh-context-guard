/**
 * 基准：在语料上量出真实的省量，并把**安全不变量**一起跑掉。
 *
 * 用法：
 *   node tools/bench.mjs            打印表格
 *   node tools/bench.mjs --json     打印 JSON（给 CI / 记录用）
 *
 * 每个语料都检查三条硬不变量：
 * 1. `NEVER GROWS` —— 压缩后字符数不得大于原文（反悔闸门）。
 * 2. `MUST KEEP` —— "丢了就等于丢任务"的行必须逐字还在：报错、断言、期望/实际、
 *    diff 的增删行、hunk 头。
 * 3. `NO OVER-CLAIM` —— 标记里声明的省略行数**不得超过**实际少掉的行数。
 *    （少报是允许的：JSON 压行这类纯排版压缩不涉及内容省略，不该写标记。）
 *
 * @module dsh-meta-optimizer/tools/bench
 */

import { corpus } from './corpus.mjs'
import { optimizeContent } from '../lib/policy.js'
import { normalizeText } from '../lib/text.js'
import { estimateText } from '../lib/tokens.js'

/** 任何内容里都必须逐字保留的行。 */
const MUST_KEEP = [
  /\b(?:error|Error|ERROR|failed|Failed|FAILED|panic|fatal|FATAL|exception|Exception|Traceback)\b/,
  /^not ok\b/,
  /\b(?:expected|actual|AssertionError)\b/i,
  /\bERR_[A-Z_]+\b|\bE\d{3,4}\b/,
]

/**
 * 只有 diff 语料才要求保留的行：hunk 头与增删行。
 *
 * 单独分开是因为 `+` / `-` 开头的行在别的输出里到处都是（`ls -l` 的权限列就是 `-rw-r--r--`），
 * 混在一起会把权限列误判成"丢掉的 diff 内容"。
 */
const MUST_KEEP_DIFF = [/^@@ /, /^[+-](?![+-])\S/]

/** 折掉/省略的标记，以及它声明的行数。 */
const MARKERS = [
  /…\s*\((\d+) lines? omitted/,
  /…\s*\u00d7(\d+) \(same/,
  /…\s*\((\d+) progress lines\)/,
  /…\s*\((\d+) unchanged context lines?\)/,
]

/**
 * 数出结果里"声明被折掉/省略"的行数总和。
 *
 * 这是本插件对模型的核心承诺：**少了几行，就必须有几行的说明**。所以基准不数标记个数，
 * 而是把标记声明的数字加起来，和"原文行数 − 结果行数"对账。
 *
 * @param text - 压缩后的文本。
 * @returns 声明丢掉的行数。
 */
function declaredGone(text) {
  let total = 0
  for (const line of text.split('\n')) {
    for (const pattern of MARKERS) {
      const match = pattern.exec(line)
      if (match !== null) {
        total += Number.parseInt(match[1], 10)
        break
      }
    }
  }
  return total
}

/**
 * 一行是否必须保留。
 *
 * @param line - 一行文本。
 * @param kind - 语料类型。
 * @returns 必须保留返回 true。
 */
function isMustKeep(line, kind) {
  if (line.trim().length === 0) return false
  if (MUST_KEEP.some((re) => re.test(line))) return true
  return kind === 'diff' && MUST_KEEP_DIFF.some((re) => re.test(line))
}

/**
 * 判断一行是否在结果里"仍有交代"。
 *
 * 逐字出现当然算。此外，**被折叠的重复行**也算：结果里会写成 `原文 ×N`，说明
 * "这一行重复了 N 次"，信息并没有消失（只是不再重复贴 N 遍）。
 *
 * @param line - 原文里的一行。
 * @param after - 压缩后的整段文本。
 * @returns 有交代返回 true。
 */
function stillPresent(line, after) {
  if (after.includes(line)) return true
  const trimmed = line.trim()
  for (const candidate of after.split('\n')) {
    const marker = /\u00d7(\d+) \(same (?:line|event) repeated/.exec(candidate)
    if (marker === null) continue
    const head = candidate.slice(0, marker.index).trim()
    if (head === trimmed) return true
    // 行内标记的形态是 `原文 … ×N`，中间可能还有省略号。
    const body = head.replace(/\s*…\s*$/, '').trim()
    if (body === trimmed) return true
    // 模板折叠（只有数字/时间戳不同）：抹掉变量后相等也算。
    if (body.replace(/\d+/g, '#') === trimmed.replace(/\d+/g, '#')) return true
  }
  return false
}

/** 主流程。 */
function main() {
  const asJson = process.argv.includes('--json')
  const rows = []
  let totalBefore = 0
  let totalAfter = 0
  let failures = 0

  for (const entry of corpus()) {
    const content = [{ type: 'text', text: entry.text }]
    const result = optimizeContent({ tool: entry.tool, content }, {})
    const after = result.content.map((block) => block.text).join('\n')
    // 拿**规范化之后**的原文做基准：插件本来就允许去掉行尾空白/压缩空行，
    // 用原始字节去比会把这些无害差异误判成"信息丢失"。
    const reference = normalizeText(entry.text, { maxBlankRun: 1 })
    const mustKeep = reference.split('\n').filter((line) => isMustKeep(line, entry.kind))
    const lost = mustKeep.filter((line) => !stillPresent(line, after))
    const eliminated = entry.text.split('\n').length - after.split('\n').length
    const marks = declaredGone(after)
    // 硬不变量：**绝不虚报**（声明数不能超过实际少掉的行数）。少报是允许的：
    // 有些压缩是纯排版（JSON 压行、列表列压缩），不涉及内容省略，不需要标记。
    const disclosed = eliminated <= 0 || marks <= eliminated
    const grew = after.length > entry.text.length
    const tokensBefore = estimateText(entry.text)
    const tokensAfter = estimateText(after)
    totalBefore += tokensBefore
    totalAfter += tokensAfter
    if (lost.length > 0 || grew || !disclosed) failures += 1
    rows.push({
      id: entry.id,
      kind: result.kind,
      steps: result.steps.join('+') || '-',
      before: entry.text.length,
      after: after.length,
      savedPct: entry.text.length === 0 ? 0 : Math.round((1 - after.length / entry.text.length) * 1000) / 10,
      tokensBefore,
      tokensAfter,
      mustKeep: mustKeep.length,
      lost: lost.length,
      grew,
      disclosed,
      marks,
      eliminated,
    })
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          rows,
          totals: {
            before: totalBefore,
            after: totalAfter,
            savedPct: totalBefore === 0 ? 0 : Math.round((1 - totalAfter / totalBefore) * 1000) / 10,
            failures,
          },
        },
        null,
        1,
      )}\n`,
    )
  } else {
    const header = ['corpus', 'kind', 'steps', 'chars', 'est.tokens', 'saved', 'must-keep', 'lost', 'flag']
    const table = rows.map((row) => [
      row.id,
      row.kind,
      row.steps,
      `${row.before}→${row.after}`,
      `${row.tokensBefore}→${row.tokensAfter}`,
      `${row.savedPct}%`,
      String(row.mustKeep),
      String(row.lost),
      row.grew ? 'GREW' : row.disclosed ? '' : `OVER-CLAIM(${row.marks} declared / ${row.eliminated} gone)`,
    ])
    const widths = header.map((title, index) =>
      Math.max(title.length, ...table.map((line) => String(line[index]).length)),
    )
    const render = (line) => line.map((cell, index) => String(cell).padEnd(widths[index])).join('  ')
    process.stdout.write(`${render(header)}\n`)
    process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`)
    for (const line of table) process.stdout.write(`${render(line)}\n`)
    const saved = totalBefore === 0 ? 0 : Math.round((1 - totalAfter / totalBefore) * 1000) / 10
    process.stdout.write(
      `\ntotal: ${totalBefore} → ${totalAfter} est. tokens (${saved}% saved), 不变量失败 ${failures} 条\n`,
    )
  }
  if (failures > 0) process.exitCode = 1
}

main()
