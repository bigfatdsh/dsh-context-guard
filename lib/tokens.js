/**
 * Token 计量：与 DSH 官方估算器同构。
 *
 * 官方口径（`@deepseek-ai/dsh-token-meter`）：文本按 **UTF-16 code unit 数 / 4 向上取整**，
 * 每个内容块再加 4 的开销。本插件内部所有"省了多少"的判定、测试断言与实测报告都用
 * 这一个函数，因此三者口径一致，不会出现"测试里省了、线上没省"。
 *
 * 这里刻意**不** import 官方包：插件按 `link:` 装进 profile，能确定解析到的只有
 * `node:*`。口径靠注释与测试锁定（见 `test/tokens.test.js`）。
 *
 * @module dsh-context-guard/tokens
 */

/** 官方估算器使用的换算系数。 */
export const CHARS_PER_TOKEN = 4

/** 每个内容块固定开销。 */
export const BLOCK_OVERHEAD = 4

/**
 * 一段文本的估算 token 数（不含块开销）。
 *
 * @param text - 任意文本。
 * @returns 估算 token 数；非字符串按空串处理。
 */
export function estimateText(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 一个内容块的估算 token 数。
 *
 * @param block - 内容块。
 * @returns 估算 token 数。
 */
export function estimateBlock(block) {
  if (block === null || typeof block !== 'object') return 0
  if (block.type === 'text' || block.type === 'reasoning') {
    return estimateText(String(block.text ?? '')) + BLOCK_OVERHEAD
  }
  if (block.type === 'tool-call') {
    return (
      estimateText(String(block.name ?? '')) +
      estimateText(JSON.stringify(block.arguments ?? {})) +
      BLOCK_OVERHEAD
    )
  }
  return BLOCK_OVERHEAD + estimateText(JSON.stringify(block))
}

/**
 * 一组内容块的估算 token 数。
 *
 * @param content - 内容块数组。
 * @returns 估算 token 数；非数组返回 0。
 */
export function estimateContent(content) {
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) total += estimateBlock(block)
  return total
}

/**
 * 一组内容块里可压缩文本的字符总数。
 *
 * 只统计 `text` 块：富内容（图片 / 文件 / 结构化块）本插件一律不碰。
 *
 * @param content - 内容块数组。
 * @returns 字符数。
 */
export function textChars(content) {
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      total += String(block.text ?? '').length
    }
  }
  return total
}
