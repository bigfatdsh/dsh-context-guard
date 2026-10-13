/**
 * 单位（unit）——整条压缩流水线的公共数据形状。
 *
 * 一个"单位"是流水线里的一行：`{ text, lines }`。`lines` 表示**它代表了几行原文**：
 * 普通行是 1，"这里省掉了 k 行"的标记是 k。
 *
 * 为什么必须自带这个数字：一次压缩里会有多个压缩器叠加（diff 先折上下文，紧接着
 * "连续重复行"又把折出来的区域再折一次）。事后靠行距去猜"这个标记覆盖了几行"，
 * 在标记相邻、嵌套折叠时一定会算错；而自带数字只需要做加法。
 *
 * 收尾时 {@link renderUnits} 会做总量自校验：所有单位的 `lines` 之和必须等于原文行数。
 *
 * @module dsh-meta-optimizer/units
 */

/** 标记定界符。占位符形如 `\u0001…<kind>|<a>|<b>\u0001`。 */
export const MARK = '\u0001'

/** 匹配"整段就是一个标记"的正则。 */
const MARK_RE = new RegExp(`^${MARK}…(.+?)${MARK}$`)

/** 匹配"行内出现一个标记"的正则（日志折叠用）。 */
const INLINE_RE = new RegExp(`${MARK}…(.+?)${MARK}`, 'g')

/**
 * 造一个单位。
 *
 * @param text - 文本（可以是标记占位符，也可以是若干行的合并文本）。
 * @param lines - 它代表了几行原文，默认 1。
 * @returns 单位。
 */
export function unit(text, lines = 1) {
  return { text, lines }
}

/**
 * 造一个标记单位。
 *
 * @param kind - 标记种类。
 * @param fields - 附加字段，会被 `|` 连接进 id。
 * @param lines - 它代表了几行原文。
 * @returns 单位。
 */
export function markUnit(kind, fields, lines) {
  return unit(`${MARK}…${[kind, ...fields].join('|')}${MARK}`, lines)
}

/**
 * 把字符串行数组包成单位（每行算 1 行原文）。
 *
 * @param lines - 文本行。
 * @returns 单位数组。
 */
export function toUnits(lines) {
  return lines.map((line) => unit(line, 1))
}

/**
 * 单位代表的原文行数之和。
 *
 * @param list - 单位数组。
 * @returns 行数。
 */
export function spanOf(list) {
  let total = 0
  for (const entry of list) total += entry.lines
  return total
}

/**
 * 单位里的文本行。
 *
 * @param list - 单位数组。
 * @returns 文本行数组。
 */
export function textsOf(list) {
  return list.map((entry) => entry.text)
}

/**
 * 把单位拼回文本（标记就地渲染成文案）。
 *
 * @param list - 单位数组。
 * @param render - `(id, span) => string`：把标记 id 与它代表的行数渲染成文案。
 * @returns 文本。
 */
export function renderUnits(list, render) {
  const out = []
  for (const entry of list) {
    // 整行标记：整行换成文案（文案可能为空，那这行就消失）。
    const whole = MARK_RE.exec(entry.text)
    if (whole !== null) {
      const rendered = render(whole[1], entry.lines)
      if (rendered.length > 0) out.push(rendered)
      continue
    }
    // 行内标记（日志折叠）：把标记那一段换成文案，行里其余文字保留。
    const text = entry.text.includes(MARK)
      ? entry.text.replace(INLINE_RE, (_match, id) => render(id, entry.lines))
      : entry.text
    if (text.length > 0) out.push(text)
  }
  return out.join('\n')
}

/**
 * 判断单位是不是标记。
 *
 * @param entry - 单位。
 * @returns 是标记返回 true。
 */
export function isMark(entry) {
  return MARK_RE.test(entry.text)
}

/**
 * 解析标记的 id。
 *
 * @param entry - 单位。
 * @returns `{ kind, fields }`；不是标记返回 undefined。
 */
export function parseMark(entry) {
  const match = MARK_RE.exec(entry.text)
  if (match === null) return undefined
  const [kind, ...fields] = match[1].split('|')
  return { kind, fields }
}

/**
 * 找出单位数组里的**所有**标记（包括嵌在行内的日志折叠标记）。
 *
 * @param list - 单位数组。
 * @returns `{ index, kind, fields, lines }` 数组。
 */
export function findMarks(list) {
  const found = []
  list.forEach((entry, index) => {
    const whole = MARK_RE.exec(entry.text)
    if (whole !== null) {
      const [kind, ...fields] = whole[1].split('|')
      found.push({ index, kind, fields, lines: entry.lines, whole: true })
      return
    }
    INLINE_RE.lastIndex = 0
    let match = INLINE_RE.exec(entry.text)
    while (match !== null) {
      const [kind, ...fields] = match[1].split('|')
      found.push({ index, kind, fields, lines: entry.lines, whole: false })
      match = INLINE_RE.exec(entry.text)
    }
  })
  return found
}

/**
 * 标记声称"我覆盖了多少行原文"。
 *
 * 只有自带计数的标记（`run` / `log` / `progress`）才报数；预算省略与重复行折叠的标记
 * 靠 {@link reconcileMarks} 用结果本身反推。
 *
 * @param mark - {@link findMarks} 的条目。
 * @returns 行数；数不出来返回 0。
 */
export function declaredLines(mark) {
  if (mark.kind === 'run' || mark.kind === 'log' || mark.kind === 'progress') {
    const value = Number.parseInt(mark.fields[0] ?? '', 10)
    return Number.isFinite(value) ? value : 0
  }
  return 0
}

/**
 * 让每个标记声明的行数与最终结果严格对账。
 *
 * 规则很朴素：结果里相邻两个标记之间**就是**第一个标记所覆盖的区间上界。于是：
 * - 每个标记的行数先按这个上界截断（绝不虚报）；
 * - 截断后加起来如果比"实际少掉的行数"少，差额补给**最后一个**标记（它守着尾部）。
 *
 * 返回新的单位数组；任何一步算不出来就原样返回（调用方会走回滚）。
 *
 * @param list - 单位数组。
 * @param fallenLines - 结果相对原文实际少掉的行数。
 * @returns 调整过行数的单位数组。
 */
export function reconcileMarks(list, fallenLines) {
  const marks = findMarks(list)
  if (marks.length === 0) return list
  // 每个标记最多能覆盖到"下一个标记所在行"之前的行数。注意这里数的是**原文行**
  // （单位的 lines 之和），不是数组下标——标记自己就代表很多行，用行距会严重低估。
  const caps = marks.map((mark, i) => {
    // 行内标记（日志折叠）只覆盖它自己声明的那一段；整行标记覆盖到下一个标记为止。
    if (!mark.whole) return declaredLines(mark)
    const next = marks[i + 1]
    const end = next === undefined ? list.length : next.index
    let span = 0
    for (let k = mark.index; k < end; k += 1) span += list[k].lines
    return Math.max(0, span)
  })
  const counts = marks.map((mark, i) => {
    const declared = declaredLines(mark)
    if (!mark.whole) return declared
    if (mark.kind === 'budget' || mark.kind === 'repeat' || mark.kind === 'diff') return caps[i]
    return Math.max(0, Math.min(declared, caps[i]))
  })
  const dropped = new Set()
  let total = counts.reduce((sum, value) => sum + value, 0)
  if (total > fallenLines) {
    // 虚报了：从后往前削，削到正好。削不动的（计数已经到 0）就是虚报的那一个，
    // 把它整条标记去掉——宁可这一处不留说明，也不能写一个比实际大的数字。
    let excess = total - fallenLines
    for (let i = counts.length - 1; i >= 0 && excess > 0; i -= 1) {
      const cut = Math.min(counts[i], excess)
      counts[i] -= cut
      excess -= cut
      if (counts[i] === 0 && declaredLines(marks[i]) > 0) dropped.add(i)
    }
  } else if (total < fallenLines) {
    // 少报了（标记行本身还要占一行输出，所以差额几乎总是 1-2 行）：优先补给还有余量的
    // 标记；实在没余量就接受少报——绝不为了凑数字而虚报。
    let deficit = fallenLines - total
    for (let i = counts.length - 1; i >= 0 && deficit > 0; i -= 1) {
      const room = caps[i] - counts[i]
      if (room <= 0) continue
      const add = Math.min(room, deficit)
      counts[i] += add
      deficit -= add
    }
  }
  // 把新的行数写回单位：整行标记改 lines；行内标记改 id 里的第一个字段。
  let cursor = 0
  const out = []
  list.forEach((entry, index) => {
    if (cursor >= marks.length || marks[cursor].index !== index) {
      out.push(entry)
      return
    }
    let text = entry.text
    let lines = entry.lines
    let changed = false
    let removeWhole = false
    while (cursor < marks.length && marks[cursor].index === index) {
      const value = counts[cursor]
      const mark = marks[cursor]
      if (dropped.has(cursor) && MARK_RE.test(text)) {
        removeWhole = true
        cursor += 1
        continue
      }
      if (mark.kind === 'run' || mark.kind === 'log') {
        const fields = [String(value), ...mark.fields.slice(1)]
        const replacement = `${MARK}…${[mark.kind, ...fields].join('|')}${MARK}`
        if (MARK_RE.test(text)) text = replacement
        else text = text.replace(new RegExp(`${MARK}…${escapeRe(mark.kind)}\\|[^${MARK}]*${MARK}`), replacement)
      } else if (MARK_RE.test(text)) {
        lines = value
      }
      changed = true
      cursor += 1
    }
    if (removeWhole) return
    out.push(changed ? { text, lines } : entry)
  })
  return out
}

/**
 * 转义正则里的字面量。
 *
 * @param value - 文本。
 * @returns 转义后的文本。
 */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
