/**
 * 跨调用增量层的测试。
 *
 * 这一层要证明的是"同一次调用看第二遍时只给变化"，以及**变化很大时不硬做增量**。
 *
 * @module dsh-context-guard/test/replay
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { ReplayStore, diffIncremental, renderDelta, renderIdentical } from '../lib/replay.js'
import { applyIncremental } from '../lib/policy.js'

/** 造一段 n 行的日志。 */
function log(n, start = 0) {
  const out = []
  for (let i = start; i < start + n; i += 1) out.push(`2026-01-01 10:00:${String(i % 60).padStart(2, '0')} INFO job step ${i}`)
  return out.join('\n')
}

test('ReplayStore 按工具名 + 参数记账，并遵守容量上限', () => {
  const store = new ReplayStore({ maxEntries: 2 })
  const keyA = ReplayStore.key('bash', { command: 'ls' })
  const keyB = ReplayStore.key('bash', { command: 'pwd' })
  const keyC = ReplayStore.key('bash', { command: 'whoami' })
  store.set(keyA, 'a', '1')
  store.set(keyB, 'b', '2')
  assert.equal(store.get(keyA).text, 'a')
  store.set(keyC, 'c', '3')
  assert.equal(store.size, 2)
  // keyB 是插入最早且未被访问的，应被淘汰。
  assert.equal(store.get(keyB), undefined)
  assert.equal(store.get(keyC).text, 'c')
})

test('ReplayStore 区分参数', () => {
  assert.notEqual(ReplayStore.key('read', { path: '/a' }), ReplayStore.key('read', { path: '/b' }))
  assert.equal(ReplayStore.key('read', { path: '/a' }), ReplayStore.key('read', { path: '/a' }))
})

test('diffIncremental 认出"只是追加"', () => {
  const before = log(20)
  const after = `${before}\n2026-01-01 10:00:20 INFO job step 20`
  const info = diffIncremental(before, after)
  assert.equal(info.kind, 'delta')
  assert.equal(info.changed, 1)
  assert.equal(info.prefix, 20)
})

test('diffIncremental 认出"完全没变"', () => {
  assert.equal(diffIncremental(log(20), log(20)).kind, 'identical')
})

test('diffIncremental 变化太大时拒绝', () => {
  const before = log(100)
  const after = log(100, 5000)
  assert.equal(diffIncremental(before, after), null)
})

test('renderIdentical 给出说明与指纹', () => {
  const marker = renderIdentical('a\nb')
  assert.match(marker, /unchanged/)
  assert.match(marker, /2 lines/)
  assert.match(marker, /[0-9a-f]{12}/)
})

test('renderDelta 给出未变行数与逐字变动行', () => {
  const before = 'a\nb\nc\nd'
  const after = 'a\nb\nCHANGED\nd'
  const info = diffIncremental(before, after)
  const rendered = renderDelta(before, after, info)
  assert.match(rendered, /3 lines unchanged/)
  assert.match(rendered, /- c/)
  assert.match(rendered, /\+ CHANGED/)
  assert.match(rendered, /1 unchanged line/)
})

test('applyIncremental 对太短的内容不做增量', () => {
  const applied = applyIncremental('short', 'short', { minChars: 600 })
  assert.equal(applied.mode, 'none')
})

test('applyIncremental 对相同的大内容给标记', () => {
  const applied = applyIncremental(log(200), log(200), { minChars: 600 })
  assert.equal(applied.mode, 'identical')
  assert.ok(applied.text.length < 120)
})

test('applyIncremental 对追加式增长给增量', () => {
  const before = log(200)
  const after = `${before}\n2026-01-01 10:00:59 INFO job step 259`
  const applied = applyIncremental(before, after, { minChars: 600 })
  assert.equal(applied.mode, 'delta')
  assert.ok(applied.text.includes('+ 2026-01-01 10:00:59 INFO job step 259'))
  assert.ok(applied.text.length < before.length / 4)
})
