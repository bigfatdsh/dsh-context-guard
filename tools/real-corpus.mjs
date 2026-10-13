/**
 * 真实语料基准：拿本机 25 个真实会话的 2596 条工具结果，逐条对比压缩效果。
 *
 * 语料来自 `tools/extract-corpus.mjs`（把 `~/.dsh/sessions` 里的 zstd 分帧日志解成 jsonl）。
 * 这是**唯一**能拿来说事的数字来源：不是合成的、不是我自己造的语料，是真实跑过的工具结果。
 *
 * 用法：
 *   node tools/real-corpus.mjs [语料目录] [--json]
 *
 * 每条结果都会跑：
 * - 原样（基线）
 * - 本插件（`lib/policy.js` 的 `optimizeContent`）
 * - `dsh-tool-token-optimizer`（若在相邻目录里存在，就动态导入它做对照）
 *
 * 并且逐条核对不变量：绝不放大、绝不虚报省略行数、高信息量行必须有交代。
 *
 * @module dsh-context-guard/tools/real-corpus
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DEFAULT_KEEP_RATIO, DEFAULT_MIN_KEEP_TOKENS, markerReport, optimizeContent } from '../lib/policy.js'
import { estimateContent } from '../lib/tokens.js'

/** 出厂的默认档（与 lib/schema.js 的默认值同源，避免基准和线上行为不一致）。 */
const DEFAULTS = { keepRatio: DEFAULT_KEEP_RATIO, minKeepTokens: DEFAULT_MIN_KEEP_TOKENS }

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const DEFAULT_CORPUS = process.env.DSH_CORPUS_DIR ?? join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', '.corpus', 'raw')

/**
 * 高信息量行：丢了就等于丢任务。
 *
 * 用**行**判断（不是逐字比较）：行首的行号/缩进可能被压缩器改写，那是形状不是信息。
 */
const SIGNAL = [
  /\b(?:error|Error|ERROR|failed|Failed|FAILED|panic|fatal|FATAL|Traceback)\b/,
  /^not ok\b/,
  /\b(?:assert|expected|actual|AssertionError)\b/i,
  /\bERR_[A-Z_]+\b|\bE\d{3,4}\b/,
  /:\d+:\d+/,
  /\bexit code\b|\bexit status\b/,
]

/**
 * 抽出一段文本里的"信息索引"：只留**有辨识度**的片段。
 *
 * 为什么不能逐字比较：压缩器会把行号列压到最小宽度、去掉缩进填充（`2757: \t\t if` → `2757:if`），
 * 一个字的意思都没丢，逐字比较却会判它"丢了"。索引只认这些东西：
 *
 * - 路径 / 标识符 / 带点的名字（`lib/policy.js`、`ctx.ptcRuntime`、`ERR_PNPM_IGNORED_BUILDS`）
 * - 四位以上的数字、以及 `文件:行:列` 这种定位
 * - 中文字符（中文输出里几乎每个字都是内容）
 *
 * 反过来，缩进、行尾、列对齐、`	` 与空格之争都不进索引——那些是形状。
 *
 * @param text - 任意文本。
 * @returns 片段集合。
 */
function informationIndex(text) {
  const tokens = new Set()
  for (const match of text.matchAll(/[A-Za-z_][\w.-]{3,}|\d{3,}|[\u4e00-\u9fff]+/g)) tokens.add(match[0])
  return tokens
}

/**
 * 判断原文的信息在结果里有没有交代。
 *
 * @param signalLines - 原文里的高信息量行。
 * @param after - 压缩后的文本。
 * @returns `{ missing }`：真正没交代的片段数。
 */
function signalCoverage(signalLines, after) {
  const have = informationIndex(after)
  let missing = 0
  for (const line of signalLines) {
    for (const token of informationIndex(line)) if (!have.has(token)) missing += 1
  }
  return { missing }
}

/**
 * 把会话日志里的工具调用 id → 名字与参数读出来。
 *
 * @param dir - 语料目录。
 * @returns `{ calls, results }`。
 */
function loadCorpus(dir) {
  const calls = new Map()
  const results = []
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (line.length === 0) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'tool/call') {
        const data = event.data ?? {}
        // 工具名在 data.name。拿不到就会退化成"没有按工具预算"，省量会明显偏低——
        // 之前基准报 19.9%、而按工具预算实测 33.2%，差的就是这一处。
        if (typeof data.callId === 'string') {
          let args = {}
          try {
            args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : (data.arguments ?? {})
          } catch {
            args = {}
          }
          calls.set(data.callId, { name: data.name, args })
        }
        continue
      }
      if (event.type !== 'tool/result') continue
      const message = event.data?.message
      if (message === undefined || !Array.isArray(message.content)) continue
      results.push({ callId: message.toolCallId, content: message.content, session: file })
    }
  }
  return { calls, results }
}

/**
 * 动态加载对照插件。找不到就返回 undefined（基准照跑）。
 *
 * @returns 模块或 undefined。
 */
async function loadRival() {
  const candidates = [
    process.env.DSH_RIVAL_PLUGIN,
    join(here, '..', '..', 'dsh-tool-token-optimizer', 'lib', 'policy.js'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const module = await import(pathToFileURL(candidate).href)
      if (typeof module.optimizeResult === 'function') return module
    } catch {
      // 对照插件依赖缺失时照常跑本插件。
    }
  }
  return undefined
}

/**
 * 一行是不是高信息量。
 *
 * @param line - 一行文本。
 * @returns 是则返回 true。
 */
function isSignal(line) {
  return line.trim().length > 0 && SIGNAL.some((re) => re.test(line))
}

/** 主流程。 */
async function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const dir = args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_CORPUS
  if (!existsSync(dir)) {
    process.stderr.write(`语料目录不存在: ${dir}\n先跑 dsh-tool-token-optimizer/tools/extract-corpus.mjs 生成。\n`)
    process.exitCode = 1
    return
  }

  const rival = await loadRival()
  const { calls, results } = loadCorpus(dir)

  let baseTokens = 0
  let mineTokens = 0
  let rivalTokens = 0
  let mineChanged = 0
  let rivalChanged = 0
  let overClaim = 0
  let grew = 0
  let signalLost = 0
  let rivalSignalLost = 0
  let mineBigger = 0
  let rivalBigger = 0
  let mineWin = 0
  let rivalWin = 0
  let tie = 0
  const byTool = new Map()

  for (const result of results) {
    const meta = calls.get(result.callId) ?? { name: 'unknown', args: {} }
    const content = result.content
    const before = estimateContent(content)
    if (before < 60) continue
    baseTokens += before

    const text = content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
    const signals = text.split('\n').filter(isSignal)

    // 本插件
    let mine = { content, changed: false, saved: 0 }
    try {
      // 用**出厂默认**跑（含 keepRatio / 按工具 token 预算），否则基准报的不是插件的真实行为。
      mine = optimizeContent({ tool: meta.name, content, isError: false }, DEFAULTS)
    } catch {
      mine = { content, changed: false, saved: 0 }
    }
    const mineAfter = estimateContent(mine.content)
    mineTokens += mineAfter
    if (mine.changed) mineChanged += 1
    if (mineAfter > before) {
      grew += 1
      mineBigger += 1
    }
    const mineText = mine.content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
    const report = markerReport(mineText)
    const goneLines = text.split('\n').length - mineText.split('\n').length
    if (report.lines > goneLines) overClaim += 1
    if (signalCoverage(signals, mineText).missing > 0) signalLost += 1

    // 对照插件
    let rivalAfter = before
    if (rival !== undefined) {
      try {
        const out = rival.optimizeResult(
          { tool: meta.name, content, isError: false },
          {
            inlineChars: 1600,
            importantBudgetRatio: 0.4,
            headRatio: 0.55,
            tailRatio: 0.35,
            toolBudgets: {},
            logSavings: false,
          },
        )
        rivalAfter = estimateContent(out.content ?? content)
        if (out.changed === true) rivalChanged += 1
        const rivalText = (out.content ?? content)
          .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
          .map((block) => String(block.text ?? ''))
          .join('\n')
        if (signalCoverage(signals, rivalText).missing > 0) rivalSignalLost += 1
        if (estimateContent(out.content ?? content) > before) rivalBigger += 1
      } catch {
        rivalAfter = before
      }
    }
    rivalTokens += rivalAfter

    if (mineAfter < rivalAfter - 4) mineWin += 1
    else if (rivalAfter < mineAfter - 4) rivalWin += 1
    else tie += 1

    const bucket = byTool.get(meta.name) ?? { count: 0, base: 0, mine: 0, rival: 0 }
    bucket.count += 1
    bucket.base += before
    bucket.mine += mineAfter
    bucket.rival += rivalAfter
    byTool.set(meta.name, bucket)
  }

  const pct = (saved, base) => (base === 0 ? '0.0' : (((1 - saved / base) * 100).toFixed(1)))

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          corpus: dir,
          results: results.length,
          baseTokens,
          mineTokens,
          rivalTokens,
          mineSavedPct: pct(mineTokens, baseTokens),
          rivalSavedPct: pct(rivalTokens, baseTokens),
          mineChanged,
          rivalChanged,
          invariants: { overClaim, grew, signalLost, rivalSignalLost, mineBigger, rivalBigger },
          verdict: { mineWin, rivalWin, tie },
          byTool: Object.fromEntries(byTool),
        },
        null,
        1,
      )}\n`,
    )
    return
  }

  const rows = [
    ['语料', dir],
    ['工具结果条数', String(results.length)],
    ['基线估算 token', String(baseTokens)],
    ['本插件', `${mineTokens}（省 ${pct(mineTokens, baseTokens)}%），改动了 ${mineChanged} 条`],
    ['对照插件', rival === undefined ? '未找到，跳过' : `${rivalTokens}（省 ${pct(rivalTokens, baseTokens)}%），改动了 ${rivalChanged} 条`],
    [],
    ['不变量', `虚报省略行数 ${overClaim} 条；结果变大 ${grew} 条；高信息量行丢失 ${signalLost} 条`],
    ['对照插件不变量', `高信息量行丢失 ${rivalSignalLost} 条；结果变大 ${rivalBigger} 条`],
    [],
    ['逐条胜负', `本插件更小 ${mineWin} 条；对照更小 ${rivalWin} 条；打平 ${tie} 条`],
  ]
  for (const row of rows) process.stdout.write(`${row.join(': ')}\n`)

  process.stdout.write('\n按工具（token：基线 → 本插件 → 对照）\n')
  const tools = [...byTool.entries()].sort((a, b) => b[1].base - a[1].base)
  for (const [tool, bucket] of tools.slice(0, 14)) {
    process.stdout.write(
      `  ${tool.padEnd(22)} ${String(bucket.count).padStart(4)} 条  ${String(bucket.base).padStart(7)} → ${String(bucket.mine).padStart(7)} → ${String(bucket.rival).padStart(7)}\n`,
    )
  }
}

await main()
