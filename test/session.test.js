import assert from 'node:assert/strict'
import test from 'node:test'

import { resetLedgers, ledgerFor, dedupeAcrossResults, advance } from '../lib/session.js'
import { renderMarker } from '../lib/policy.js'
import { renderUnits, toUnits } from '../lib/units.js'

/** 造一批互不相同的长行。 */
const lines = (n, tag = '') => {
  const out = []
  for (let i = 0; i < n; i += 1) {
    out.push(`  const resolvedFieldNumber${i} = normalizeIncomingValue(raw.field${i}${tag}, defaults.field${i})`)
  }
  return out
}

test('跨结果去重：上文出现过的长行换成引用', () => {
  resetLedgers()
  const ledger = ledgerFor({})
  const first = lines(20).join('\n')
  const second = lines(20).join('\n')

  const a = dedupeAcrossResults(toUnits(first.split('\n')), ledger, {})
  assert.equal(a.refs, 0, '第一条必须原样显示')
  advance(ledger, renderUnits(a.list, renderMarker), 40)

  const b = dedupeAcrossResults(toUnits(second.split('\n')), ledger, {})
  assert.equal(b.refs, 20, '第二条的 20 行都该换成引用')
  const text = renderUnits(b.list, renderMarker)
  assert.match(text, /\[S1\] seen above/)
  assert.ok(b.savedChars > 0)
})

test('同一结果内部不互相引用', () => {
  resetLedgers()
  const ledger = ledgerFor({})
  // 同一行在结果里出现两次：第一次原样，第二次才允许引用
  const repeated = `  const duplicatedLongLine = computeSomethingFrom(raw, defaults)\n${'  const duplicatedLongLine = computeSomethingFrom(raw, defaults)'}`
  const a = dedupeAcrossResults(toUnits(repeated.split('\n')), ledger, {})
  // 本结果内部还没有"上文"可引，所以一次都不该引用；那条行原样出现两次。
  assert.equal(a.refs, 0, '结果内部不该互相引用')
  const text = renderUnits(a.list, renderMarker)
  assert.equal(text.split('\n').filter((l) => l.includes('duplicatedLongLine')).length, 2)
  advance(ledger, text, 40)
})

test('结构行与高信息量行不被换成引用', () => {
  resetLedgers()
  const ledger = ledgerFor({})
  const keep = ['}', ');', '  at run (/app/a.js:12:3)', 'ERROR: something went wrong in the pipeline']
  const big = '  const aVeryLongOrdinaryLine = computeSomethingFromTheConfiguration(raw, defaults)'
  // 先让这些行进账本
  const first = [big, ...keep].join('\n')
  const a = dedupeAcrossResults(toUnits(first.split('\n')), ledger, {})
  advance(ledger, renderUnits(a.list, renderMarker), 40)
  // 再来一次：普通长行会被引用，结构行与报错行必须原样
  const b = dedupeAcrossResults(toUnits(first.split('\n')), ledger, {})
  const text = renderUnits(b.list, renderMarker)
  assert.equal(b.refs, 1, '只有那一条普通长行该被引用')
  for (const line of keep) assert.ok(text.includes(line), `结构行/报错行被换掉了: ${line}`)
})

test('引用比正文长时不换', () => {
  resetLedgers()
  const ledger = ledgerFor({})
  // 正文只比引用长一点点：换过去省不下多少，判据是"引用必须比正文短"。
  const short = '  const abcdef = computeIt(raw)'
  const a = dedupeAcrossResults(toUnits(short.split('\n')), ledger, { minChars: 16 })
  advance(ledger, renderUnits(a.list, renderMarker), 16)
  const b = dedupeAcrossResults(toUnits(short.split('\n')), ledger, { minChars: 16 })
  assert.equal(b.refs, 0, '引用比正文长或差不多时不该换')
})

test('不同 agent 各记一本账', () => {
  resetLedgers()
  const one = {}
  const two = {}
  const text = lines(20).join('\n')
  const a = dedupeAcrossResults(toUnits(text.split('\n')), ledgerFor(one), {})
  advance(ledgerFor(one), renderUnits(a.list, renderMarker), 40)
  const b = dedupeAcrossResults(toUnits(text.split('\n')), ledgerFor(two), {})
  assert.equal(b.refs, 0, '另一个 agent 的账本是空的')
  const c = dedupeAcrossResults(toUnits(text.split('\n')), ledgerFor(one), {})
  assert.equal(c.refs, 20, '同一个 agent 的账本记着')
})
