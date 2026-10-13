/**
 * 预算层：当内容实在压不下去时，砍得**有道理**。
 *
 * 与"取前 N 行 + 后 N 行"的做法不同，这里给每一行打分，然后在预算内优先保留高分行。
 * 打分只认**可验证的信号**（报错、失败、文件路径、行号、断言、退出码），不猜语义。
 * 结果是：同样的预算下，留下的是"能拿来干活的那几行"，而不是恰好排在前面的一段。
 *
 * 三条硬约束：
 * 1. 被丢掉的行**必须**在输出里标出来，且给出精确的丢了多少行；
 * 2. 尾部永远保留（最终结论、汇总、退出码都在尾部）；
 * 3. 任何情况下不放大：省不下来的就不动。
 *
 * @module dsh-meta-optimizer/budget
 */

import { markUnit, spanOf } from './units.js'

/** 打分阈值：达到这个分数就算"高信息量行"，按比例狠压时也要优先保住。 */
export const HIGH_SIGNAL_SCORE = 100

/** 高价值行：直接决定下一步动作。 */
const HIGH_SIGNAL = [
  /\b(?:error|Error|ERROR|failed|Failed|FAILED|failure|panic|Panic|fatal|FATAL|exception|Exception|Traceback)\b/,
  /^not ok\b|^\s*FAIL\b|✗|✘|✖|×/,
  /\b(?:assert|expected|actual|AssertionError)\b/i,
  /\bERR_[A-Z_]+\b|\bE\d{3,4}\b/,
  /^\s*at\s+\S+:\d+:\d+/,
  /^diff --git |^@@ /,
  /^(?:\+\+\+|---) [ab]\//,
  /\bexit(?:ed)? (?:code|status)\b|\bcode: ?\d+\b/,
  /\bpermission denied\b|\bnot found\b|\bNo such file\b|\bcannot \w+/i,
]

/** 中等价值行：给出位置与结论。 */
const MEDIUM_SIGNAL = [
  /(?:^|[\s"'(])(?:\.{0,2}\/|~\/|\/)[\w./@+-]{3,}/,
  /\b[\w./@+-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|rb|sh|json|ya?ml|toml|md|css|html|sql|txt|csv)\b/,
  /:\d+:\d+|:\d+\b/,
  /\b\d+ (?:passed|failed|pending|skipped)\b/,
  /\b(?:warning|WARN|deprecated|DeprecationWarning)\b/,
  /(?:^|\s)(?:ok|PASS|pass|success|Success|done|Done|finished|completed)(?:\s|$)/,
  /^\s*[+-]\s|\bsummary\b|\btotal\b|\b\d+(?:\.\d+)?(?:ms|s|MB|KB|kB|bytes)\b/i,
]

/** 文档噪声行：几乎从不影响下一步动作。 */
const LOW_SIGNAL = [
  /^\s*$/,
  /^\s*(?:Copyright|Licen[cs]e|@license|SPDX-License-Identifier)\b/i,
  /^\s*(?:Please|Note|Hint|Tip|See also|For more information)\b/,
  /^\s*(?:[#>]{1,6}\s|[-*+]\s{2,}\S{0,20}$)/,
  /^\s*(?:https?:\/\/\S+)\s*$/,
]

/**
 * 给一行打分。
 *
 * @param line - 一行文本。
 * @param position - 行号（从 0 开始）。
 * @param total - 总行数。
 * @returns 分数（越高越该留）。
 */
export function scoreLine(line, position, total) {
  let score = 0
  if (HIGH_SIGNAL.some((re) => re.test(line))) score += 100
  if (MEDIUM_SIGNAL.some((re) => re.test(line))) score += 30
  if (LOW_SIGNAL.some((re) => re.test(line))) score -= 40
  // 结尾处的行更可能是结论。
  if (position >= total - 3) score += 20
  // 开头处的行更可能是命令与表头。
  if (position < 3) score += 10
  return score
}

/**
 * 在字符预算内挑选要保留的行。
 *
 * 规则：永远保留开头 `headLines` 行与结尾 `tailLines` 行；中间部分按分数从高到低填，
 * 直到预算用尽；最后按原顺序输出，缺口处插入一个省略标记（相邻缺口合并成一个）。
 *
 * 记账是**自校验**的：留下的单位数 + 少掉的行数必须等于输入总行数，数不上就整个放弃
 * 裁剪。宁可这一条不省，也不能给模型一个对不上的行数。
 *
 * @param list - 单位数组。
 * @param options - `{ budgetChars, headLines, tailLines, marker }`。
 * @returns `{ list, dropped }`，`dropped` 为被丢掉的行数（原文行）。
 */
export function selectWithinBudget(list, options) {
  const budgetChars = options.budgetChars
  const headLines = Number.isInteger(options.headLines) ? options.headLines : 0
  const tailLines = Number.isInteger(options.tailLines) ? options.tailLines : 0
  const total = list.length
  if (total === 0) return { list, dropped: 0 }
  let used = 0
  for (const entry of list) used += entry.text.length + 1
  if (used <= budgetChars) return { list, dropped: 0 }

  const keep = new Array(total).fill(false)
  let spent = 0
  const take = (index) => {
    if (keep[index]) return
    keep[index] = true
    spent += list[index].text.length + 1
  }
  for (let i = 0; i < Math.min(headLines, total); i += 1) take(i)
  for (let i = Math.max(headLines, total - tailLines); i < total; i += 1) take(i)

  const candidates = []
  for (let i = headLines; i < total - tailLines; i += 1) {
    if (keep[i]) continue
    candidates.push({ index: i, score: scoreLine(list[i].text, i, total), length: list[i].text.length })
  }
  candidates.sort((a, b) => b.score - a.score || a.index - b.index)

  // 标记本身也要占预算，留一点余量。
  const reserve = 96
  // 第一轮：**先装高信息量行**。报错、断言、堆栈、exit code 这类行是"丢了就等于丢任务"的，
  // 只要预算还装得下就一定留下。这是把"按比例狠压"从"会丢掉几个百分点的信号"变成
  // "几乎不丢"的关键一步。
  for (const candidate of candidates) {
    if (candidate.score < HIGH_SIGNAL_SCORE) continue
    if (spent + candidate.length + 1 + reserve > budgetChars) break
    take(candidate.index)
  }
  // 第二轮：剩下的预算按分数从高到低填。
  for (const candidate of candidates) {
    if (keep[candidate.index]) continue
    if (spent + candidate.length + 1 + reserve > budgetChars) continue
    take(candidate.index)
  }

  const out = []
  let keptLines = 0
  let dropped = 0
  let markerLines = 0
  let gap = 0
  const flush = () => {
    if (gap === 0) return
    out.push(markUnit('budget', [options.marker ?? 'low signal'], gap))
    markerLines += 1
    gap = 0
  }
  for (let i = 0; i < total; i += 1) {
    if (keep[i]) {
      flush()
      out.push(list[i])
      keptLines += list[i].lines
    } else {
      gap += list[i].lines
      dropped += list[i].lines
    }
  }
  flush()
  // 自检：结果行数（含标记行）+ 少掉的行数必须正好等于原文行数。数不上就整条放弃裁剪。
  if (keptLines + dropped !== spanOf(list)) return { list, dropped: 0 }
  if (out.length - markerLines + dropped !== total) return { list, dropped: 0 }
  return { list: out, dropped }
}

/**
 * 紧凑化 JSON 的排版：去掉缩进阶梯，短数组/短对象合并成一行。
 *
 * 只重排空白，不改任何键、值或顺序，因此内容等价。为了严格无损，调用方在
 * "写进上下文"之前不要改结构——这里也只做空白与短容器内联。
 *
 * @param text - 已确认可 `JSON.parse` 的文本。
 * @param options - `{ indent }`：缩进字符数，默认 0（完全压缩）。
 * @returns 紧凑后的文本。
 */
export function compactJsonText(text, options = {}) {
  const value = JSON.parse(text)
  const indent = Number.isInteger(options.indent) ? options.indent : 0
  const pad = indent > 0 ? ' '.repeat(indent) : ''
  const compact = (node, depth) => {
    if (node === null || typeof node !== 'object') return JSON.stringify(node)
    if (Array.isArray(node)) {
      if (node.length === 0) return '[]'
      const items = node.map((item) => compact(item, depth + 1))
      const inline = `[${items.join(',')}]`
      if (indent === 0 || inline.length + pad.length * depth <= 100) return inline
      return `[\n${items.map((item) => pad.repeat(depth + 1) + item).join(',\n')}\n${pad.repeat(depth)}]`
    }
    const entries = Object.entries(node)
    if (entries.length === 0) return '{}'
    const parts = entries.map(([key, item]) => `${JSON.stringify(key)}:${indent === 0 ? '' : ' '}${compact(item, depth + 1)}`)
    const inline = `{${parts.join(',')}}`
    if (indent === 0 || inline.length + pad.length * depth <= 100) return inline
    return `{\n${parts.map((part) => pad.repeat(depth + 1) + part).join(',\n')}\n${pad.repeat(depth)}}`
  }
  return compact(value, 0)
}
