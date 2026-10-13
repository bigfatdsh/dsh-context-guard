/**
 * 内容类型识别的测试。
 *
 * 每个用例都是一种**真实工具输出的样子**，识别错就会用错刀，所以这里只放有代表性的形状。
 *
 * @module dsh-meta-optimizer/test/detect
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  detectKind,
  isBuildOutput,
  isDiff,
  isFileListing,
  isGitStatus,
  isJson,
  isLogStream,
  isNumberedSource,
  isSourceCode,
} from '../lib/detect.js'

const lines = (text) => text.split('\n')

test('识别 unified diff', () => {
  const sample = lines(
    [
      'diff --git a/lib/a.js b/lib/a.js',
      'index 1111111..2222222 100644',
      '--- a/lib/a.js',
      '+++ b/lib/a.js',
      '@@ -1,3 +1,4 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '+const c = 4',
      ' export { a }',
    ].join('\n'),
  )
  assert.equal(isDiff(sample), true)
  assert.equal(detectKind(sample), 'diff')
})

test('识别 git status', () => {
  const short = lines(' M lib/a.js\n?? notes.md\nA  lib/b.js')
  assert.equal(isGitStatus(short), true)
  assert.equal(detectKind(short), 'status')
  const long = lines('On branch main\n\nChanges not staged for commit:\n  modified: a.js')
  assert.equal(isGitStatus(long), true)
})

test('识别带行号的源码', () => {
  const gutters = ['   1\u2192import x', '   2\u2192', '   3\u2192const a = 1', '   4\u2192export default a']
  assert.equal(isNumberedSource(gutters), true)
  assert.equal(detectKind(gutters), 'numbered-source')
  const colon = ['12:const a = 1', '13:const b = 2', '14:export { a, b }']
  assert.equal(isNumberedSource(colon), true)
})

test('识别 JSON', () => {
  assert.equal(isJson(lines('{\n  "a": 1,\n  "b": [1, 2, 3]\n}')), true)
  assert.equal(isJson(lines('{ not json }')), false)
  // 短 JSON 不值得上报（压不出东西），但仍能被认出来。
  assert.equal(isJson(lines('{\n "a": 1\n}')), false)
  assert.equal(detectKind(lines('{\n  "name": "demo",\n  "items": [1, 2, 3]\n}')), 'json')
})

test('识别文件清单', () => {
  const ls = lines(
    [
      '-rw-r--r--  1 user  staff  1234 Oct  1 10:00 a.txt',
      '-rw-r--r--  1 user  staff  2345 Oct  1 10:00 b.txt',
      '-rw-r--r--  1 user  staff  3456 Oct  1 10:00 c.txt',
      'drwxr-xr-x  4 user  staff   128 Oct  1 10:00 src',
    ].join('\n'),
  )
  assert.equal(isFileListing(ls), true)
  assert.equal(detectKind(ls), 'listing')
  const paths = lines('src/a.js\nsrc/b.js\nlib/c.js\nlib/d.js')
  assert.equal(isFileListing(paths), true)
})

test('识别日志流', () => {
  const log = lines(
    [
      '2026-01-01 10:00:00 INFO starting',
      '2026-01-01 10:00:01 INFO ready',
      '2026-01-01 10:00:02 WARN slow',
      '2026-01-01 10:00:03 INFO retrying',
      '2026-01-01 10:00:04 INFO ok',
      '2026-01-01 10:00:05 INFO done',
    ].join('\n'),
  )
  assert.equal(isLogStream(log), true)
  assert.equal(detectKind(log), 'log')
})

test('识别构建产出', () => {
  const build = lines('> build\nCompiling a\nCompiling b\nFinished in 2s\n12 passed, 0 failed')
  assert.equal(isBuildOutput(build), true)
  assert.equal(detectKind(build), 'build')
})

test('识别源码', () => {
  const code = lines(
    [
      'import { a } from "./a.js"',
      '',
      'export function run(input) {',
      '  const value = a(input)',
      '  return value',
      '}',
    ].join('\n'),
  )
  assert.equal(isSourceCode(code), true)
  assert.equal(detectKind(code), 'source')
})

test('普通输出落到 plain', () => {
  assert.equal(detectKind(lines('hello world')), 'plain')
  assert.equal(detectKind(lines('one\ntwo')), 'plain')
})
