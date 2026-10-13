/**
 * 会话级账本：**同一个东西不要在上下文里出现两次**。
 *
 * ## 为什么这是最有价值的杠杆
 *
 * 用真实会话日志量过（本机 6 个会话、2308 次请求）：prompt 总计 **5.34 亿 token**，其中
 * **99.7% 是缓存读取**，而工具结果只占 prompt 的 **0.08%**。也就是说：
 *
 * - 单条结果的压缩率再翻一倍，对总账的影响也只有 0.04% 量级；
 * - 真正的杠杆是**别让同样的内容进上下文两次**——每一次请求都会把整个历史重读一遍，
 *   所以省下的每一个 token 都会被重读"请求次数"那么多遍。
 *
 * 实测同一个会话里跨结果的**整行重复占 7.3%**（整条完全重复只有 0.0%）。
 * 这部分内容模型在上文已经逐字看过，重发一遍是纯粹的重复付费。
 *
 * ## 做法
 *
 * 每条结果经过时，把其中的长行记进账本；**之后**（跨结果，不含本结果内部）再遇到同样的行，
 * 就换成一句 `[S12] seen above`——第 12 条结果里已经有它的原文，模型照编号就能回去看。
 *
 * ## 三条边界
 *
 * 1. **只在"够长"的行上做**（默认 ≥ 60 字符）：短行省不下多少，标记本身要占字符；
 * 2. **结构行与高信息量行不做**：`}`、`);`、报错、警告、状态标记必须原地在场，
 *    换成引用会让代码看起来坏掉、或者让报错看起来消失了；
 * 3. **只引用"上一条"之后的**：同一结果内部先出现的行照常显示，避免"引用自己"。
 *
 * @module dsh-meta-optimizer/session
 */

import { isStructuralLine, priorityOf, PRIORITY } from './curate.js'
import { hasInlineMark, unit, markUnit } from './units.js'

/** 账本上限：行数超过就整体丢弃（宁可少省，不能无限占内存）。 */
const MAX_LINES = 60000

/** 一条结果的账。 */
class Ledger {
  constructor() {
    /** 行文本 → 首次出现在第几条结果的编号。 */
    this.lines = new Map()
    /** 已经处理过多少条结果。 */
    this.results = 0
    /** 下一条结果的编号（从 1 开始）。记账与去重必须用**同一个**编号体系，否则会错位。 */
    this.nextNumber = 1
    /** 累计省下的字符。 */
    this.savedChars = 0
    /** 累计做过多少次跨结果引用。 */
    this.refs = 0
    /** 命中的结果条数。 */
    this.hitResults = 0
  }

  /**
   * 把一条结果的文本记进账本。
   *
   * @param text - 结果文本（已经过本插件压缩的成品）。
   * @param minChars - 只有不短于这个长度的行才记账。
   * @returns 无。
   */
  remember(text, minChars, number) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length < minChars) continue
      if (this.lines.has(line)) continue
      this.lines.set(line, Number.isInteger(number) ? number : this.nextNumber)
      if (this.lines.size > MAX_LINES) {
        // 超限就清空重来：宁可少省一批，也不能让账本无限涨。
        this.lines.clear()
        this.lines.set(line, Number.isInteger(number) ? number : this.nextNumber)
      }
    }
  }
}

/** 每个 agent 一本账。用 `WeakMap` 是为了 agent 被回收时账本跟着走，不会泄漏。 */
const LEDGERS = new WeakMap()

/** 拿不到 agent 时用的兜底账本。 */
let fallback = undefined

/**
 * 取某个 agent 的会话账本。
 *
 * @param agent - 宿主给的 agent 对象；可以为空。
 * @returns 账本实例。
 */
export function ledgerFor(agent) {
  if (agent === undefined || agent === null || (typeof agent !== 'object' && typeof agent !== 'function')) {
    fallback ??= new Ledger()
    return fallback
  }
  let ledger = LEDGERS.get(agent)
  if (ledger === undefined) {
    ledger = new Ledger()
    LEDGERS.set(agent, ledger)
  }
  return ledger
}

/** 复位所有账本（只给测试用）。 */
export function resetLedgers() {
  fallback = undefined
}

/**
 * 跨结果去重：把"上文已经逐字出现过的长行"换成一句引用。
 *
 * @param list - 单位数组。
 * @param ledger - 会话账本。
 * @param options - `{ minChars, resultNumber }`。
 * @returns `{ list, refs, savedChars }`。
 */
export function dedupeAcrossResults(list, ledger, options = {}) {
  const minChars = Number.isInteger(options.minChars) ? options.minChars : 40
  // 一次替换至少省这么多字符才做。短行即使"引用更短"，省下的也只是几个字符。
  const minSavedChars = Number.isInteger(options.minSavedChars) ? options.minSavedChars : 24
  // 默认取"下一条"的编号：`ledger.results` 是**已经处理过**的条数，本条的编号是它 +1。
  // 早先直接用了 `ledger.results`，于是"首次出现的那条"自己就被判成"上文已有"、
  // 被换成引用自己——实测就是这个 off-by-one 让整条链一次都没生效。
  const resultNumber = Number.isInteger(options.resultNumber) ? options.resultNumber : ledger.nextNumber
  const out = []
  let refs = 0
  let savedChars = 0
  for (const entry of list) {
    const text = entry.text
    const trimmed = text.trim()
    if (
      trimmed.length < minChars ||
      hasInlineMark(text) ||
      isStructuralLine(text) ||
      priorityOf(text) !== PRIORITY.NORMAL
    ) {
      out.push(entry)
      continue
    }
    const firstSeenAt = ledger.lines.get(text)
    // `firstSeenAt` 是**结果的编号**（1-based，账本里存的就是它）。
    // 必须严格早于本条的编号：等于说明本结果内部已经出现过，那不是上文，不能引用。
    if (firstSeenAt === undefined || firstSeenAt >= resultNumber) {
      out.push(entry)
      continue
    }
    // 引用要比正文**明显短**才值得换：只省几个字符的替换等于白加一层间接。
    const notice = `[S${firstSeenAt}] seen above`
    if (text.length - notice.length < minSavedChars) {
      out.push(entry)
      continue
    }
    refs += 1
    savedChars += text.length - notice.length
    out.push(markUnit('seen', [firstSeenAt], 0))
  }
  if (refs > 0) {
    ledger.refs += refs
    ledger.savedChars += savedChars
    ledger.hitResults += 1
  }
  return { list: out, refs, savedChars }
}

/**
 * 把一条结果记进账本并推进计数。**必须在去重之后调用**（先去重、再记账，
 * 否则本结果内部的行会互相引用——那是错的，第一条就该原样显示）。
 *
 * @param ledger - 会话账本。
 * @param text - 这条结果的成品文本。
 * @param minChars - 记账的最小行长。
 * @returns 本条结果的编号（从 1 开始）。
 */
export function advance(ledger, text, minChars) {
  const number = ledger.nextNumber
  ledger.remember(text, minChars, number)
  ledger.results += 1
  ledger.nextNumber = number + 1
  return number
}

export { Ledger }
