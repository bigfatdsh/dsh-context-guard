/**
 * 内容类型识别：决定"这段输出该用哪把刀"。
 *
 * 设计原则：**先识别、后压缩**。识别不出来的内容一律只走无损规范化，绝不上结构化
 * 压缩。这样每一种压缩都有一条"它认识这个格式"的理由，也都能被单独测试与关闭。
 *
 * @module dsh-context-guard/detect
 */

import { lineHash } from './text.js'

/** 空行以外的行。 */
function nonEmpty(lines) {
  return lines.filter((line) => line.trim().length > 0)
}

/** 每行括号配平（只看 `{}` / `[]`，且忽略字符串内的括号）。 */
function bracketsBalanced(lines) {
  let depth = 0
  for (const line of lines) {
    let inString = false
    let escaped = false
    for (const ch of line) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\' && inString) {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{' || ch === '[') depth += 1
      else if (ch === '}' || ch === ']') depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0
}

/** 统一的 diff 头 / hunk 头。 */
const DIFF_FILE_RE = /^diff --git |^--- |^\+\+\+ |^Index: /
const DIFF_HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/
const DIFF_BODY_RE = /^[+\- ]/
const DIFF_META_RE =
  /^(new file mode|deleted file mode|similarity index|rename (from|to)|old mode|new mode|Binary files)/

/**
 * 判断是不是 unified diff。
 *
 * @param lines - 行数组。
 * @returns 是 diff 返回 true。
 */
export function isDiff(lines) {
  const body = nonEmpty(lines)
  if (body.length === 0) return false
  let hunks = 0
  let files = 0
  let meta = 0
  let bodyLines = 0
  for (const line of body) {
    if (DIFF_HUNK_RE.test(line)) hunks += 1
    else if (DIFF_META_RE.test(line)) meta += 1
    else if (DIFF_FILE_RE.test(line)) files += 1
    else if (DIFF_BODY_RE.test(line)) bodyLines += 1
  }
  if (hunks > 0 && bodyLines >= 2) return true
  return files > 0 && meta + bodyLines >= 1
}

/** `git status` 的短格式 / 长格式。 */
const STATUS_SHORT_RE = /^ {0,2}(?:\?\?|[MADRCU]{1,2}) \S/
const STATUS_LONG_RE = /^(?:On branch|Your branch|Changes to be committed|Changes not staged|Untracked files|nothing to commit)/

/**
 * 判断是不是 `git status` 输出。
 *
 * @param lines - 行数组。
 * @returns 是 status 返回 true。
 */
export function isGitStatus(lines) {
  const body = nonEmpty(lines)
  if (body.length === 0) return false
  if (body.some((line) => STATUS_LONG_RE.test(line))) return true
  const short = body.filter((line) => STATUS_SHORT_RE.test(line)).length
  return short >= 2 && short >= body.length * 0.5
}

/** 带行号的源码：`  12→code`、`12:code`、`12\tcode`、`    12|code`。 */
const NUMBERED_RE = /^\s{0,8}(\d{1,7})(?:\u2192|[:|]\s?|\t)(.*)$/
/** `cat -n` / `nl` 风格：`     1\tcode`。 */
const NL_RE = /^\s{1,8}\d{1,7}\t(.*)$/

/**
 * 判断是不是"带行号的源码 / 带行号的文件内容"。
 *
 * 命中后只做**极保守**的处理：列宽对齐压缩（把行号列压到最小宽度）与行尾空白清理，
 * 一行代码都不会删。
 *
 * @param lines - 行数组。
 * @returns 是带行号源码返回 true。
 */
export function isNumberedSource(lines) {
  const body = nonEmpty(lines)
  if (body.length < 3) return false
  let hits = 0
  let maxLineNumber = 0
  for (const line of body) {
    const match = NUMBERED_RE.exec(line) ?? NL_RE.exec(line)
    if (match === null) continue
    hits += 1
    const value = Number.parseInt(match[1], 10)
    if (Number.isFinite(value) && value > maxLineNumber) maxLineNumber = value
  }
  return hits >= 3 && hits >= body.length * 0.8
}

/** `ls -l` / `find` 的长格式行。 */
const LS_LONG_RE = /^[-dlbcps][rwxsStT-]{9}[.+]?\s+\d+\s+\S+\s+\S+\s+\d+\s+\w{3}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+\S/
/** 纯路径行（`find`、`git ls-files`、`rg -l`）。 */
const PATH_LINE_RE = /^(?:\.{0,2}\/|~\/|\/|[A-Za-z]:\\)?[\w.@+-]+(?:\/[\w.@+-]+)*\/?$/
/** 目录树分支。 */
const TREE_RE = /^[│├└─\s|`+-]*[├└]── /

/**
 * 判断是不是文件清单（`ls` / `find` / 目录树 / 路径列表）。
 *
 * @param lines - 行数组。
 * @returns 是清单返回 true。
 */
export function isFileListing(lines) {
  const body = nonEmpty(lines)
  if (body.length < 4) return false
  let long = 0
  let paths = 0
  let tree = 0
  for (const line of body) {
    if (LS_LONG_RE.test(line)) long += 1
    else if (TREE_RE.test(line)) tree += 1
    else if (PATH_LINE_RE.test(line) && /[./]/.test(line)) paths += 1
  }
  if (long >= 3 && long >= body.length * 0.5) return true
  if (tree >= 3) return true
  return paths >= 4 && paths >= body.length * 0.7
}

/** JSON 起始形态。 */
const JSON_START_RE = /^\s*[[{]/

/**
 * 判断是不是一段完整的 JSON。
 *
 * 要求能 `JSON.parse` 成功，且长度足够（短 JSON 本来就没多少可压）。
 *
 * @param lines - 行数组。
 * @returns 是 JSON 返回 true。
 */
export function isJson(lines) {
  const body = nonEmpty(lines)
  if (body.length === 0) return false
  const head = body[0]
  if (!JSON_START_RE.test(head)) return false
  const text = body.join('\n').trim()
  if (text.length < 12) return false
  if (!bracketsBalanced(body)) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 带时间戳前缀的日志行。 */
const LOG_TIME_RE =
  /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?Z?\]?|^\s*\[?\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\]?/
/** 日志级别。 */
const LOG_LEVEL_RE = /\b(?:TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/

/**
 * 判断是不是日志流（时间戳 / 级别 / 大量相似行）。
 *
 * @param lines - 行数组。
 * @returns 是日志返回 true。
 */
export function isLogStream(lines) {
  const body = nonEmpty(lines)
  if (body.length < 6) return false
  let stamped = 0
  let leveled = 0
  for (const line of body) {
    if (LOG_TIME_RE.test(line)) stamped += 1
    if (LOG_LEVEL_RE.test(line)) leveled += 1
  }
  if (stamped >= 3 && stamped >= body.length * 0.3) return true
  if (leveled >= 4 && leveled >= body.length * 0.4) return true
  // 高重复度也按日志处理：同样的"模板行"重复出现很多次。
  const seen = new Map()
  let repeats = 0
  for (const line of body) {
    const key = lineHash(line.replace(/\d+/g, '#'))
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count > 1) repeats += 1
  }
  return repeats >= body.length * 0.45 && body.length >= 12
}

/** 编译 / 构建 / 测试产出。 */
const BUILD_RE =
  /(?:^|\s)(?:\d+ (?:passed|failed|pending|skipped)|Tests?:|Test Suites?:|PASS |FAIL |ok \d+ -|not ok \d+ -|error\[E\d+\]|error TS\d+|warning TS\d+|Compiling |Compiled |Finished |Building |Successfully |BUILD SUCCESS|BUILD FAILURE|npm ERR!|pnpm ERR!|make: \*\*\*)/

/**
 * 判断是不是编译 / 测试产出。
 *
 * @param lines - 行数组。
 * @returns 是构建产出返回 true。
 */
export function isBuildOutput(lines) {
  const body = nonEmpty(lines)
  if (body.length < 3) return false
  let hits = 0
  for (const line of body) if (BUILD_RE.test(line)) hits += 1
  return hits >= 2
}

/** 源码特征：常见语言的声明 / 关键字行。 */
const CODE_LINE_RE =
  /^\s*(?:import|export|from|const|let|var|function|class|interface|type|enum|def|async|await|public|private|protected|static|return|if|for|while|switch|case|try|catch|finally|#include|#define|package|use |fn |impl |struct |pub |module |^\s*\/\/|\/\*|\*\/)/

/**
 * 判断是不是源码（不是"带行号的源码"，而是原样贴出的代码块）。
 *
 * @param lines - 行数组。
 * @returns 是源码返回 true。
 */
export function isSourceCode(lines) {
  const body = nonEmpty(lines)
  if (body.length < 4) return false
  let code = 0
  let indented = 0
  for (const line of body) {
    if (CODE_LINE_RE.test(line)) code += 1
    if (/^\s{2,}/.test(line)) indented += 1
  }
  return code >= 3 && code + indented >= body.length * 0.5
}

/** 已知输出类型。 */
export const KINDS = Object.freeze([
  'diff',
  'status',
  'numbered-source',
  'listing',
  'json',
  'log',
  'build',
  'source',
  'plain',
])

/**
 * 识别输出类型。
 *
 * 顺序有意义：越"结构化"的格式越先判，避免 json 里的行被当成源码。
 *
 * @param lines - 规范化之后的行数组。
 * @returns 类型名。
 */
export function detectKind(lines) {
  if (isDiff(lines)) return 'diff'
  if (isGitStatus(lines)) return 'status'
  if (isJson(lines)) return 'json'
  if (isNumberedSource(lines)) return 'numbered-source'
  if (isBuildOutput(lines)) return 'build'
  if (isLogStream(lines)) return 'log'
  if (isFileListing(lines)) return 'listing'
  if (isSourceCode(lines)) return 'source'
  return 'plain'
}
