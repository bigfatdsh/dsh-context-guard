/**
 * 结构化压缩器的测试。
 *
 * 重点不在"压得狠"，而在**压得对**：每个用例都断言"该保留的一个都没少"。
 *
 * @module dsh-context-guard/test/compact
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  compactBuild,
  compactDiff,
  compactListing,
  compactLog,
  compactStatus,
  compactTree,
  dropNoise,
  foldRepeats,
  foldRuns,
  templateOf,
} from '../lib/compact.js'
import { renderUnits, toUnits } from '../lib/units.js'
import { renderMarker } from '../lib/policy.js'

/**
 * 压缩器之间用单位传递行数，标记最后由 renderUnits 结算。
 * 测试里统一走这个包装，等价于 policy 里的真实顺序。
 *
 * @param list - 单位数组。
 * @returns 文本行数组（标记已渲染成文案）。
 */
const settle = (list) => renderUnits(list, renderMarker).split('\n')

/** 把文本行包成单位。 */
const u = (lines) => toUnits(lines)

const lines = (text) => text.split('\n')

test('foldRuns 折叠连续重复行', () => {
  const input = u(['a', 'same', 'same', 'same', 'same', 'b'])
  const out = foldRuns(input, { minRun: 3 })
  assert.deepEqual(settle(out), ['a', 'same', '… \u00d74 (same line repeated)', 'b'])
  // 被折掉的 3 行必须记在标记上：单位里的行数之和守恒。
  assert.equal(out.reduce((sum, entry) => sum + entry.lines, 0), input.length)
})

test('foldRuns 不碰只有两行的重复', () => {
  const input = ['a', 'same', 'same', 'b']
  assert.deepEqual(settle(foldRuns(u(input), { minRun: 3 })), input)
})

test('foldRuns 严格模式只合"日志事件"，不碰只差数字的报表行', () => {
  // 日志事件：有时间戳，只差数字 → 折
  const events = u([
    '2026-01-01 10:00:00 INFO retry attempt 1',
    '2026-01-01 10:00:01 INFO retry attempt 2',
    '2026-01-01 10:00:02 INFO retry attempt 3',
    '2026-01-01 10:00:03 INFO retry attempt 4',
  ])
  assert.equal(settle(foldRuns(events, { minRun: 3, strict: true })).length, 2)

  // 报表行：只差数字但没有日志特征 → 一行都不许折
  const report = ['预算 1500 省 9.8% 丢失 1/2596 中位数 928', '预算 2000 省 9.8% 丢失 1/2596 中位数 928', '预算 4000 省 9.8% 丢失 1/2596 中位数 928']
  assert.deepEqual(settle(foldRuns(u(report), { minRun: 3, strict: true })), report)
})

test('templateOf 抹掉数字与长十六进制', () => {
  assert.equal(templateOf('build 123 done in 4.5s'), 'build # done in #.#s')
  assert.equal(templateOf('commit 4f3a9b2c1d'), 'commit #')
})

test('foldRepeats 折叠全文重复的长行', () => {
  const long = '  at Object.<anonymous> (/app/node_modules/pkg/index.js:120:9)'
  const input = u([long, 'x', long, 'y', long])
  const out = foldRepeats(input, { minLength: 24, minSaved: 32 })
  assert.equal(settle(out).filter((line) => line === long).length, 1)
  assert.equal(out.reduce((sum, entry) => sum + entry.lines, 0), input.length)
})

test('foldRepeats 短行不参与', () => {
  const input = u(['}', '}', '}', '}'])
  assert.deepEqual(foldRepeats(input, { minLength: 24, minSaved: 0 }), input)
})

test('dropNoise 只删强特征噪声行，并交代删了几行', () => {
  const input = u(['========', '10% |##      |', 'real content', '......'])
  const out = dropNoise(input)
  const settled = settle(out)
  assert.equal(settled[0], 'real content')
  assert.match(settled[1], /3 lines of progress\/decorative noise dropped/)
})

test('compactListing 权限列一致时压掉权限列', () => {
  const input = lines(
    [
      '-rw-r--r--  1 user  staff  1234 Oct  1 10:00 a.txt',
      '-rw-r--r--  1 user  staff  2345 Oct  1 10:00 b.txt',
      '-rw-r--r--  1 user  staff  3456 Oct  1 10:00 c.txt',
      '-rw-r--r--  1 user  staff  4567 Oct  1 10:00 d.txt',
    ].join('\n'),
  )
  const out = compactListing(u(input))
  const settled = settle(out)
  assert.equal(settled[0], '# ls -l: all entries -rw-r--r-- (mode column dropped)')
  assert.equal(settled[1], '1234 Oct  1 10:00 a.txt')
  assert.equal(settled.length, 5)
})

test('compactListing 权限列不一致时不动', () => {
  const input = lines(
    ['-rw-r--r--  1 user  staff  1 Oct  1 10:00 a', 'drwxr-xr-x  1 user  staff  1 Oct  1 10:00 b'].join('\n'),
  )
  assert.deepEqual(settle(compactListing(u(input))), input)
})

test('compactTree 把画线前缀压成缩进并保留层级', () => {
  const input = lines(['src', '├── a.js', '│   ├── b.js', '│   └── c.js', '└── d.js'].join('\n'))
  const settled = settle(compactTree(u(input)))
  assert.deepEqual(settled, ['src', '  a.js', '    b.js', '    c.js', '  d.js'])
})

test('compactStatus 按状态合并文件', () => {
  const input = lines(
    ['On branch main', 'Changes not staged for commit:', '  M lib/a.js', '  M lib/b.js', '?? notes.md'].join('\n'),
  )
  const out = compactStatus(u(input))
  const text = settle(out).join('\n')
  assert.match(text, /M: lib\/a\.js lib\/b\.js/)
  assert.match(text, /\?\?: notes\.md/)
})

test('compactDiff 保留全部增删行，只折上下文', () => {
  const context = Array.from({ length: 12 }, (_, i) => ` context ${i}`)
  const input = [
    'diff --git a/lib/a.js b/lib/a.js',
    'index 1111111..2222222 100644',
    '--- a/lib/a.js',
    '+++ b/lib/a.js',
    '@@ -1,14 +1,15 @@',
    ...context,
    '-old line',
    '+new line',
    '\\ No newline at end of file',
  ]
  const out = compactDiff(u(input), { contextLimit: 2 })
  const text = settle(out).join('\n')
  assert.match(text, /^# lib\/a\.js$/m)
  assert.ok(text.includes('-old line'))
  assert.ok(text.includes('+new line (no trailing newline)'))
  assert.ok(!text.includes('context 0'))
  assert.ok(!text.includes('No newline'))
  // 丢掉的上下文行数必须写准：hunk 里 12 行上下文，只留了紧邻变动的 2 行。
  assert.ok(text.includes('10 lines unchanged context'))
  assert.ok(settle(out).length < input.length)
  assert.equal(out.reduce((sum, entry) => sum + entry.lines, 0), input.length)
})

test('compactDiff 大段未变内容只留一句说明', () => {
  const big = Array.from({ length: 60 }, (_, i) => ` unchanged ${i}`)
  const input = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,61 +1,62 @@',
    ...big,
    '+added',
  ]
  const out = compactDiff(u(input), { contextLimit: 3 })
  const text = settle(out).join('\n')
  assert.ok(text.includes('+added'))
  assert.ok(text.includes('57 lines unchanged context'))
  assert.ok(text.split('\n').length < 12)
})

test('compactLog 只折日志事件，不折报表行', () => {
  const report = ['预算 1500 省 9.8% 丢失 1/2596', '预算 2000 省 9.8% 丢失 1/2596', '预算 4000 省 9.8% 丢失 1/2596']
  assert.deepEqual(settle(compactLog(u(report))), report)
})

test('compactLog 折叠同一模板的重复事件', () => {
  const input = lines(
    [
      '2026-01-01 10:00:00 INFO retry attempt 1',
      '2026-01-01 10:00:01 INFO retry attempt 2',
      '2026-01-01 10:00:02 INFO retry attempt 3',
      '2026-01-01 10:00:03 INFO retry attempt 4',
      '2026-01-01 10:00:04 INFO gave up',
    ].join('\n'),
  )
  const out = compactLog(u(input))
  const settled = settle(out)
  assert.equal(settled.length, 2)
  assert.match(settled[0], /×4 \(same event repeated; last: 4\)/)
  assert.equal(settled[1], '2026-01-01 10:00:04 INFO gave up')
  // 整段重复（含首行）都由标记代表，因此标记必须声明 4 行。
  assert.equal(out[0].lines, 4)
})

test('compactBuild 只折进度行', () => {
  const ok = lines('Compiling a\nCompiling b\nCompiling c\nCompiling d\nFinished in 3s\n3 passed, 0 skipped')
  const out = compactBuild(u(ok))
  const settled = settle(out)
  assert.equal(settled[0], '… (4 progress lines)')
  assert.ok(settled.includes('3 passed, 0 skipped'))
  assert.equal(out.reduce((sum, entry) => sum + entry.lines, 0), ok.length)
})

test('compactBuild 出现失败信号时一行都不折', () => {
  const bad = lines('Compiling a\nCompiling b\nCompiling c\n3 passed, 1 failed\nerror: boom')
  assert.deepEqual(compactBuild(u(bad)), u(bad))
})
