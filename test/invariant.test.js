/**
 * 不变量测试：把"绝不虚报"这条承诺钉成回归测试。
 *
 * 插件对模型的核心承诺是：**少了几行，就写了几行**。标记里声明的省略行数永远不能超过
 * 结果相对原文实际少掉的行数——虚报会让模型以为有内容被藏起来了，比多花几个 token 更糟。
 *
 * 这里直接跑 `tools/corpus.mjs` 的全套语料（含真实抓取的输出），逐条核对。
 *
 * @module dsh-meta-optimizer/test/invariant
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { corpus } from '../tools/corpus.mjs'
import { markerReport, optimizeContent, planText } from '../lib/policy.js'
import { isCompactableText, normalizeText } from '../lib/text.js'
import { estimateContent } from '../lib/tokens.js'

/** 高信息量行：任何内容里丢了都等于丢任务。 */
const MUST_KEEP = [
  /\b(?:error|Error|ERROR|failed|Failed|FAILED|panic|fatal|FATAL|exception|Exception|Traceback)\b/,
  /^not ok\b/,
  /\b(?:expected|actual|AssertionError)\b/i,
]

/**
 * 只有 diff 语料才要求保留的行。
 *
 * `+` / `-` 开头的行在别的输出里到处都是（`ls -l` 的权限列就是 `-rw-r--r--`），
 * 混在一起会把权限列误判成"丢了的 diff 内容"。
 */
const MUST_KEEP_DIFF = [/^@@ /, /^[+-](?![+-])\S/]

test('语料：绝不虚报省略行数', () => {
  for (const entry of corpus()) {
    const plan = planText(entry.text, { tool: entry.tool, options: {} })
    const gone = entry.text.split('\n').length - plan.text.split('\n').length
    const report = markerReport(plan.text)
    // `gone` 可以是负的：超长行被拆成多行时结果行数**变多**（那是合法省略标记换来的，
    // 一行都没丢）。此时不存在"虚报"的可能，跳过。
    if (gone < 0) continue
    assert.ok(
      report.lines <= gone,
      `${entry.id}: 声明省略 ${report.lines} 行，实际只少 ${gone} 行`,
    )
  }
})

test('语料：结果永远不变大', () => {
  for (const entry of corpus()) {
    const plan = planText(entry.text, { tool: entry.tool, options: {} })
    assert.ok(plan.text.length <= entry.text.length, `${entry.id}: 压缩后变大了`)
  }
})

test('语料：报错、断言、diff 增删行逐字保留', () => {
  for (const entry of corpus()) {
    const reference = normalizeText(entry.text, { maxBlankRun: 1 })
    const plan = planText(reference, { tool: entry.tool, options: {} })
    const patterns = entry.kind === 'diff' ? [...MUST_KEEP, ...MUST_KEEP_DIFF] : MUST_KEEP
    const lines = reference.split('\n').filter((line) => patterns.some((re) => re.test(line)))
    for (const line of lines) {
      // 这一行本身可能是一条**已折叠**的记录（语料里就有 `… ×4` 这种历史标记）：
      // 那种情况下它代表的多行原文没有逐字留在结果里，这是折叠的定义，不是丢信息。
      const foldMark = /\u2026 \u00d7(\d+) \(/.exec(line)
      const foldedAway = foldMark !== null && Number(foldMark[1]) >= 2
      // 用**词序列**比较，不用逐字：规范化会动空白形状（`INFO  handled` → `INFO handled`），
      // 那是形状不是内容。内容必须一个词都不少。
      const words = line.replace(/\u2026 \u00d7\d+ \([^)]*\)/g, '').trim().split(/\s+/).filter(Boolean)
      const outWords = new Set(plan.text.replace(/\u2026 \[\d+ more chars\]/g, '').split(/\s+/))
      const kept = words.every((word) => outWords.has(word))
      const folded = plan.text.split('\n').some((candidate) => {
        const match = /×\d+ \(same/.exec(candidate)
        return match !== null && candidate.slice(0, match.index).trim() === line.trim()
      })
      assert.ok(kept || folded || foldedAway, `${entry.id}: 丢了高信息量行 ${JSON.stringify(line)}`)
    }
  }
})

test('语料：全是二进制的输入原样返回', () => {
  const binary = 'a\u0000b\u0000c\u0000d'
  const plan = planText(binary, { tool: 'bash', options: {} })
  assert.equal(plan.text, binary)
})

test('净收益闸门：省得不够就原样返回', () => {
  const text = 'a'.repeat(1000)
  const result = optimizeContent({ tool: 'bash', content: [{ type: 'text', text }] }, { minSavingRatio: 0.99 })
  assert.equal(result.changed, false)
  assert.equal(result.saved, 0)
})

test('总账口径：saved 等于前后估算 token 之差', () => {
  for (const entry of corpus()) {
    const result = optimizeContent({ tool: entry.tool, content: [{ type: 'text', text: entry.text }] }, {})
    assert.equal(result.saved, result.tokensBefore - result.tokensAfter, `${entry.id}: 账不对`)
    assert.equal(result.tokensBefore, estimateContent([{ type: 'text', text: entry.text }]))
    assert.ok(isCompactableText(entry.text) || !result.changed)
  }
})

test('近似幂等：对已经压缩过的结果再压一次基本不再缩小', () => {
  for (const entry of corpus()) {
    if (entry.kind === 'json') continue
    const once = planText(entry.text, { tool: entry.tool, options: {} }).text
    const twice = planText(once, { tool: entry.tool, options: {} }).text
    // 允许 1% 的差：规范化与标记行本身还会被再规整一次，但不该出现"压了又压"的雪崩。
    assert.ok(
      twice.length >= once.length * 0.99,
      `${entry.id}: 二次压缩仍在明显缩小（${once.length} → ${twice.length}，可疑）`,
    )
  }
})
