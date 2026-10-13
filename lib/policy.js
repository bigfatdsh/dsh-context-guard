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
 * @module dsh-context-guard/policy
 */

import { detectKind } from './detect.js'
import {
  compactBuild,
  compactDiff,
  compactListing,
  compactLog,
  compactNumberedSource,
  compactStatus,
  compactTree,
  dropNoise,
  foldRepeats,
  foldRuns,
} from './compact.js'
import { compactJsonText, selectWithinBudget } from './budget.js'
import { diffIncremental, renderDelta } from './replay.js'
import { estimateContent, estimateText } from './tokens.js'
import { isCompactableText, normalizeText, textHash } from './text.js'
import { reconcileMarks, renderUnits, spanOf, textsOf, toUnits, unit } from './units.js'

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

export function planText(text, context) {
  const options = context.options ?? {}
  const steps = []
  const original = text

  if (!isCompactableText(text)) return new TextPlan(original, steps, 0, 'binary', 0)

  const normalized = normalizeText(text, { maxBlankRun: options.maxBlankRun ?? 1 })
  if (normalized !== text) steps.push('normalize')
  if (normalized.length === 0) return new TextPlan(original, steps, 0, 'empty', 0)

  const unitLines = normalized.split('\n')
  const kind = detectKind(unitLines)
  let list = toUnits(unitLines)
  const originalLines = unitLines.length

  const structural = !options.conservative && !CONSERVATIVE_TOOLS.has(context.tool)
  if (structural) {
    if (kind === 'json') {
      try {
        const compacted = compactJsonText(normalized, { indent: options.jsonIndent ?? 0 })
        if (compacted.length < normalized.length) {
          list = toUnits(compacted.split('\n'))
          steps.push('json-compact')
        }
      } catch {
        // 已通过 isJson 校验，这里只防御性兜底。
      }
    }
    if (kind === 'diff') {
      const next = compactDiff(list, { contextLimit: options.diffContext ?? 3 })
      if (next.length !== list.length) steps.push('diff-context')
      list = next
    }
    if (kind === 'status') {
      const next = compactStatus(list)
      if (next !== list) steps.push('status-group')
      list = next
    }
    if (kind === 'listing') {
      const tree = compactTree(list)
      if (tree !== list) {
        list = tree
        steps.push('tree-flatten')
      }
      const listing = compactListing(list)
      if (listing !== list) {
        list = listing
        steps.push('listing-columns')
      }
    }
    if (kind === 'numbered-source') {
      const next = compactNumberedSource(list)
      if (next !== list) {
        list = next
        steps.push('gutter')
      }
    }
    if (kind === 'build') {
      const next = compactBuild(list)
      if (next !== list) {
        steps.push('build-progress')
        list = next
      }
    }
    if (kind === 'log') {
      const next = compactLog(list, { minRun: 3 })
      if (next !== list) {
        steps.push('log-fold')
        list = next
      }
    }
  }

  const denoised = dropNoise(list)
  if (denoised !== list) {
    list = denoised
    steps.push('noise')
  }

  const folded = foldRuns(list, { minRun: options.repeatRun ?? 3, strict: kind !== 'source' })
  if (folded !== list) {
    list = folded
    steps.push('repeat-run')
  }

  const deduped = foldRepeats(list, {
    minLength: options.repeatMinLength ?? 24,
    minSaved: options.repeatMinSaved ?? 64,
  })
  if (deduped !== list) {
    list = deduped
    steps.push('repeat-global')
  }

  const textNow = textsOf(list).join('\n')
  // 预算单位是 token（字符 / 4，与 DSH 官方估算同构）。带取回路径的结果用更狠的一档：
  // 全文在溢写文件里，压短不是丢信息，只是换个地方放。
  const recovery = recoveryLine(textNow)
  const budgetTokens =
    recovery === undefined ? (context.budgetTokens ?? DEFAULT_BUDGET_TOKENS) : Math.min(context.budgetTokens ?? DEFAULT_BUDGET_TOKENS, RECOVERABLE_BUDGET_TOKENS)
  const budgetChars = budgetTokens * 4
  const keepRatio = typeof options.keepRatio === 'number' && options.keepRatio > 0 && options.keepRatio < 1 ? options.keepRatio : undefined
  // 两种触发方式：默认"超预算才裁"；开了 keepRatio 就"按比例压"（又大又不重复的那些也压）。
  const oversized = textNow.length > budgetChars
  const ratioTriggered = keepRatio !== undefined && spanOfTokens(list) > (options.minKeepTokens ?? 200)
  if (oversized || ratioTriggered) {
    const headLines = Number.isInteger(options.headLines) ? options.headLines : kind === 'diff' ? 4 : 6
    const tailLines = Number.isInteger(options.tailLines) ? options.tailLines : kind === 'diff' ? 4 : 8
    const trimmed = ratioTriggered
      ? shrinkByRatio(list, {
          keepRatio,
          minKeepTokens: options.minKeepTokens ?? 200,
          headLines,
          tailLines,
          marker: 'low-signal lines dropped',
        })
      : selectWithinBudget(list, {
          budgetChars,
          headLines,
          tailLines,
          marker: 'low-signal lines dropped',
        })
    if (trimmed.dropped > 0) {
      list = trimmed.list
      steps.push('budget')
      // 宿主已经把全文落到溢写文件时，把取回路径原样留在末尾：这样"压得更短"是零风险的，
      // 模型随时能用 read/grep 拿回全文。
      if (recovery !== undefined) {
        list = [...list, unit(recovery, 0)]
        steps.push('recovery-path')
      }
    }
  }

  // 收尾三步：先按"结果里实际少掉多少行"校正每个标记声明的行数，再渲染，最后自校验。
  // 先用当前标记渲染一次，量出"结果到底有多少行"：空标记会被丢掉，
  // 不能用单位个数代替行数（差一行就是对不上账的根源）。
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
      /… ×(\d+) \((?:same line repeated|same event repeated)/,
      /… \((\d+) progress lines\)/,
      /… \((\d+) lines unchanged context\)/,
    ]
    for (const pattern of patterns) {
      const match = pattern.exec(line)
      if (match !== null) {
        count += 1
        lines += Number.parseInt(match[1], 10)
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
  if (kind === 'log') return `… ×${fields[0]} (same event repeated; last: ${fields[1] ?? ''})`
  if (kind === 'repeat') return '… (line repeated, see earlier in this result)'
  if (kind === 'diff') return span <= 0 ? '' : `  … (${lines(span)} unchanged context)`
  if (kind === 'log') return `… ×${fields[0]} (same event repeated; last: ${fields[1] ?? ''})`
  if (kind === 'progress') return `… (${fields[0]} progress lines)`
  if (kind === 'budget') return `… (${lines(span)} omitted, ${fields[0] || 'low signal'})`
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
