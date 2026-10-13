/**
 * 极致取舍：把"按比例/预算压"做到**有上界、保首尾、报错点名、绝不弄坏结构**。
 *
 * 这一层是照着 `dsh-tool-token-optimizer` 的 `retain.js` + `sections.js` 的**教训**重写的，
 * 它踩过的坑我原样踩了一遍（都是实测出来的）：
 *
 * - **预算曾经是假的**：单个单元（一行 4 万字符的 JSON）装不进预算时被整条跳过，
 *   于是"压到 N 字以内"在运行时是假的（实测 40000 字符的输入原样返回，预算是 2000）。
 *   所以第一条铁律是：**结果字符数 ≤ 上界**，超了就在唯一能切的地方切。
 * - **首行与末行不能消失**：开头是格式与接口，末行是结论与退出状态。
 * - **报错不许被静默挤掉**：放不下的可疑行必须以**带优先级的摘要**点名，而不是只报一个数字。
 * - **结构收尾行不能丢**：`}` / `);` / 注释收尾标记 本身几乎不含信息，但丢了它们，剩下的代码
 *   看起来就是坏的（实测 18 条结构完整的源码里 8 条被裁坏）。
 * - **不切开有结构的东西**：只在"本来就没有行结构"的超长行上硬切。
 *
 * @module dsh-meta-optimizer/curate
 */

import { unit } from './units.js'

/** 状态标记行：`[exit code: N]`、`[timed out …]`、`[stderr]` 这类——"这次调用成功没有"的直接答案。 */
// 注意：这里刻意**不写出** 星号紧跟斜杠 这种字面量 —— 正则或注释里出现它，会让 JS 词法器
// 以为注释结束了，后面的文字变成代码，报出来的是几十行之外的 `Unexpected identifier`，极难查。
const STATUS_MARKER = new RegExp(
  '^\\s*\\[(?:exit code|timed out|killed by signal|stopped|stderr|stdout|result truncated|' +
    'output truncated|some output was dropped)[^]]*]',
  'i',
)

/**
 * 报错前缀。
 *
 * 用 `(?:^|\s)` 而不是 `^\s*`：真日志长这样
 * `2026-01-01 10:01:37 ERROR upstream returned 503`——`ERROR` 前面有时间戳，
 * 用行首锚定**永远匹配不到**，于是最典型的日志里所有报错行都被当成普通行挤掉。
 * 这个错误方向最不能忍（少省 token 无所谓，漏判报错不行）。
 */
const ERROR_PREFIX =
  /(?:^|\s)(?:ERROR|ERR|FAIL|FAILED|FATAL|PANIC|CRITICAL|SEVERE|EXCEPTION)\b|(?:^|\s)(?:error|err|fail|fatal)[:!]|\w+Error[:\s]|(?:^|\s)(?:error|warning) [A-Z]{1,4}\d+/i

/** 报错指纹（出现在哪都算）。 */
const ERROR_FINGERPRINTS = [
  /\w*(?:Error|Exception)\b/,
  /\b(?:ELIFECYCLE|MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|ETIMEDOUT|ECONNREFUSED|ERR_[A-Z_]+)\b/,
  /^\s*(?:not ok|panic:|fatal:)/,
  /^\s*(?:AssertionError|Assertion failed|Traceback)\b/,
  /^\s*at\s+\S+\s*\(?/,
  /\bexit code[:\s]/i,
]

/** 警告指纹。 */
const WARNING_FINGERPRINTS = [/\b(?:warn|warning|deprecated)\b/i]

/** 优先级：数字越小越该留。 */
export const PRIORITY = Object.freeze({
  STATUS: 0,
  STDERR: 1,
  ERROR: 2,
  WARNING: 3,
  NORMAL: 4,
})

/**
 * 给一行定优先级。
 *
 * @param line - 一行文本。
 * @returns 优先级（0 最高）。
 */
export function priorityOf(line) {
  if (STATUS_MARKER.test(line)) return PRIORITY.STATUS
  if (ERROR_PREFIX.test(line)) return PRIORITY.ERROR
  if (ERROR_FINGERPRINTS.some((re) => re.test(line))) return PRIORITY.ERROR
  if (WARNING_FINGERPRINTS.some((re) => re.test(line))) return PRIORITY.WARNING
  return PRIORITY.NORMAL
}

/** 单行被硬切时留下的痕迹。 */
const CUT_SUFFIX = (dropped) => `… [${dropped} more chars]`

/**
 * 把一行硬切到不超过 `limit` 字符，并留下"还差多少"的说明。
 *
 * 只在**不得不切**的时候调用：正常内容是逐行取舍，不会走到这里。切的位置选在
 * `limit` 之前的最后一个空格或逗号处，尽量不把一个词劈成两半。
 *
 * @param text - 一行文本。
 * @param limit - 字符上限。
 * @returns 截断后的文本。
 */
export function cutLine(text, limit) {
  if (text.length <= limit) return text
  const room = Math.max(16, limit - 24)
  const window = text.slice(0, room)
  const at = Math.max(window.lastIndexOf(' '), window.lastIndexOf(','), window.lastIndexOf('\t'))
  const head = at > room * 0.6 ? window.slice(0, at) : window
  return `${head}${CUT_SUFFIX(text.length - head.length)}`
}

/**
 * 纯结构收尾行：只由括号、方括号、花括号、分号、逗号组成的行，以及 `* /`。
 *
 * 这类行本身几乎不含信息，但**丢了它们，剩下的代码看起来就是坏的**——一个函数体少了
 * 收尾大括号，模型很难判断"是代码真的没写完，还是被裁掉了"。实测 18 条结构完整的源码
 * 结果里有 8 条被裁成结构不完整。
 *
 * 所以它们是"便宜但必须留"的行：代价是一两个 token，收益是代码看起来仍然成立。
 *
 * @param text - 一行文本。
 * @returns 是纯结构收尾行返回 true。
 */
export function isClosureLine(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed === '* /') return true
  for (const ch of trimmed) {
    if (ch === ')' || ch === ']' || ch === '}' || ch === ';' || ch === ',') continue
    return false
  }
  return true
}

/**
 * 这一行是不是"结构相关"（纯收尾行，或含注释收尾标记）。
 *
 * @param text - 一行文本。
 * @returns 结构相关返回 true。
 */
export function isStructuralLine(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (isClosureLine(trimmed)) return true
  if (text.includes('*' + '/')) return true
  // 以括号/方括号/花括号开头的行：代码骨架（`} else {`、`]);`、`{`）。
  // 骨架行丢了，剩下的代码就不闭合了——实测 18 条结构完整的源码里 11 条被裁坏。
  const head = trimmed[0]
  return head === '}' || head === ')' || head === ']' || head === '{'
}

/**
 * 收尾：保证"里层"没有装不下的超长行，并给出被切掉的字符数。
 *
 * 只做一件在别处做不了的事：**把装不下的超长行切开**（而不是整条丢掉或原样放过）。
 *
 * @param list - 单位数组。
 * @param budgetChars - 结果字符上界。
 * @param options - `{ reserveChars }`：要给省略标记留的余量。
 * @returns `{ list, truncatedChars }`。
 */
export function enforceCeiling(list, budgetChars, options = {}) {
  const reserve = Number.isInteger(options.reserveChars) ? options.reserveChars : 0
  const limit = Math.max(64, budgetChars - reserve)
  let total = 0
  for (const entry of list) total += entry.text.length + 1
  if (total <= limit) return { list, truncatedChars: 0 }

  let saved = 0
  const out = list.map((entry) => {
    if (entry.text.length <= limit) return entry
    const cut = cutLine(entry.text, limit)
    saved += entry.text.length - cut.length
    return unit(cut, entry.lines)
  })
  return { list: out, truncatedChars: saved }
}

/**
 * 给"被丢掉的行"生成一行带优先级的摘要。
 *
 * 目的：让模型知道**中段里还有哪几类东西**，从而判断要不要回读——这比只报一个数字有用得多，
 * 而代价只有一行。做成一眼能认出的"总结行"：两侧用方括号包起来，并写明这是统计而不是代码，
 * 免得摘要里的报错样本被当成正文的一部分。
 *
 * @param dropped - 被丢掉的行文本数组。
 * @param limit - 摘要字符上限。
 * @returns 摘要行；没有值得点名的内容时返回空串。
 */
export function droppedDigest(dropped, limit = 240) {
  /** @type {Map<number, { count: number, sample: string }>} */
  const buckets = new Map()
  for (const line of dropped) {
    const priority = priorityOf(line)
    if (priority === PRIORITY.NORMAL) continue
    const bucket = buckets.get(priority) ?? { count: 0, sample: line.trim().slice(0, 90) }
    bucket.count += 1
    buckets.set(priority, bucket)
  }
  // 注意：**不能**在"没有报错/警告"时提前返回空串——那样"丢了一批路径"这类情况就只剩
  // 一个数字，模型无法判断要不要回读。顺序是：先收集报错/警告，再补类型摘要。
  const labels = {
    [PRIORITY.STATUS]: 'status',
    [PRIORITY.ERROR]: 'error',
    [PRIORITY.WARNING]: 'warning',
  }
  const parts = []
  for (const priority of [PRIORITY.STATUS, PRIORITY.ERROR, PRIORITY.WARNING]) {
    const bucket = buckets.get(priority)
    if (bucket === undefined) continue
    parts.push(`${bucket.count} ${labels[priority]} (e.g. ${bucket.sample})`)
  }
  // 没有报错/警告时，也交代"丢的那批大概是什么"——只报一个数字，模型无法判断要不要回读。
  // 实测被丢掉的常常是一整段路径列表或一组编号行，说清类型比说清条数有用得多。
  if (parts.length === 0) {
    const kinds = { path: 0, numbered: 0, url: 0, other: 0 }
    let sample = ''
    for (const line of dropped) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      if (/^\/|^\.\.?\//.test(trimmed) || /^[\w.@+-]+\/[\w./-]+$/.test(trimmed)) kinds.path += 1
      else if (/^\s*\d+[):.\t]/.test(trimmed)) kinds.numbered += 1
      else if (/^https?:\/\//.test(trimmed)) kinds.url += 1
      else kinds.other += 1
      if (sample.length === 0 && trimmed.length >= 12) sample = trimmed.slice(0, 70)
    }
    const named = []
    if (kinds.path > 0) named.push(`${kinds.path} path lines`)
    if (kinds.numbered > 0) named.push(`${kinds.numbered} numbered lines`)
    if (kinds.url > 0) named.push(`${kinds.url} URLs`)
    if (kinds.other > 0) named.push(`${kinds.other} other lines`)
    if (named.length > 0) {
      parts.push(`${named.join(', ')}${sample.length > 0 ? ` (e.g. ${sample})` : ''}`)
    }
  }
  const text = `[… ${parts.join('; ')} — elided, not code]`
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…]`
}

/** 超长行的切点候选：JSON 字段边界、句末、子句分隔。越靠前越"安全"。 */
const SPLIT_POINTS = ['","', '", "', '",\n', '},', '}, ', '],', '; ', '. ', '。']

/** 切成单元时的目标块大小。 */
const CHUNK_CHARS = 400

/**
 * 把一个超长行切成若干**有结构的**单元。
 *
 * 为什么必须切：一个 4 万字符的单行没法参与"逐行取舍"——选择器只认整行，装不进预算就只能
 * 整条保留（预算失效，实测 20 倍超标）或整条丢掉（信息全丢）。切成单元之后，
 * 常规的优先级 + 打分逻辑就能对它生效，而且**一个字符都没丢**。
 *
 * 切点优先选 JSON 字段边界，其次句末，最后才按固定宽度切。最后一种只会在"本来就没有结构"
 * 的数据上发生（例如一长串 base64），此时按固定宽度切是无损的（只是多了换行）。
 *
 * @param text - 一行文本。
 * @param limit - 单块字符上限。
 * @returns 切好的单元数组；未超限时返回 `undefined`。
 */
export function splitOversized(text, limit = CHUNK_CHARS) {
  if (text.length <= limit) return undefined
  const pieces = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit * 3)
    let at = -1
    for (const point of SPLIT_POINTS) {
      const found = window.lastIndexOf(point, limit * 2)
      if (found > limit * 0.4) {
        at = found + point.length
        break
      }
    }
    if (at < limit * 0.4) {
      // 没有结构可依：按宽度切（无损，只多一个换行）。
      at = limit
    }
    pieces.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest.length > 0) pieces.push(rest)
  return pieces
}
