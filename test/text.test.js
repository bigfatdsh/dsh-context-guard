/**
 * 文本层的单元测试。
 *
 * @module dsh-meta-optimizer/test/text
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  isCompactableText,
  lineHash,
  normalizeLine,
  normalizeText,
  resolveCarriageReturns,
  stripAnsi,
  textHash,
} from '../lib/text.js'

test('stripAnsi 去掉颜色与光标序列', () => {
  assert.equal(stripAnsi('\u001B[31merror\u001B[0m: boom'), 'error: boom')
  assert.equal(stripAnsi('\u001B[1;32mOK\u001B[0m'), 'OK')
  assert.equal(stripAnsi('plain text'), 'plain text')
})

test('stripAnsi 保留光标左移之后的最终可见文本', () => {
  // `\u001B[3D` 回到行首写 "abc"：终端里看到的是 "abcdef" 被覆盖成 "abc"。
  assert.equal(stripAnsi('abcdef\u001B[6Dxyz'), 'xyzdef')
  assert.equal(stripAnsi('\u001B[2Knew'), 'new')
})

test('resolveCarriageReturns 收敛进度条', () => {
  assert.equal(resolveCarriageReturns('10%\r55%\r100% done'), '100% done')
  assert.equal(resolveCarriageReturns('no carriage return'), 'no carriage return')
  assert.equal(resolveCarriageReturns('done\r'), 'done')
})

test('normalizeLine 统一不可见字符并去掉行尾空白', () => {
  assert.equal(normalizeLine('a\u00A0b\u200Bc   '), 'a bc')
  assert.equal(normalizeLine('\uFEFFhello\u3000'), 'hello')
  assert.equal(normalizeLine('tab\tkept'), 'tab\tkept')
  assert.equal(normalizeLine('\u001B[90mgray\u001B[0m\t '), 'gray')
})

test('normalizeLine 压掉生成出来的长空格串但不动普通对齐', () => {
  assert.equal(normalizeLine('name          size'), 'name  size')
  assert.equal(normalizeLine('a b  c   d'), 'a b  c   d')
})

test('normalizeText 压连续空行、去首尾空行', () => {
  const input = '\n\n\na\n\n\n\n\nb\n\n\n'
  assert.equal(normalizeText(input), 'a\n\nb')
})

test('normalizeText 处理 CRLF', () => {
  assert.equal(normalizeText('a\r\nb\r\n'), 'a\nb')
})

test('normalizeText 幂等', () => {
  const input = '\u001B[31mred\u001B[0m\r\n\r\n\r\nplain   \n\n\n'
  const once = normalizeText(input)
  assert.equal(normalizeText(once), once)
})

test('isCompactableText 拒绝二进制', () => {
  assert.equal(isCompactableText('text'), true)
  assert.equal(isCompactableText(''), false)
  assert.equal(isCompactableText('a\u0000b'), false)
  assert.equal(isCompactableText('\uFFFD'.repeat(200)), false)
})

test('指纹稳定且区分内容', () => {
  assert.equal(textHash('abc'), textHash('abc'))
  assert.notEqual(textHash('abc'), textHash('abd'))
  assert.equal(lineHash('x'), lineHash('x'))
})
