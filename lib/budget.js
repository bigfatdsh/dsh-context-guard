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

import { markUnit, spanOf, unit } from './units.js'
import { PRIORITY, cutLine, droppedDigest, priorityOf } from './curate.js'

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
/** 省略标记的字符长度上界（`… (N lines omitted, low signal)` 约 40 字符）。 */
const MARKER_CHARS = 48

/**
 * 在字符预算内挑选要保留的行。
 *
 * 规则：保留开头 `headLines` 行与结尾 `tailLines` 行；中间按优先级与打分填。
 *
 * 三件事让这个函数**真的**守住上界（都是踩出来的）：
 *
 * 1. **省略标记也占字符**。一整段丢掉会生成一个标记行，468 个缺口就是 468 个标记——
 *    只算被保留行的字符，实际结果会比预算大得多。这里按"最多还能形成多少个缺口"预留。
 * 2. **超长行先切再选**。一个装不进预算的单行不能被跳过（预算失效），也不能整条丢
 *    （信息全丢），只能切开；切到"20 行以内能装进预算"的宽度。
 * 3. **自检不过就回滚**（保留）：行账对不上时返回原文，宁可这一条不省。
 *
 * @param list - 单位数组。
 * @param options - `{ budgetChars, headLines, tailLines, marker, digest }`。
 * @returns `{ list, dropped, truncated }`。
 */
export function selectWithinBudget(list, options) {
  const budgetChars = options.budgetChars
  // `allowCut: false`：一行都不许切。给 JSON 这类"切了就坏"的内容用——
  // 预算超了也要保住可解析性（合法性比省 token 重要）。
  const allowCut = options.allowCut !== false
  const headLines = Number.isInteger(options.headLines) ? options.headLines : 0
  const tailLines = Number.isInteger(options.tailLines) ? options.tailLines : 0
  const total = list.length
  if (total === 0) return { list, dropped: 0 }
  let used = 0
  for (const entry of list) used += entry.text.length + 1
  if (used <= budgetChars) return { list, dropped: 0, truncated: 0 }

  // 预留标记开销：最坏情况是"留下的行两两不相邻"，缺口数 ≈ 保留行数 + 1，封顶 64 个。
  const keptEstimate = headLines + tailLines + 8
  const markerReserve = Math.min(64, keptEstimate + 1) * MARKER_CHARS
  const roomForLines = Math.max(128, budgetChars - markerReserve)

  // 超长行先切。宽度按"头 6 + 尾 8 + 中间 6"共 20 行分账，留出一倍余量给标记。
  const lineLimit = Math.max(48, Math.floor(roomForLines / 40))
  // 只有**确实超长**的行才切：上限取"整段预算的 1/6"与逐行宽度里的较大者。
  // 太小时会把 ERROR 行也切掉——实测出现过 `ERROR: could not resolve dependency "left-pad"`
  // 被切到 30 字符，报错就废了。
  const cutThreshold = Math.max(lineLimit, Math.floor(roomForLines / 6))
  const cut = new Map()
  let truncated = 0
  const textOf = (index) => {
    const cached = cut.get(index)
    if (cached !== undefined) return cached
    const text = list[index].text
    // 有信息量的行（状态标记 / 报错 / 警告）**绝不切**：宁愿它整行占预算，
    // 由第二轮去挤掉别的普通行。
    if (priorityOf(text) !== PRIORITY.NORMAL) return text
    if (!allowCut) return text
    if (text.length <= cutThreshold) return text
    const shorter = cutLine(text, cutThreshold)
    cut.set(index, shorter)
    truncated += 1
    return shorter
  }
  const lengthOf = (index) => textOf(index).length + 1

  const keep = new Array(total).fill(false)
  let spent = 0
  const take = (index) => {
    if (keep[index]) return
    keep[index] = true
    spent += lengthOf(index)
  }
  for (let i = 0; i < Math.min(headLines, total); i += 1) take(i)
  for (let i = Math.max(headLines, total - tailLines); i < total; i += 1) take(i)

  const candidates = []
  for (let i = headLines; i < total - tailLines; i += 1) {
    if (keep[i]) continue
    // 位置偏好：拆分出来的碎片之间几乎没区别，靠打分选等于随机丢。给靠前的碎片加分，
    // 因为长输出里"开头"通常是定义/表头/第一批数据，比中段更有参考价值。
    const positional = Math.max(0, 12 - Math.floor(i / Math.max(1, Math.floor(total / 12))))
    candidates.push({
      index: i,
      score: scoreLine(list[i].text, i, total) + positional,
      priority: priorityOf(list[i].text),
    })
  }
  // 第一轮：有信息量的行（状态标记 > 报错 > 警告）优先，装得下就留。
  const ordered = [...candidates].sort((a, b) => a.priority - b.priority || b.score - a.score)
  for (const candidate of ordered) {
    if (candidate.priority === PRIORITY.NORMAL) continue
    if (spent + lengthOf(candidate.index) > roomForLines) continue
    take(candidate.index)
  }
  // 第二轮：剩下的预算按分数从高到低填。
  candidates.sort((a, b) => b.score - a.score || a.index - b.index)
  for (const candidate of candidates) {
    if (keep[candidate.index]) continue
    if (spent + lengthOf(candidate.index) > roomForLines) continue
    take(candidate.index)
  }

  const out = []
  const droppedLines = []
  let keptLines = 0
  let dropped = 0
  let markerLines = 0
  let gap = 0
  let gapChars = 0
  const flush = () => {
    if (gap === 0) return
    // 一整行被丢 → 按行报；一堆碎片被丢（原文是超长行拆出来的）→ 按字符报，更准确。
    const fragmentary = gapChars > 0 && gapChars / Math.max(1, gap) < 40
    const mark = fragmentary
      ? markUnit('budgetChars', [options.marker ?? 'low signal'], gapChars)
      : markUnit('budget', [options.marker ?? 'low signal'], gap)
    out.push(mark)
    markerLines += 1
    gap = 0
    gapChars = 0
  }
  for (let i = 0; i < total; i += 1) {
    if (keep[i]) {
      flush()
      const shorter = cut.get(i)
      out.push(shorter === undefined ? list[i] : unit(shorter, list[i].lines))
      keptLines += list[i].lines
    } else {
      gap += list[i].lines
      gapChars += list[i].text.length
      dropped += list[i].lines
      if (droppedLines.length < 400) droppedLines.push(list[i].text)
    }
  }
  flush()

  // 被丢掉的报错/警告点名一行，而不是只报数字。
  const digest = options.digest === false ? '' : droppedDigest(droppedLines, options.digestLimit ?? 240)
  const addedExtra = digest.length > 0 ? 1 : 0
  if (addedExtra === 1) out.push(unit(digest, 0))

  // 自检：行账必须对得上，否则整条回滚。
  if (keptLines + dropped !== spanOf(list)) return { list, dropped: 0, truncated: 0 }
  if (out.length - markerLines - addedExtra + dropped !== total) return { list, dropped: 0, truncated: 0 }
  return { list: out, dropped, truncated }
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
