/**
 * 跨调用增量：同一个"东西"看第二遍时，只给变化。
 *
 * 真实任务里最高频的浪费不是单次输出太长，而是**同一个输出被反复读进上下文**：
 * 日志尾部、同一个文件、同一条 `git status`。第二次开始，旧内容还躺在上下文里，
 * 再贴一遍纯属重复付费。
 *
 * 这里只做一件事：按 `工具名 + 归一化参数` 记账，第二次起把新输出与上一次的输出比对：
 * - 完全一样 → 一行标记；
 * - 只是追加或局部改动 → 给出没变的行数 + **逐字**的变动行（带位置区间）；
 * - 变得太多（默认超过 40%）→ 照原样返回，不做增量。
 *
 * 所有判定都基于行内容本身，不依赖模型是否"记得"，也不改任何一行的字。
 *
 * @module dsh-context-guard/replay
 */

import { textHash } from './text.js'

/** 一次记账。 */
class Entry {
  /**
   * @param text - 归一化后的输出文本。
   * @param callId - 产生它的工具调用 id。
   */
  constructor(text, callId) {
    this.text = text
    this.hash = textHash(text)
    this.lines = text.split('\n')
    this.callId = callId
  }
}

/**
 * 按 `工具名 + 参数` 记账的最近输出表。
 *
 * 用 Map + 手写 LRU：条目数有上限，长时间会话不会无限长。
 */
export class ReplayStore {
  /**
   * @param options - `{ maxEntries }`，默认 64。
   */
  constructor(options = {}) {
    this.maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 64
    /** @type {Map<string, Entry>} */
    this.entries = new Map()
  }

  /**
   * 生成记账键。
   *
   * @param tool - 工具名。
   * @param args - 工具参数。
   * @returns 记账键。
   */
  static key(tool, args) {
    let serialized
    try {
      serialized = JSON.stringify(args ?? {})
    } catch {
      serialized = String(args)
    }
    return `${tool}\u0000${textHash(serialized)}`
  }

  /**
   * 读上一次的输出。
   *
   * @param key - 记账键。
   * @returns 上一次的条目；没有则返回 undefined。
   */
  get(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    // 触碰即刷新 LRU 顺序。
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  /**
   * 写入本次输出。
   *
   * @param key - 记账键。
   * @param text - 归一化后的输出。
   * @param callId - 本次调用 id。
   * @returns 无。
   */
  set(key, text, callId) {
    this.entries.delete(key)
    this.entries.set(key, new Entry(text, callId))
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** 清空。 */
  clear() {
    this.entries.clear()
  }

  /** 当前条目数。 */
  get size() {
    return this.entries.size
  }
}

/**
 * 计算两段文本的增量。
 *
 * 用"公共前缀 + 公共后缀"定位变动区：日志尾部、累加式输出、文件追加都是这个形状，
 * 结果的准确度足够，代价是线性的。
 *
 * @param previous - 上一次的文本。
 * @param next - 本次的文本。
 * @returns `{ kind, changed, context }` 或 `null`（变化太大，不做增量）。
 */
export function diffIncremental(previous, next) {
  const before = previous.split('\n')
  const after = next.split('\n')
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const changedBefore = before.length - prefix - suffix
  const changedAfter = after.length - prefix - suffix
  const changed = changedBefore + changedAfter
  const total = Math.max(before.length, after.length)
  if (changed === 0) return { kind: 'identical', changed: 0, context: after.length }
  if (total > 12 && changed > total * 0.4) return null
  if (changed > 200) return null
  return { kind: 'delta', changed, context: prefix + suffix, prefix, suffix }
}

/**
 * 渲染"完全没变"的标记。
 *
 * 只留一行：模型需要知道的全部信息就是"内容和上次一模一样"，以及它是多少行、指纹是什么
 * （指纹用于和后面的增量对账）。
 *
 * @param text - 本次文本。
 * @returns 标记文本。
 */
export function renderIdentical(text) {
  const lines = text.split('\n').length
  return `(unchanged: byte-identical to the previous result of this same call, ${lines} lines, ${textHash(text)})`
}

/**
 * 渲染增量：没变的行只报数，变动的行逐字给出。
 *
 * @param previous - 上一次文本。
 * @param next - 本次文本。
 * @param info - {@link diffIncremental} 的结果。
 * @returns 渲染后的文本。
 */
export function renderDelta(previous, next, info) {
  const before = previous.split('\n')
  const after = next.split('\n')
  const head = `(delta vs the previous result of this same call: ${info.context} line${info.context === 1 ? '' : 's'} unchanged)`
  const removed = before.slice(info.prefix, before.length - info.suffix)
  const added = after.slice(info.prefix, after.length - info.suffix)
  const out = [head]
  if (info.prefix > 0) out.push(`… ${info.prefix} unchanged line${info.prefix === 1 ? '' : 's'}`)
  for (const line of removed) out.push(`- ${line}`)
  for (const line of added) out.push(`+ ${line}`)
  if (info.suffix > 0) out.push(`… ${info.suffix} unchanged line${info.suffix === 1 ? '' : 's'}`)
  return out.join('\n')
}
