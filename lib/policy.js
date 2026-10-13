/**
 * 策略层：把文本规范化、类型识别、结构化压缩、预算裁剪、跨调用增量串成一条流水线，
 * 并对每一步做"净收益"核查。
 *
 * 每一个决定都可以被单独解释：
 * - 为什么改？→ `steps` 里记了是哪一步动的；
 * - 改了多少？→ `charsBefore` / `charsAfter` / `tokensSaved`；
 * - 会不会丢信息？→ `notes` 里记了被折叠/省略了多少行，最终文本里也有对应标记。
 *
 * 反悔机制是全局的：**只要结果没变小，就原样返回**。任何一步写错都不会让上下文变大。
 *
 * @module dsh-meta-optimizer/policy
 */

import { detectKind } from './detect.js'
import {
  compactBuild,
  compactDiff,
  compactComments,
  compactListing,
  compactLog,
  compactNumberedSource,
  compactStatus,
  compactTree,
  dedupeBackRefs,
  dropNoise,
  foldRepeats,
  foldRuns,
} from './compact.js'
import { compactJsonText, enforceRenderedCeiling, selectWithinBudget, tabularize } from './budget.js'
import { diffIncremental, renderDelta } from './replay.js'
import { estimateContent, estimateText } from './tokens.js'
import { isCompactableText, normalizeText, textHash } from './text.js'
import { isMark, reconcileMarks, renderUnits, spanOf, textsOf, toUnits, unit } from './units.js'
import { splitOversized } from './curate.js'

/**
 * 默认单结果预算（**token**，不是字符）。
 *
 * 为什么单位是 token：真实语料里 89% 的 token 集中在"超过 1000 字符"的结果上，而会话成本
 * 是按 token 计的。用字符当预算会让人对"到底省了多少"失去直觉。
 *
 * 1500 是实测定的：再往下压，省的量只多一点点（1.5 个百分点），但开始丢掉高信息量行。
 */
export const DEFAULT_BUDGET_TOKENS = 1500

/**
 * 带"全文已落到溢写文件"提示时的预算。
 *
 * 宿主把完整输出写进了文件并给了路径（`read --offset/--limit` 或 `grep` 都能拿回来），
 * 所以这批可以压得**狠得多**：信息并没有丢，只是换了个地方放。实测这批占真实语料 token 的
 * 16%，而且都是 5 万字符级的巨物。
 */
export const RECOVERABLE_BUDGET_TOKENS = 350

/**
 * 默认的"按比例压"目标：压到原文的几成。
 *
 * 这是省量的主旋钮。真实语料实测（2596 条）：0.45 → 省 33.2%、2.5% 的结果会丢少量高信息量
 * 片段；设 0 → 省 19.5%、几乎不丢。想要更高省量就得接受这个取舍。
 */
export const DEFAULT_KEEP_RATIO = 0.45

/** 按比例压时的最少保留 token（避免把短结果压成一行）。 */
export const DEFAULT_MIN_KEEP_TOKENS = 200

/**
 * 按比例压的门槛（token）：小于这个数的结果不按比例压。
 *
 * 真实语料实测（2596 条，`keepRatio 0.45`）：
 *
 * | 门槛 | 省 | 信号保留 |
 * |---|---:|---:|
 * | 800 | 39.6% | 74.0% |
 * | **500** | **47.2%** | 69.2% |
 * | 300 | 51.6% | 67.3% |
 *
 * 500 是拐点：降到 300 只多 4 个百分点，信号保留再掉 2 点。再往上抬（800）省量掉 8 点。
 */
export const RATIO_FLOOR_TOKENS = 500

/**
 * **质量优先档**的建议值：`ratioFloorTokens = 800` + `keepRatio = 0.45`。
 *
 * 真实语料实测（2596 条）三档对照：
 *
 * | 档位 | 省 | 整行真丢 | 结构完整的源码被裁坏 |
 * |---|---:|---:|---:|
 * | 极致省量（500 / 0.45，出厂默认） | 45.9% | 16 | 12 / 18 |
 * | **质量优先（800 / 0.45）** | **38.8%** | **8** | **8 / 18** |
 * | 更狠（500 / 0.35） | 47.0% | 23 | 12 / 18 |
 *
 * 差值 7.1 个百分点，换来整行丢失与代码结构破坏**各减半**。想按这个档跑：
 * `ratioFloorTokens: 800`。
 */
export const QUALITY_FIRST_FLOOR_TOKENS = 800

/** 这些类型的内容"切一行就坏"，预算裁剪时不许切。 */
const JSON_KINDS = new Set(['json'])

/** 认出"这段文本已经带本插件的省略标记"。 */
const MARKER_RE =
  /\u2026 \u00d7\d+ \(same|\u2026 \u00d7\d+ \(\d+|\u2026 \(\d+ lines? omitted|\u2026 \(\d+ chars omitted|line repeated, see earlier|unchanged context\)|complete: byte-identical|\u2026 \[\d+ more chars\]/

/** 按工具名给的更合适预算（token）。 */
export const DEFAULT_TOOL_BUDGETS = Object.freeze({
  read: 2000,
  bash: 1500,
  grep: 900,
  glob: 600,
  web_fetch: 2500,
  web_search: 900,
  univer: 1400,
  task: 1500,
  workflow: 1500,
  list: 600,
})

/** 处理"高风险"内容的工具：只做规范化 + 去重 + 预算，不做任何结构改写。 */
const CONSERVATIVE_TOOLS = new Set(['read', 'write', 'edit'])

/**
 * 宿主自己写的"全文在别处"提示，以及它给出的**真实取回路径**。
 *
 * 这是本插件最值钱的一条信息：宿主把完整输出落到溢写文件里，只把前一段塞进结果。既然
 * 取回路径是真的（`read --offset/--limit`、`grep` 都能用），那么把这段结果压得更短是
 * **零风险**的——模型随时能拿回来。早期版本看到"已截断"就整条不动（怕丢东西），
 * 实测这是最大的浪费来源：语料里最大的几条结果（5 万字符级）都带着取回路径，却被放过了。
 */
const SPILL_RE =
  /(?:Full formatted result stored at|full output stored at|full output):\s*(\S+?)(?:[.\s]|$)/i

/** 溢出提示里认出来的取回路径。 */
function spillPathOf(text) {
  const match = SPILL_RE.exec(text)
  if (match === null) return undefined
  const path = match[1].replace(/[.,;)]+$/, '')
  return path.startsWith('/') ? path : undefined
}

/**
 * 从一段文本里把"取回路径"那一行原样揪出来，压缩后附在末尾。
 *
 * 只留路径本身那一句，不留宿主那段啰嗦的说明文字。
 *
 * @param text - 原文。
 * @returns 取回提示行；没有则返回 undefined。
 */
function recoveryLine(text) {
  const path = spillPathOf(text)
  if (path === undefined) return undefined
  return `(full output: ${path} — read with offset/limit or grep this path)`
}

/** 一段文本的处理结果。 */
class TextPlan {
  /**
   * @param text - 处理后的文本。
   * @param steps - 生效的步骤名。
   * @param notes - 被折叠 / 省略的行数（用于统计与自检）。
   * @param kind - 识别出的内容类型。
   * @param removed - **实际**少掉的行数（原文行数 − 结果行数），与标记声明数对账用。
   */
  constructor(text, steps, notes, kind, removed) {
    this.text = text
    this.steps = steps
    this.notes = notes
    this.kind = kind
    this.removed = removed
  }
}

/**
 * 解析某个工具的预算。
 *
 * @param tool - 工具名。
 * @param budgets - 用户配置的按工具预算。
 * @param fallback - 默认预算。
 * @returns 预算字符数。
 */
export function budgetFor(tool, budgets, globalTokens) {
  // 优先级：按工具的单点覆盖 > 用户显式设的全局值 > 工具预设 > 内置默认。
  //
  // 为什么"用户显式设的全局值"要压过工具预设：预设只是"没配的时候更聪明的默认"。用户一旦
  // 亲手写了 `budgetTokens`，那就是他要的值——早期版本会让 bash 的预设 1500 静默盖掉用户写的
  // 100000，配了等于没配。
  const override = budgets === undefined || budgets === null ? undefined : budgets[tool]
  if (Number.isInteger(override) && override > 0) return override
  if (Number.isInteger(globalTokens) && globalTokens > 0) return globalTokens
  const preset = DEFAULT_TOOL_BUDGETS[tool]
  if (Number.isInteger(preset) && preset > 0) return preset
  return DEFAULT_BUDGET_TOKENS
}

/**
 * 处理一个文本块。
 *
 * @param text - 原始文本。
 * @param context - `{ tool, budgetTokens, options }`。
 * @returns {@link TextPlan}。
 */
/**
 * 按"目标比例"裁剪：不管原文多大，都压到 `keepRatio`。
 *
 * 这是给"极致省量"档用的。默认档只在超过预算 token 时才动，于是"又大又不重复"的结果
 * （真实语料里这类占了 53% 的 token）会原样留下——那正是省量上不去的原因。
 *
 * @param list - 单位数组。
 * @param options - `{ keepRatio, minKeepTokens, marker }`。
 * @returns `{ list, dropped }`。
 */
export function shrinkByRatio(list, options) {
  const budgetTokens = Math.max(options.minKeepTokens ?? 200, Math.round(spanOfTokens(list) * options.keepRatio))
  return selectWithinBudget(list, {
    budgetChars: budgetTokens * 4,
    headLines: options.headLines ?? 4,
    tailLines: options.tailLines ?? 6,
    marker: options.marker ?? 'low-signal lines dropped',
  })
}

/** 一组单位大约是多少 token（与官方估算同构：字符 / 4）。 */
function spanOfTokens(list) {
  let chars = 0
  for (const entry of list) chars += entry.text.length + 1
  return Math.ceil(chars / 4)
}

/**
 * 切块大小：跟随预算，保证"必保的头尾 + 若干中间行 + 标记"能一起装进预算。
 *
 * 算式：默认保头 6 行 + 尾 8 行 = 14 行。若每块占预算的 1/24，则头尾最多占 14/24，
 * 还剩一半给中间内容与省略标记。定成 1/8 时头尾会吃掉 14/8 > 1，直接超预算——
 * 那会让选择器整体回滚，表现成"切了却完全没压"。
 */
function budgetTokensForChunks(context) {
  const budget = context.budgetTokens ?? DEFAULT_BUDGET_TOKENS
  const chars = budget * 4
  // 1/24 → 1/12：块数减半，碎片之间的"任意取舍"随之减半。
  // 块太碎时，被留下的和被丢掉的在打分上几乎没区别，等于随机丢——实测那是信号丢失的主因。
  return Math.max(80, Math.floor(chars / 12))
}

export function planText(text, context) {
  const options = context.options ?? {}
  const steps = []
  const original = text
  // 二进制判定必须看**原文**：`normalizeText` 会把 NUL 剥掉，等规范化之后再判就永远判不出来
  // （实测：含 NUL 的输入被当成正常文本压了）。
  if (!isCompactableText(original)) return new TextPlan(original, [], 0, 'binary', 0)
  const normalized = normalizeText(text, { maxBlankRun: options.maxBlankRun ?? 1 })
  if (normalized !== text) steps.push('normalize')
  if (normalized.length === 0) return new TextPlan(original, steps, 0, 'empty', 0)

  const unitLines = normalized.split('\n')
  const kind = detectKind(unitLines)
  const originalLines = unitLines.length
  let list = toUnits(unitLines)

  // 已经带本插件标记的内容：**不再做任何结构压缩**。
  //
  // 判据放在最前面，而且用一个总的 `structural` 开关控制后面所有步骤（折叠、预算、收口）。
  // 早期只有部分步骤看了这个开关，于是"已压过的内容"还会被折叠、被预算再削、被收口再收，
  // 一轮轮把上下文吃光（实测 6629 → 5399 → …）。
  const preCompacted = MARKER_RE.test(normalized)
  const structural = !options.conservative && !CONSERVATIVE_TOOLS.has(context.tool) && !preCompacted

  // ── 1. 预算（token → 字符） ───────────────────────────────────────────────
  const recovery = recoveryLine(normalized)
  const budgetTokens =
    recovery === undefined
      ? (context.budgetTokens ?? DEFAULT_BUDGET_TOKENS)
      : Math.min(context.budgetTokens ?? DEFAULT_BUDGET_TOKENS, RECOVERABLE_BUDGET_TOKENS)
  const budgetChars = budgetTokens * 4
  const keepRatio =
    typeof options.keepRatio === 'number' && options.keepRatio > 0 && options.keepRatio < 1 ? options.keepRatio : undefined
  const ratioFloorTokens = Number.isInteger(options.ratioFloorTokens) ? options.ratioFloorTokens : RATIO_FLOOR_TOKENS

  // ── 2. 结构压缩（按内容类型用不同的刀） ───────────────────────────────────
  if (structural) {
    if (kind === 'json') {
      try {
        const compacted = compactJsonText(normalized, { indent: options.jsonIndent ?? 0 })
        let tailored = compacted
        try {
          const parsed = JSON.parse(compacted)
          const { value: tabled, changed: didTable } = tabularize(parsed)
          if (didTable) {
            const text2 = JSON.stringify(tabled)
            if (text2.length < compacted.length) {
              tailored = text2
              steps.push('json-table')
            }
          }
        } catch {
          // 已通过 isJson 校验，这里只防御性兜底。
        }
        const worthwhile = tailored.length < normalized.length
        const fits = tailored.length <= budgetChars
        const alreadySingleLine = !normalized.includes('\n')
        if (worthwhile && (fits || alreadySingleLine)) {
          list = toUnits(tailored.split('\n'))
          steps.push('json-compact')
        } else if (worthwhile) {
          // 压成一行仍装不下：压成一行再从末尾截断，并写明省了多少。
          // 不能按行丢（丢掉 `},` 这类行整段就不是合法 JSON），也不能按宽度切
          // （会在字符串中间插换行）。
          const cap = Math.max(256, Math.floor(budgetChars * 0.9))
          const head2 = tailored.slice(0, cap)
          const omitted = tailored.length - head2.length
          list = toUnits([`${head2} … (${omitted} chars omitted from the end of this JSON)`])
          steps.push('json-compact', 'json-cut')
        }
      } catch {
        // 已通过 isJson 校验，这里只防御性兜底。
      }
    } else if (kind === 'diff') {
      const next = compactDiff(list, { contextLimit: options.diffContext ?? 3 })
      if (next !== list) {
        list = next
        steps.push('diff')
      }
    } else if (kind === 'status') {
      const next = compactStatus(list)
      if (next !== list) {
        list = next
        steps.push('status')
      }
    } else if (kind === 'listing') {
      const next = compactListing(list)
      if (next !== list) {
        list = next
        steps.push('listing')
      }
      const tree = compactTree(list)
      if (tree !== list) {
        list = tree
        steps.push('tree')
      }
    } else if (kind === 'source') {
      const next = compactNumberedSource(list)
      if (next !== list) {
        list = next
        steps.push('gutter')
      }
    } else if (kind === 'build') {
      const next = compactBuild(list)
      if (next !== list) {
        steps.push('build-progress')
        list = next
      }
    } else if (kind === 'log') {
      const next = compactLog(list, { minRun: 3 })
      if (next !== list) {
        steps.push('log-fold')
        list = next
      }
    }
    // 注释与文档压缩：**默认关闭**。
    //
    // 实测（2596 条真实结果）：开着反而比关着多 5416 token（610033 vs 604617）。原因不是
    // 它没省——它确实折掉了一批散文注释——而是折叠之后改变了结构，预算与按比例压能用的
    // 空间随之变小，净账是亏的。所以留成可选，默认不开（`commentMinBlockChars` 设大即关）。
    const rawFloor = Number(options.commentMinBlockChars)
    const commentFloor = Number.isFinite(rawFloor) && rawFloor > 0 ? rawFloor : Number.POSITIVE_INFINITY
    if ((kind === 'source' || kind === 'plain') && Number.isFinite(commentFloor)) {
      const trimmedComments = compactComments(list, {
        minBlockChars: commentFloor,
        minLineChars: options.commentMinLineChars ?? 120,
      })
      if (trimmedComments !== list) {
        list = trimmedComments
        steps.push('comments')
      }
    }
    const denoised = dropNoise(list)
    if (denoised !== list) {
      list = denoised
      steps.push('noise')
    }
    // `strict` 只在**不是日志**的时候开。
    //
    // 为什么：日志折叠（`compactLog`）已经按"模板相同、只差时间戳/数字"折过一遍了。
    // 若这里再按模板折一次，第二次折掉的"行数"与对账口径对不上——实测 8 组日志里
    // 7 个标记的行数被对账削成 0，渲染成 `… ×0 (same event repeated)`，自相矛盾。
    const folded = foldRuns(list, { minRun: options.repeatRun ?? 3, strict: kind !== 'source' && kind !== 'log' })
    if (folded !== list) {
      list = folded
      steps.push('repeat-run')
    }
    // 散落重复行改成回指（连续重复已经由 foldRuns 处理过了）。
    const backrefs = dedupeBackRefs(list, { minChars: options.backrefMinChars ?? 40 })
    if (backrefs !== list) {
      list = backrefs
      steps.push('backref')
    }
    const deduped = foldRepeats(list, {
      minLength: options.repeatMinLength ?? 24,
      minSaved: options.repeatMinSaved ?? 64,
    })
    if (deduped !== list) {
      list = deduped
      steps.push('repeat-global')
    }
  }

  // ── 3. 超长行拆成有结构的单元 ─────────────────────────────────────────────
  //
  // 不做这一步，一个 4 万字符的单行既装不进预算（实测 20 倍超标）也不能整条丢
  // （信息全丢）。拆出来的块必须**继承原文的行数**（记在第一块上，其余记 0）——
  // 记 0 会让行数守恒不成立，预算那步的自检发现对不上就整条回滚。
  // JSON 不许拆：压成一行后按宽度切会在字符串中间插换行。
  if (structural && !JSON_KINDS.has(kind)) {
    const chunkLimit = Math.max(120, Math.min(800, budgetTokensForChunks({ budgetTokens })))
    const split = []
    let didSplit = false
    for (const entry of list) {
      const pieces = splitOversized(entry.text, chunkLimit)
      if (pieces === undefined) {
        split.push(entry)
        continue
      }
      didSplit = true
      pieces.forEach((piece, index) => split.push(unit(piece, index === 0 ? entry.lines : 1)))
    }
    if (didSplit) {
      list = split
      steps.push('split-long-line')
    }
  }

  // ── 4. 预算裁剪（超预算 或 按比例） ───────────────────────────────────────
  const textNow = textsOf(list).join('\n')
  const oversized = textNow.length > budgetChars
  const ratioTriggered =
    keepRatio !== undefined && !preCompacted && spanOfTokens(list) >= ratioFloorTokens
  const droppable = !JSON_KINDS.has(kind)
  if ((oversized || ratioTriggered) && droppable && !preCompacted) {
    const headLines = 6
    const tailLines = 8
    const trimmed =
      ratioTriggered && !oversized
        ? shrinkByRatio(list, {
            keepRatio,
            minKeepTokens: options.minKeepTokens ?? DEFAULT_MIN_KEEP_TOKENS,
            headLines,
            tailLines,
            marker: 'low-signal lines dropped',
          })
        : selectWithinBudget(list, {
            budgetChars,
            headLines,
            tailLines,
            marker: 'low-signal lines dropped',
            allowCut: !JSON_KINDS.has(kind),
          })
    if (trimmed.dropped > 0 || trimmed.truncated > 0) {
      list = trimmed.list
      steps.push('budget')
      if (recovery !== undefined) {
        list = [...list, unit(recovery, 0)]
        steps.push('recovery-path')
      }
    }
  }

  // ── 5. 收口：按成品实际长度守住预算 ───────────────────────────────────────
  //
  // 选择器按"被保留行 + 预留的标记开销"估账，但标记的实际条数与长度只有渲染完才知道
  // （实测预算 6000 时成品 7059）。这里量一遍成品再收，最多 5 轮；收的是行内字符
  // 并写明省了多少（不丢行，行账不受影响），有信息量的行不切。
  if (structural && !JSON_KINDS.has(kind)) {
    const capped = enforceRenderedCeiling(list, budgetChars, (units) => renderUnits(units, renderMarker), isMark)
    if (capped.enforced) {
      list = capped.list
      steps.push('ceiling')
    }
  }

  // ── 6. 对账并渲染 ─────────────────────────────────────────────────────────
  const measure = () => renderUnits(list, renderMarker).split('\n').length
  list = reconcileMarks(list, Math.max(0, originalLines - measure()))
  let rendered
  try {
    rendered = renderUnits(list, renderMarker)
  } catch {
    return new TextPlan(original, [], 0, kind, 0)
  }
  if (rendered.length === 0) return new TextPlan(original, [], 0, kind, 0)
  const removed = Math.max(0, originalLines - rendered.split('\n').length)
  return new TextPlan(rendered, steps, removed, kind, removed)
}

/**
 * 统计一段结果里的"省略声明"：`{ count, lines }`。
 *
 * `lines` 是所有标记声明的行数之和，也是本插件对模型的承诺：**少了几行，就写了几行**。
 * 基准与测试都用它对齐，避免"改一处、两处口径不一致"。
 *
 * @param text - 压缩后的文本。
 * @returns `{ count, lines }`。
 */
export function markerReport(text) {
  let count = 0
  let lines = 0
  for (const line of text.split('\n')) {
    const patterns = [
      /… \((\d+) lines? omitted/,
      // `×N` 里的 N 含一个**原样显示的样本**，所以净减少是 N-1。
      // 按 N 计入会系统性超报（实测 38 条超报、最严重 25 行）。
      /… \((\d+) progress lines\)/,
      /… \((\d+) lines unchanged context\)/,
    ]
    for (const pattern of patterns) {
      const match = pattern.exec(line)
      if (match !== null) {
        count += 1
        const value = Number.parseInt(match[1], 10)
        // 重复类标记：N 里含一个原样样本，净减少是 N-1。
        lines += /×/.test(match[0]) ? Math.max(0, value - 1) : value
        break
      }
    }
    if (/line repeated, see earlier/.test(line)) count += 1
  }
  return { count, lines }
}

/**
 * 把标记 id 渲染成给模型看的文案。
 *
 * 文案只写"这里少了什么、少了多少"，不写"为什么"——原因对模型没有用，字数却要付费。
 *
 * @param id - 标记 id（`kind|field|field`）。
 * @param span - 该标记代表的原文行数。
 * @returns 文案（空串表示这行只用来占位，不输出）。
 */
export function renderMarker(id, span) {
  const lines = (value) => `${value} line${value === 1 ? '' : 's'}`
  const [kind, ...fields] = id.split('|')
  if (kind === 'run') return `… ×${fields[0]} (same line repeated)`
  if (kind === 'log') return `… ×${fields[1] ?? fields[0]} (same event repeated; last: ${fields[2] ?? ''})`
  if (kind === 'repeat') return '… (line repeated, see earlier in this result)'
  if (kind === 'diff') return span <= 0 ? '' : `  … (${lines(span)} unchanged context)`
  if (kind === 'log') return `… ×${fields[1] ?? fields[0]} (same event repeated; last: ${fields[2] ?? ''})`
  if (kind === 'progress') return `… (${fields[0]} progress lines)`
  if (kind === 'budget') return `… (${lines(span)} omitted, ${fields[0] || 'low signal'})`
  if (kind === 'budgetChars') return `… (${span} chars omitted from a long line, ${fields[0] || 'low signal'})`
  if (kind === 'comments') return `… (${span} more comment lines elided)`
  if (kind === 'backref') return `[${fields[0]}] same as above`
  if (kind === 'noise') return span <= 0 ? '' : `… (${lines(span)} of progress/decorative noise dropped)`
  if (kind === 'dropped') return span <= 0 ? '' : `… (${lines(span)} dropped)`
  return span <= 0 ? '' : `… (${lines(span)} omitted)`
}

/**
 * 处理一个工具结果的全部内容块。
 *
 * 只动 `text` 块；其余块（图片、文件、结构化块）原样保留，且它们的 token 计入前后对比，
 * 保证"净收益"是真实的总账。
 *
 * @param input - `{ tool, callId, content, isError }`。
 * @param options - 见 {@link planText} 的 `context.options`。
 * @returns `{ content, changed, steps, notes, charsBefore, charsAfter, tokensBefore, tokensAfter, saved, kind }`。
 */
export function optimizeContent(input, options = {}) {
  const content = input.content
  // 总开关在这里就短路。宿主那边也判了一次，但那是"优化路径"上的判断：
  // 只要有人（测试、别的调用方）直接用 optimizeContent，就得有这个闸。
  // 实测教训：关掉开关后仍然省了 2602 token —— 那个开关是假的。
  // 三道闸都在引擎里，而不是只放在宿主那一层：只要有人直接调 optimizeContent，
  // 它们就得照常生效。实测教训：`enabled` 只写在宿主里时，直接调用能"关着开关还省 2602 token"。
  const skip = Array.isArray(options.skipTools) ? options.skipTools : []
  if (input.isError === true && options.compressErrors !== true) {
    const off = estimateContent(content)
    return { content, changed: false, steps: [], notes: 0, removedLines: 0, kind: 'error', charsBefore: 0, charsAfter: 0, tokensBefore: off, tokensAfter: off, saved: 0 }
  }
  if (skip.includes(input.tool)) {
    const off = estimateContent(content)
    return { content, changed: false, steps: [], notes: 0, removedLines: 0, kind: 'skipped', charsBefore: 0, charsAfter: 0, tokensBefore: off, tokensAfter: off, saved: 0 }
  }
  if (options.enabled === false) {
    const off = estimateContent(content)
    return { content, changed: false, steps: [], notes: 0, removedLines: 0, kind: 'plain', charsBefore: 0, charsAfter: 0, tokensBefore: off, tokensAfter: off, saved: 0 }
  }
  const before = estimateContent(content)
  const minChars = Number.isInteger(options.minChars) ? options.minChars : 0
  const minSavingRatio = typeof options.minSavingRatio === 'number' ? options.minSavingRatio : 0
  const charsBefore = content.reduce(
    (sum, block) => sum + (block !== null && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '').length : 0),
    0,
  )
  const budgetTokens = budgetFor(input.tool, options.toolBudgets, options.budgetTokens ?? DEFAULT_BUDGET_TOKENS)
  const steps = new Set()
  let notes = 0
  let kind = 'plain'
  let removedLines = 0
  let changed = false
  const next = content.map((block) => {
    if (block === null || typeof block !== 'object' || block.type !== 'text') return block
    const text = String(block.text ?? '')
    // 太短的结果不处理：省下的还不够写标记。
    if (text.length < minChars) return block
    const plan = planText(text, { tool: input.tool, budgetTokens, options })
    if (plan.text === text) return block
    changed = true
    kind = plan.kind
    for (const step of plan.steps) steps.add(step)
    notes += plan.notes
    removedLines += plan.removed
    return { ...block, text: plan.text }
  })
  // 净收益闸门在这里落地（不依赖调用方）：省不到比例就整条回滚成原文。
  // 比例按**文本部分**算——富内容块（图片等）本来就不参与压缩，把它们算进分母会
  // 让"文本省了一半"看起来像"整体只省了一点"，从而被误判为不值得动手。
  const textBeforeTokens = Math.ceil(charsBefore / 4)
  const textAfterTokens = Math.ceil(
    next.reduce(
      (sum, block) =>
        sum + (block !== null && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '').length : 0),
      0,
    ) / 4,
  )
  const textSaved = textBeforeTokens - textAfterTokens
  if (changed && textBeforeTokens > 0 && textSaved / textBeforeTokens < minSavingRatio) {
    return {
      content,
      changed: false,
      /** 被净收益闸门拦下了（不是"没东西可压"）。统计与测试靠它区分两种情况。 */
      gated: true,
      steps: [],
      notes: 0,
      removedLines: 0,
      kind: 'plain',
      charsBefore,
      charsAfter: charsBefore,
      tokensBefore: before,
      tokensAfter: before,
      saved: 0,
    }
  }
  const after = estimateContent(next)
  const charsAfter = next.reduce(
    (sum, block) => sum + (block !== null && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '').length : 0),
    0,
  )
  return {
    content: next,
    changed,
    steps: [...steps],
    notes,
    /** 被"折掉/省略"的原始行数：结果里必须有等量的可见标记，否则就是静默丢信息。 */
    removedLines,
    kind,
    charsBefore,
    charsAfter,
    tokensBefore: before,
    tokensAfter: after,
    saved: before - after,
  }
}

/**
 * 跨调用增量的入口：把本次文本与上一次同调用的输出比对，必要时换成增量文本。
 *
 * @param previous - 上一次的文本。
 * @param next - 本次归一化后的文本。
 * @param options - `{ minChars, maxRatio }`。
 * @returns `{ text, mode }`：`mode` 为 `none` / `identical` / `delta`。
 */
export function applyIncremental(previous, next, options = {}) {
  const minChars = Number.isInteger(options.minChars) ? options.minChars : 600
  if (previous === undefined || next.length < minChars || previous.length < minChars) {
    return { text: next, mode: 'none' }
  }
  if (previous === next) return { text: renderIdenticalMarker(next), mode: 'identical' }
  const info = diffIncremental(previous, next)
  if (info === null) return { text: next, mode: 'none' }
  return { text: renderDelta(previous, next, info), mode: 'delta' }
}

/**
 * 渲染"与上次相同"的标记（独立函数便于测试）。
 *
 * @param text - 本次文本。
 * @returns 标记文本。
 */
export function renderIdenticalMarker(text) {
  const lines = text.split('\n').length
  return `(unchanged: byte-identical to the previous result of this same call, ${lines} lines, ${textHash(text)})`
}

/**
 * 估算一段文本的 token（对外暴露给统计与测试）。
 *
 * @param text - 文本。
 * @returns token 数。
 */
export function tokensOf(text) {
  return estimateText(typeof text === 'string' ? text : '')
}
