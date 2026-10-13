/**
 * 预算层与策略层的测试。
 *
 * 这一层最需要证明的两件事：
 * 1. **永远不会变大**（省不下来就原样返回）；
 * 2. **高信息量的行不会被丢**（报错、路径、断言必须活下来）。
 *
 * @module dsh-context-guard/test/policy
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { compactJsonText, scoreLine, selectWithinBudget } from '../lib/budget.js'
import { renderUnits, toUnits } from '../lib/units.js'
import { renderMarker } from '../lib/policy.js'
import { budgetFor, optimizeContent, planText } from '../lib/policy.js'
import { estimateContent } from '../lib/tokens.js'

const lines = (text) => text.split('\n')
const text = (content) => content.map((block) => block.text).join('\n')

test('scoreLine 给报错行高分、给版权行低分', () => {
  const total = 10
  assert.ok(scoreLine('ERROR: cannot find module "x"', 5, total) > scoreLine('Copyright 2026 Someone', 5, total))
  assert.ok(scoreLine('  at run (/app/src/a.js:12:3)', 5, total) > scoreLine('', 5, total))
  assert.ok(scoreLine('last', total - 1, total) > scoreLine('middle', 5, total))
})

test('selectWithinBudget 保住头尾并标出省略行数', () => {
  const input = []
  for (let i = 0; i < 200; i += 1) input.push(`line ${i} ${'x'.repeat(40)}`)
  const out = selectWithinBudget(toUnits(input), { budgetChars: 800, headLines: 2, tailLines: 2 })
  assert.ok(out.dropped > 0)
  const settled = renderUnits(out.list, renderMarker).split('\n')
  assert.equal(settled[0], input[0])
  assert.equal(settled[settled.length - 1], input[199])
  assert.ok(settled.some((line) => /omitted/.test(line)))
  // 承诺：省下的行数必须写在标记里，且不能比实际少掉的多。
  const declared = settled.reduce((sum, line) => {
    const match = /… \((\d+) lines? omitted/.exec(line)
    return sum + (match === null ? 0 : Number.parseInt(match[1], 10))
  }, 0)
  assert.equal(declared, out.dropped)
})

test('selectWithinBudget 预算够时一行不动', () => {
  const input = ['a', 'b']
  assert.equal(selectWithinBudget(toUnits(input), { budgetChars: 100, headLines: 1, tailLines: 1 }).dropped, 0)
})

test('selectWithinBudget 优先保留报错行', () => {
  const input = []
  for (let i = 0; i < 300; i += 1) input.push(`noise ${i} ${'.'.repeat(60)}`)
  input[150] = 'ERROR: the one line that matters'
  const out = selectWithinBudget(toUnits(input), { budgetChars: 600, headLines: 1, tailLines: 1 })
  assert.ok(renderUnits(out.list, renderMarker).includes('ERROR: the one line that matters'))
})

test('compactJsonText 压掉缩进且内容等价', () => {
  const source = JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: 'x' } }, null, 2)
  const compacted = compactJsonText(source, { indent: 0 })
  assert.deepEqual(JSON.parse(compacted), JSON.parse(source))
  assert.ok(compacted.length < source.length)
  assert.ok(!compacted.includes('\n'))
})

test('compactJsonText 长数组换行但保留全部元素', () => {
  const value = { items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item ${i}` })) }
  const source = JSON.stringify(value, null, 2)
  const compacted = compactJsonText(source, { indent: 2 })
  assert.deepEqual(JSON.parse(compacted), value)
  assert.ok(compacted.length < source.length)
})

test('budgetFor 的优先级：单工具覆盖 > min(工具预设, 全局) > 预设 > 默认', () => {
  // 单工具覆盖最优先
  assert.equal(budgetFor('read', { read: 555 }, 1000), 555)
  // 用户显式设的全局值**必须**压过工具预设（否则配了等于没配）
  assert.equal(budgetFor('read', {}, 1000), 1000)
  assert.equal(budgetFor('bash', {}, 100000), 100000)
  // 没有预设的工具直接用全局值
  assert.equal(budgetFor('unknown-tool', {}, 1000), 1000)
  // 都没有就用默认
  assert.equal(budgetFor('unknown-tool', {}, undefined), 1500)
})

test('planText 不会把文本变大', () => {
  const samples = [
    '\u001B[31mred\u001B[0m\n\n\n\nplain   ',
    JSON.stringify({ a: [1, 2, 3], b: { c: 'd' } }, null, 2),
    'a\n'.repeat(50),
    'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n',
  ]
  for (const sample of samples) {
    const plan = planText(sample, { tool: 'bash', budgetTokens: 25000, options: {} })
    assert.ok(plan.text.length <= sample.length, `变大了: ${JSON.stringify(sample.slice(0, 40))}`)
  }
})

test('planText 拒绝二进制并原样返回', () => {
  const binary = 'aaa\u0000bbb\u0000ccc'
  const plan = planText(binary, { tool: 'bash', budgetTokens: 25, options: {} })
  assert.equal(plan.text, binary)
  assert.deepEqual(plan.steps, [])
})

test('planText 在 read 上不做结构改写', () => {
  const listing =
    '-rw-r--r--  1 user  staff  1234 Oct  1 10:00 a.txt\n' +
    '-rw-r--r--  1 user  staff  2345 Oct  1 10:00 b.txt\n' +
    '-rw-r--r--  1 user  staff  3456 Oct  1 10:00 c.txt\n' +
    '-rw-r--r--  1 user  staff  4567 Oct  1 10:00 d.txt'
  const plan = planText(listing, { tool: 'read', budgetTokens: 25000, options: {} })
  assert.ok(!plan.steps.includes('listing-columns'))
})

test('optimizeContent 报告前后 token 并且不放大', () => {
  const payload = JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item-${i}` })) }, null, 2)
  const result = optimizeContent({ tool: 'bash', content: [{ type: 'text', text: payload }] }, {})
  assert.ok(result.saved > 0)
  assert.ok(result.tokensAfter < result.tokensBefore)
  assert.ok(result.charsAfter < result.charsBefore)
  assert.ok(result.steps.includes('json-compact'))
})

test('optimizeContent 不碰富内容块', () => {
  const image = { type: 'image', data: 'AAAA', mediaType: 'image/png' }
  const result = optimizeContent(
    { tool: 'read', content: [image, { type: 'text', text: 'x'.repeat(2000) }] },
    { budgetTokens: 50 },
  )
  assert.deepEqual(result.content[0], image)
})

test('optimizeContent 的净收益是总账（含未被压缩的块）', () => {
  const content = [{ type: 'image', data: 'A'.repeat(4000) }, { type: 'text', text: 'short' }]
  const before = estimateContent(content)
  const result = optimizeContent({ tool: 'bash', content }, {})
  assert.equal(result.tokensBefore, before)
  assert.ok(result.saved <= before)
})

test('预算裁剪会保留报错行并标注省略', () => {
  // 刻意用高熵内容：不能让日志折叠抢先把它压掉，否则测不到预算层。
  let seed = 7
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed.toString(36)
  }
  const body = []
  for (let i = 0; i < 400; i += 1) body.push(`entry ${next()}${next()} key=${next()} payload ${next()}`)
  body[200] = 'ERROR: could not resolve dependency "left-pad"'
  const plan = planText(body.join('\n'), { tool: 'bash', budgetTokens: 225, options: {} })
  assert.ok(plan.steps.includes('budget'), `steps=${plan.steps.join(',')}`)
  assert.ok(plan.text.includes('ERROR: could not resolve dependency "left-pad"'))
  assert.match(plan.text, /lines omitted/)
  assert.ok(plan.text.length < body.join('\n').length / 4)
})

test('保守档只做规范化', () => {
  const payload = JSON.stringify({ a: 1, b: [1, 2] }, null, 4)
  const plan = planText(payload, { tool: 'bash', budgetTokens: 25000, options: { conservative: true } })
  assert.ok(!plan.steps.includes('json-compact'))
})
