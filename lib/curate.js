/**
 * 极致取舍：把"按比例/预算压"做到**有上界、保首尾、报错点名、绝不丢整条**。
 *
 * 这一层是照着 `dsh-tool-token-optimizer` 的 `retain.js` + `sections.js` 的**教训**重写的，
 * 它踩过的坑我原样踩了一遍（实测）：
 *
 * - **预算曾经是假的**：单个单元（一行 4 万字符的 JSON）装不进预算时被整条跳过，
 *   于是"压到 N 字以内"在运行时是假的（实测 40000 字符的输入原样返回，预算是 2000）。
 *   所以这里的第一条铁律是：**结果字符数 ≤ 上界**，超了就在唯一能切的地方切。
 * - **首行与末行不能消失**：开头是格式与接口，末行是结论与退出状态。末行自己就超预算时，
 *   退化成"截断后的末行"，而不是消失。
 * - **报错不许被静默挤掉**：放不下的可疑行必须以**带优先级的摘要**点名，而不是只报一个数字。
 * - **不切开有结构的东西**：只在"本来就没有行结构"的超长行上硬切。
 *
 * @module dsh-meta-optimizer/curate
 */

import { unit } from './units.js'

/** 状态标记行：`[exit code: N]`、`[timed out …]`、`[stderr]` 这类——"这次调用成功没有"的直接答案。 */
const STATUS_MARKER =
  /^\s*\[(?:exit code|timed out|killed by signal|stopped|stderr|stdout|result truncated|output truncated|some output was dropped)[^\]]*\]/i

/**
 * 报错指纹。分两档：
 *
 * - **前缀档**（`ERROR:`、`FAIL:`、`error TS1234:`…）：出现在行首时无条件算报错。
 *   实测教训：只写 `\w*Error\b` 的话，`ERROR: could not resolve dependency "left-pad"`
 *   匹配不上（`\b` 在 `ERROR` 与 `:` 之间不成立），于是这行被当普通行挤掉了——报错被丢
 *   是比多花 token 严重得多的事。
 * - **包含档**：`ENOENT`、`ERR_*`、`Traceback`、堆栈帧这些出现在哪都算。
 */
const ERROR_PREFIX = /^\s*(?:ERROR|ERR|FAIL|FAILED|FATAL|PANIC|CRITICAL|SEVERE|EXCEPTION)\b|^\s*(?:error|err|fail|fatal)[:!]|^\s*\w+Error[:\s]|^\s*(?:error|warning) [A-Z]{1,4}\d+/i
const ERROR_FINGERPRINTS = [
  /\w*(?:Error|Exception)\b/,
  /\b(?:ELIFECYCLE|MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|ETIMEDOUT|ECONNREFUSED|ERR_[A-Z_]+)\b/,
  /^\s*(?:not ok|panic:|fatal:)/,
  /^\s*(?:AssertionError|Assertion failed|Traceback)\b/,
  /^\s*at\s+\S+\s*\(?/,  // 堆栈帧：`  at run (/app/a.js:12:3)`（注意 `at` 前后都有空白）
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
 * `limit` 之前的最后一个空格或逗号处，尽量不把一个词/一个 JSON 键劈成两半；
 * 找不到合适位置才按字符切。
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
 * 收尾：保证每个单位都能装进上界，并给出结果字符数。
 *
 * 这是"上界"真正的执行点。它只做一件在别处做不了的事：**把装不下的超长行切开**
 * （而不是整条丢掉或原样放过）。
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

  // 逐行处理：超长行切开，普通行原样。行数不变，因此行账（单位守恒）不受影响。
  const perLineLimit = Math.max(64, limit)
  let saved = 0
  const out = list.map((entry) => {
    const maxForThis = entry.text.includes('\n') ? perLineLimit : perLineLimit
    if (entry.text.length <= maxForThis) return entry
    const cut = cutLine(entry.text, maxForThis)
    saved += entry.text.length - cut.length
    return unit(cut, entry.lines)
  })
  return { list: out, truncatedChars: saved }
}

/**
 * 给"被丢掉的行"生成一行带优先级的摘要。
 *
 * 目的：让模型知道**中段里还有哪几类东西**，从而判断要不要回读——这比只报一个数字有用得多，
 * 而代价只有一行。
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
  if (buckets.size === 0) return ''
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
  const text = `… dropped from here: ${parts.join('; ')}`
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
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
