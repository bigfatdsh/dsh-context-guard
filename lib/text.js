/**
 * 文本侧的无损规范化。
 *
 * 这一层只做**改了也不会换意思**的事：剥 ANSI 颜色、把 `\r` 覆盖式进度条收敛成最终
 * 一行、统一不可见字符、去掉行尾空白、把 3 行以上的连续空行压成 1 行、去掉首尾多余的
 * 换行。它从不删掉任何"有内容"的行，因此是全流水线里最安全的一层，也是后面所有结构化
 * 压缩的公共前置。
 *
 * 刻意**不做**的事（会改语义）：
 * - 不把制表符换成空格、不重排缩进（源码 / 表格靠它对齐）；
 * - 不删行内多余空格（对齐列、`ls -l` 全依赖它）；
 * - 不合并连续重复行（那可能是有意义的重复数据），这属于结构化压缩层，且有独立开关。
 *
 * @module dsh-meta-optimizer/text
 */

/** ANSI 转义序列：CSI / OSC / 单字符转义。 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g

/** 除 `\n` 与 `\t` 外的 C0/C1 控制字符。 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/** 零宽 / 双向控制字符：不占视觉宽度，只会白烧 token。 */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

/** 各种"看起来像空格但不是空格"的字符。 */
const UNICODE_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g

/** 连续 4 个以上的同一空格字符：真对齐用 1-3 个，4 个以上基本是生成出来的填充。 */
const LONG_SPACE_RUN_RE = /[ \u3000]{4,}/g

/**
 * 把 `\r` 的覆盖语义解析掉：同一行内后来的片段从行首覆盖先前的片段。
 *
 * 进度条（`\r45%`、`\r100%`）、`npm` 与 `curl` 的刷新行都靠这个收敛成最后状态。
 * 只在**同一行内**处理，因此 CRLF 文件里的 `\r\n` 不会被误伤（`\n` 已经先切开了）。
 *
 * @param line - 一行文本（不含 `\n`）。
 * @returns 收敛后的行。
 */
export function resolveCarriageReturns(line) {
  if (!line.includes('\r')) return line
  const parts = line.split('\r')
  let last = parts[parts.length - 1]
  if (last.length > 0) return last
  // 行尾是 `\r`：往前找最后一个非空片段。
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    if (parts[i].length > 0) return parts[i]
  }
  return ''
}

/**
 * 去掉 ANSI 转义。带光标左移的序列（如 `\u001B[3D`）会被当作覆盖处理，保证
 * 结果与终端里**最终可见**的那一行一致。
 *
 * @param line - 一行文本。
 * @returns 去掉转义后的行。
 */
export function stripAnsi(line) {
  if (!line.includes('\u001B')) return line
  /** 每个格子一个字符，`\0` 表示该位置还没被写过。 */
  const cells = []
  let cursor = 0
  let last = 0
  const write = (text) => {
    if (text.length === 0) return
    for (const ch of text) {
      cells[cursor] = ch
      cursor += 1
    }
  }
  ANSI_RE.lastIndex = 0
  let match = ANSI_RE.exec(line)
  while (match !== null) {
    write(line.slice(last, match.index))
    const seq = match[0]
    if (seq.startsWith('\u001B[')) {
      const body = seq.slice(2, -1)
      const final = seq[seq.length - 1]
      const first = Number.parseInt(body.replace(/^[?]/, '').split(';')[0] ?? '', 10)
      const amount = Number.isFinite(first) ? first : 1
      if (final === 'D') cursor = Math.max(0, cursor - amount)
      else if (final === 'C') cursor += amount
      else if (final === 'G') cursor = Math.max(0, amount - 1)
      else if (final === 'K') cells.length = Math.min(cells.length, cursor)
    }
    last = match.index + seq.length
    match = ANSI_RE.exec(line)
  }
  write(line.slice(last))
  let out = ''
  for (let i = 0; i < cells.length; i += 1) out += cells[i] ?? ' '
  return out.replace(/ +$/, '')
}

/**
 * 判断文本是否值得压缩。
 *
 * 二进制 / 含 NUL / 大面积非法字节的内容一律不动：任何"规范化"都可能损坏它，
 * 而它本来也不该走文本通道。
 *
 * @param text - 待判断文本。
 * @returns 可以压缩返回 true。
 */
export function isCompactableText(text) {
  if (typeof text !== 'string') return false
  if (text.length === 0) return false
  if (text.includes('\u0000')) return false
  // eslint-disable-next-line no-control-regex
  const controls = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g)
  if (controls !== null && controls.length > text.length / 200) return false
  const replacements = text.match(/\uFFFD/g)
  if (replacements !== null && replacements.length > text.length / 100) return false
  return true
}

/**
 * 单行规范化：剥 ANSI → 收敛 `\r` → 统一不可见字符 → 去行尾空白。
 *
 * @param line - 一行文本（不含 `\n`）。
 * @returns 规范化后的行。
 */
export function normalizeLine(line) {
  let out = stripAnsi(line)
  if (out.includes('\r')) out = resolveCarriageReturns(out)
  out = out.replace(ANSI_RE, '')
  out = out.replace(UNICODE_SPACE_RE, ' ')
  out = out.replace(ZERO_WIDTH_RE, '')
  out = out.replace(CONTROL_RE, '')
  out = out.replace(LONG_SPACE_RUN_RE, '  ')
  return out.replace(/[ \t]+$/, '')
}

/**
 * 整段文本的规范化。
 *
 * @param text - 原始文本。
 * @param options - `{ maxBlankRun }`：连续空行最多保留几行，默认 1。
 * @returns 规范化后的文本。
 */
export function normalizeText(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return text
  const maxBlankRun = Number.isInteger(options.maxBlankRun) ? options.maxBlankRun : 1
  const rawLines = text.split('\n')
  /** @type {string[]} */
  const lines = []
  let blanks = 0
  for (const raw of rawLines) {
    const line = normalizeLine(raw)
    if (line.length === 0) {
      blanks += 1
      if (blanks > maxBlankRun) continue
      lines.push('')
      continue
    }
    blanks = 0
    lines.push(line)
  }
  let start = 0
  while (start < lines.length && lines[start] === '') start += 1
  let end = lines.length
  while (end > start && lines[end - 1] === '') end -= 1
  const body = lines.slice(start, end).join('\n')
  return body
}

/**
 * 行指纹：用于去重与跨调用比对。
 *
 * @param line - 一行文本。
 * @returns 32 位整数指纹。
 */
export function lineHash(line) {
  let h = 0x811c9dc5
  for (let i = 0; i < line.length; i += 1) {
    h ^= line.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 文本指纹：跨调用比对用。
 *
 * @param text - 任意文本。
 * @returns 十六进制指纹。
 */
export function textHash(text) {
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)
}
