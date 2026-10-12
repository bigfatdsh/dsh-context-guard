/**
 * 结构化压缩器：按内容类型用不同的刀。
 *
 * 每个压缩器都是**纯函数**，输入输出都是 Unit 数组（见 `units.js`）。它们只允许做三件事：
 * 删掉已证明冗余的东西、重排空白的形状、把重复内容折成一个带计数的标记。
 *
 * 关键约定：**造标记时必须把"它代表几行原文"一起带上**（把被折叠单位的 `lines` 加起来）。
 * 这样多个压缩器叠加之后，标记里的数字仍然精确——收尾的 `renderUnits` 会校验总量。
 *
 * @module dsh-context-guard/compact
 */

import { lineHash } from './text.js'
import { isMark, markUnit, spanOf, textsOf, unit } from './units.js'

/** 一行里的数字、十六进制、时间戳都算"变量"，指纹时抹掉。 */
export function templateOf(line) {
  return line
    .replace(/[0-9a-f]{7,}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 折叠连续重复行（允许只有数字/时间戳不同的行）。
 *
 * `a` × 3 以上才折叠：两行重复可能本身就是信息，三行以上几乎必然是噪声。
 *
 * @param list - 单位数组。
 * @param options - `{ minRun, strict }`。
 * @returns 压缩后的单位数组。
 */
export function foldRuns(list, options = {}) {
  const minRun = Number.isInteger(options.minRun) ? options.minRun : 3
  const strict = options.strict === true
  const keyOf = (text) => (strict ? lineHash(templateOf(text)) : lineHash(text))
  const out = []
  let i = 0
  while (i < list.length) {
    const key = keyOf(list[i].text)
    let j = i + 1
    while (j < list.length && keyOf(list[j].text) === key) j += 1
    const run = j - i
    if (run >= minRun) {
      out.push(list[i])
      const foldedLines = spanOf(list.slice(i + 1, j))
      if (foldedLines > 0) out.push(markUnit('run', [run], foldedLines))
    } else {
      for (let k = i; k < j; k += 1) out.push(list[k])
    }
    i = j
  }
  return out
}

/**
 * 全文级去重：同一行出现得够多时，只留第一处，其余折成标记。
 *
 * 门槛刻意设得保守，因为"折掉"是要模型回头翻上下文的：
 * - 一处重复**不折**（只出现两次时，标记比原文还费事）；
 * - 出现次数达到 `minOccurrences`（默认 3）才折；
 * - 真省下来的字符数要达到 `minSaved`。
 *
 * @param list - 单位数组。
 * @param options - `{ minLength, minSaved, minOccurrences }`。
 * @returns 压缩后的单位数组。
 */
export function foldRepeats(list, options = {}) {
  const minLength = Number.isInteger(options.minLength) ? options.minLength : 24
  const minSaved = Number.isInteger(options.minSaved) ? options.minSaved : 64
  const minOccurrences = Number.isInteger(options.minOccurrences) ? options.minOccurrences : 3
  const markerLength = 46
  /** @type {Map<number, number[]>} */
  const positions = new Map()
  list.forEach((entry, index) => {
    if (entry.text.length < minLength || isMark(entry)) return
    const key = lineHash(entry.text)
    const bucket = positions.get(key)
    if (bucket === undefined) positions.set(key, [index])
    else bucket.push(index)
  })
  const drop = new Set()
  for (const bucket of positions.values()) {
    if (bucket.length < minOccurrences) continue
    const length = list[bucket[0]].text.length
    if ((bucket.length - 1) * (length - markerLength) < minSaved) continue
    for (let i = 1; i < bucket.length; i += 1) drop.add(bucket[i])
  }
  if (drop.size === 0) return list
  const out = []
  list.forEach((entry, index) => {
    if (!drop.has(index)) {
      out.push(entry)
      return
    }
    out.push(markUnit('repeat', [], entry.lines))
  })
  return out
}

/**
 * 去掉进度 / 加载 / 装饰噪声行。
 *
 * 只匹配**强特征**：整行都是进度条、旋转指示符、纯分隔线。
 *
 * @param list - 单位数组。
 * @returns 压缩后的单位数组。
 */
export function dropNoise(list) {
  const noise = [
    // 纯分隔线（4 个以上同一符号，且整行只有它）。
    /^\s*(?:={4,}|-{4,}|\*{4,}|#{4,}|~{4,}|_{4,})\s*$/,
    // 百分比进度条。
    /^\s*\d{1,3}%\s*[\s|[\]\u2588\u2591\u2592\u2593#=-]*$/,
    // 纯进度块。
    /^\s*\|?\s*[\u2588\u2591\u2592\u2593]+\s*\|?\s*\d{0,3}%?\s*$/,
    // spinner + 一句短标签。
    /^\s*[\u2800-\u28FF]\s+\S{1,40}\s*$/,
    // 长省略号（进度占位）。**不要**把 `.`/`…` 重复 3 次也算进来：
    // TAP 输出里 `...` 是"详情被省略"的语义标记，删了就看不出这里有内容。
    /^\s*(?:…{2,}|\.{4,})\s*$/,
  ]
  const kept = list.filter((entry) => !noise.some((re) => re.test(entry.text)))
  if (kept.length === list.length) return list
  const removed = spanOf(list) - spanOf(kept)
  // 装饰行本身没有信息，但"整段少了几行"仍然要交代。
  return removed > 0 ? [...kept, markUnit('noise', [], removed)] : kept
}

/** `ls -l` 的权限列。 */
const LS_LONG_RE =
  /^([-dlbcps][rwxsStT-]{9}[.+]?)[ \t]+(\d+)[ \t]+\S+[ \t]+\S+[ \t]+(\d+)[ \t]+(\w{3}[ \t]+\d{1,2}[ \t]+(?:\d{2}:\d{2}|\d{4}))[ \t]+(\S.*)$/

/**
 * 文件清单压缩。
 *
 * - `ls -l`：当所有行的权限列去掉文件类型位后完全一致时，把权限列压成一次说明，
 *   每行只剩 `size date name`；
 * - 去掉 `.` 与 `..` 两行。
 *
 * @param list - 单位数组。
 * @returns 压缩后的单位数组。
 */
export function compactListing(list) {
  const parsed = list.map((entry) => LS_LONG_RE.exec(entry.text))
  const matched = parsed.filter((match) => match !== null)
  let out = list
  if (matched.length >= 4 && matched.length >= list.length * 0.7) {
    const modes = new Set(matched.map((match) => match[1].slice(1)))
    if (modes.size === 1) {
      const rewritten = []
      for (let index = 0; index < list.length; index += 1) {
        const match = parsed[index]
        if (match === null) {
          rewritten.push(list[index])
          continue
        }
        // 捕获组顺序：1 权限、2 硬链接数、3 大小、4 时间、5 名字。
        rewritten.push(unit(`${match[3]} ${match[4]} ${match[5]}`, list[index].lines))
      }
      // 说明行不占原文行（lines: 0），因此总量仍然对得上。
      out = [unit(`# ls -l: all entries ${matched[0][1]} (mode column dropped)`, 0), ...rewritten]
    }
  }
  const filtered = out.filter((entry) => entry.text.trim() !== '.' && entry.text.trim() !== '..')
  if (filtered.length === out.length) return out
  const removed = spanOf(out) - spanOf(filtered)
  return removed > 0 ? [...filtered, markUnit('dropped', [], removed)] : filtered
}

/** 目录树分支前缀。 */
const TREE_PREFIX_RE = /^([\u2502\u251C\u2514\u2500\s|`+-]*)/
const TREE_MARK_RE = /[\u251C\u2514]\u2500\u2500 /

/**
 * 目录树压缩：把 `├── ` / `└── ` / `│   ` 这类画线前缀压成纯缩进。
 *
 * 结构和层级完全保留，只是不再画框。
 *
 * @param list - 单位数组。
 * @returns 压缩后的单位数组。
 */
export function compactTree(list) {
  let hits = 0
  const out = list.map((entry) => {
    if (!TREE_MARK_RE.test(entry.text)) return entry
    const prefix = TREE_PREFIX_RE.exec(entry.text)[1]
    const depth = (prefix.match(/[\u2502\u251C\u2514]/g) ?? []).length
    hits += 1
    return unit(`${'  '.repeat(Math.max(0, depth))}${entry.text.slice(prefix.length)}`, entry.lines)
  })
  return hits >= 3 ? out : list
}

/**
 * 带行号源码压缩：把行号列压到最小宽度并对齐，去掉行号与代码之间的多余填充。
 *
 * 代码一个字符都不动。
 *
 * @param list - 单位数组。
 * @returns 压缩后的单位数组。
 */
export function compactNumberedSource(list) {
  const parsed = list.map((entry) => /^\s{0,8}(\d{1,7})(\u2192|[:|\t])\s?(.*)$/.exec(entry.text))
  const matched = parsed.filter((match) => match !== null)
  if (matched.length < 3) return list
  let max = 0
  for (const match of matched) max = Math.max(max, match[1].length)
  let before = 0
  let after = 0
  const out = list.map((entry, index) => {
    const match = parsed[index]
    if (match === null) return entry
    before += entry.text.length
    const next = unit(`${match[1].padStart(max)}:${match[3]}`, entry.lines)
    after += next.text.length
    return next
  })
  return after < before ? out : list
}

/** diff 的元信息行。 */
const DIFF_META_RE =
  /^(index |old mode|new mode|similarity index|rename from|rename to|new file mode|deleted file mode)/

/**
 * diff 压缩。
 *
 * - 把每个文件的 `index` / `---` / `+++` 头折成一行 `# <path> (+a/-b)`（不占原文行）；
 * - 保留**全部**增删行（那是 diff 的全部价值），上下文行超过 `contextLimit` 时
 *   只留紧邻变动的前后各 `contextLimit` 行，其余折成一个标记并写明丢了多少行；
 * - `\ No newline at end of file` 折进它上一行（本身没有信息）。
 *
 * @param list - 单位数组。
 * @param options - `{ contextLimit }`，默认 3。
 * @returns 压缩后的单位数组。
 */
export function compactDiff(list, options = {}) {
  const contextLimit = Number.isInteger(options.contextLimit) ? options.contextLimit : 3
  const out = []
  let index = 0
  let currentPath = null
  let fileAdded = 0
  let fileRemoved = 0
  let headerLines = 0
  const flushHeader = () => {
    if (currentPath === null) return
    const counts = fileAdded + fileRemoved > 0 ? ` (+${fileAdded}/-${fileRemoved})` : ''
    // 说明行不新增输出行，但它**代表**被折掉的 diff 元信息行（diff --git / index / --- / +++），
    // 行数必须记账，否则收尾的总量守恒校验会失败。
    out.push(unit(`# ${currentPath}${counts}`, headerLines))
    currentPath = null
    fileAdded = 0
    fileRemoved = 0
    headerLines = 0
  }
  while (index < list.length) {
    const entry = list[index]
    const line = entry.text
    if (line.startsWith('diff --git ')) {
      flushHeader()
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      currentPath = match === null ? line.slice(11) : match[2]
      headerLines += entry.lines
      index += 1
      continue
    }
    if (DIFF_META_RE.test(line)) {
      if (/^new file mode/.test(line) && currentPath !== null) currentPath += ' [new]'
      if (/^deleted file mode/.test(line) && currentPath !== null) currentPath += ' [deleted]'
      headerLines += entry.lines
      index += 1
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (line.startsWith('--- /dev/null') || line.startsWith('+++ /dev/null')) {
        index += 1
        continue
      }
      const candidate = line.slice(4).replace(/^(?:a|b)\//, '')
      if (currentPath === null) currentPath = candidate
      headerLines += entry.lines
      index += 1
      continue
    }
    if (line.startsWith('@@')) {
      // 先把文件头落下来：否则整段 diff 的增删计数会在最后结算，头行会跑到 hunk 后面。
      flushHeader()
      out.push(entry)
      index += 1
      const hunk = []
      while (
        index < list.length &&
        !list[index].text.startsWith('@@') &&
        !list[index].text.startsWith('diff --git ') &&
        // `\ No newline` 是脚注：不参与上下文裁剪，交给主循环折进上一行。
        !list[index].text.startsWith('\\ No newline')
      ) {
        hunk.push(list[index])
        index += 1
      }
      const keep = new Array(hunk.length).fill(false)
      hunk.forEach((item, position) => {
        if (item.text.startsWith('+')) {
          fileAdded += 1
          keep[position] = true
        } else if (item.text.startsWith('-')) {
          fileRemoved += 1
          keep[position] = true
        }
      })
      for (let position = 0; position < hunk.length; position += 1) {
        if (keep[position]) continue
        for (let d = 1; d <= contextLimit; d += 1) {
          if (position - d >= 0 && keep[position - d]) keep[position] = true
          if (position + d < hunk.length && keep[position + d]) keep[position] = true
        }
      }
      let gap = []
      const flushGap = () => {
        if (gap.length === 0) return
        out.push(markUnit('diff', [], spanOf(gap)))
        gap = []
      }
      for (let position = 0; position < hunk.length; position += 1) {
        if (keep[position]) {
          flushGap()
          out.push(hunk[position])
        } else {
          gap.push(hunk[position])
        }
      }
      flushGap()
      continue
    }
    if (/^\\ No newline at end of file$/.test(line)) {
      // 脚注：折进上一行，不单独占一行输出（它本身没有信息量）。
      const last = out[out.length - 1]
      if (last !== undefined && !isMark(last)) {
        // 行数要加上这一行：文本折进了上一行，但"原文有多少行"不能少算。
        out[out.length - 1] = unit(`${last.text} (no trailing newline)`, last.lines + entry.lines)
      }
      index += 1
      continue
    }
    flushHeader()
    out.push(entry)
    index += 1
  }
  flushHeader()
  return out
}

/** `git status` 的文件行。 */
const STATUS_ENTRY_RE = /^\s*(?:\?\?|[MADRCU]{1,2})\s+(\S.*)$/

/**
 * `git status` 压缩：同状态的文件合并成一行，去掉逐行的 `(use "git ...")` 提示。
 *
 * 合并后的单位 `lines` 等于被合并的行数，所以"一共多少个文件"这件事仍然可数。
 *
 * @param list - 单位数组。
 * @returns 压缩后的单位数组。
 */
export function compactStatus(list) {
  /** @type {Map<string, string[]>} */
  const groups = new Map()
  const other = []
  for (const entry of list) {
    const match = STATUS_ENTRY_RE.exec(entry.text)
    if (match === null) {
      if (entry.text.trim().length > 0 && !/^\(use "git /.test(entry.text.trim())) other.push(entry)
      continue
    }
    const status = entry.text.trim().slice(0, 2).trim() || 'M'
    const bucket = groups.get(status) ?? []
    bucket.push(match[1].trim())
    groups.set(status, bucket)
  }
  if (groups.size === 0) return list
  const total = [...groups.values()].reduce((sum, bucket) => sum + bucket.length, 0)
  const single = [...groups.values()].every((bucket) => bucket.length === 1)
  if (single && other.length === list.length - total) return list
  const out = [...other]
  for (const [status, files] of groups) out.push(unit(`${status}: ${files.join(' ')}`, files.length))
  return out
}

/** 日志行里的时间戳 / 数字。 */
const LOG_VARIABLE_RE = /\[\d{4}-\d{2}-\d{2}[^\]]*\]|\[?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]?|\b\d+\b/g

/**
 * 日志压缩：连续的"同一模板、只有时间戳/数字不同"的行折成 `首行 …×N`。
 *
 * 标记嵌在首行里而不是另起一行：日志的阅读方式就是"同一件事重复了多少次"。
 *
 * @param list - 单位数组。
 * @param options - `{ minRun }`，默认 3。
 * @returns 压缩后的单位数组。
 */
export function compactLog(list, options = {}) {
  const minRun = Number.isInteger(options.minRun) ? options.minRun : 3
  const out = []
  let i = 0
  while (i < list.length) {
    const text = list[i].text
    if (!LOG_VARIABLE_RE.test(text)) {
      out.push(list[i])
      i += 1
      continue
    }
    const template = templateOf(text)
    let j = i + 1
    while (j < list.length && templateOf(list[j].text) === template) j += 1
    const run = j - i
    if (run >= minRun) {
      // 整段（含首行）都由这一个标记代表：首行文本已经写在标记前面，行数必须算全，
      // 否则收尾对账时会少算这一行。
      const folded = spanOf(list.slice(i, j))
      const inline = markUnit('log', [run, lastVariable(list[j - 1].text)], folded).text
      out.push(unit(`${text} ${inline}`, folded))
    } else {
      for (let k = i; k < j; k += 1) out.push(list[k])
    }
    i = j
  }
  return out
}

/**
 * 取一行里最后一个被模板抹掉的变量值，用于"重复到几"的说明。
 *
 * @param line - 一行文本。
 * @returns 变量值；没有则返回空字符串。
 */
function lastVariable(line) {
  LOG_VARIABLE_RE.lastIndex = 0
  let found = ''
  let match = LOG_VARIABLE_RE.exec(line)
  while (match !== null) {
    found = match[0]
    match = LOG_VARIABLE_RE.exec(line)
  }
  return found
}

/**
 * 构建 / 测试产出压缩。
 *
 * 只有一条规则：**在没有任何失败信号时**，把连续 3 行以上的进度行折成一个计数标记；
 * 一旦出现 error / fail / ERR，什么都不折。
 *
 * @param list - 单位数组。
 * @returns 压缩后的单位数组。
 */
export function compactBuild(list) {
  const failed = list.some(
    (entry) =>
      /\b(?:error|failed|failure|FAIL|panic|ERR!)\b/.test(entry.text) || /^not ok /.test(entry.text),
  )
  if (failed) return list
  const progress =
    /^\s*(?:Compiling|Building|Downloading|Fetching|Installing|Resolving|Linking|Preparing|Optimizing|Bundling|Transforming|Rendering|Collecting|Starting|Waiting)\b/
  const out = []
  let index = 0
  while (index < list.length) {
    if (!progress.test(list[index].text)) {
      out.push(list[index])
      index += 1
      continue
    }
    const start = index
    while (index < list.length && progress.test(list[index].text)) index += 1
    const count = index - start
    if (count >= 3) out.push(markUnit('progress', [count], spanOf(list.slice(start, index))))
    else for (let k = start; k < index; k += 1) out.push(list[k])
  }
  return out
}

/**
 * 单位数组里的文本行。
 *
 * @param list - 单位数组。
 * @returns 文本行。
 */
export function linesOf(list) {
  return textsOf(list)
}
