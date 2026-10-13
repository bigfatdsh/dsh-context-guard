/**
 * 会话级计价 CLI：给你一个会话 id，读出它的**真实账**——请求数、prompt 构成（缓存读 /
 * 未命中）、工具结果大小、以及本插件在其中的作用。
 *
 * 为什么需要它：工具结果的压缩率是**单条**指标，而付费是按**整个 prompt × 请求次数**算的。
 * 真实会话实测 prompt 里 99.7% 是缓存读取，工具结果只占 0.08%——不看这张账，很容易
 * 把"单条省了 44%"当成"会话省了 44%"。
 *
 * 用法：
 *
 * ```bash
 * node tools/session-cost.mjs                    # 用最近改动的会话
 * node tools/session-cost.mjs <sessionId> [...]  # 指定会话
 * node tools/session-cost.mjs --all              # 本工作区全部会话
 * node tools/session-cost.mjs --json             # 机器可读
 * ```
 *
 * @module dsh-meta-optimizer/tools/session-cost
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

import { DEFAULT_KEEP_RATIO, DEFAULT_MIN_KEEP_TOKENS, optimizeContent } from '../lib/policy.js'
import { advance, dedupeAcrossResults, ledgerFor, resetLedgers } from '../lib/session.js'
import { renderUnits, toUnits } from '../lib/units.js'

/** zstd 帧头。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 读一份会话日志（zstd 是分帧的，逐帧解）。
 *
 * @param path - `session.v4.jsonl.zstd` 的路径。
 * @returns 事件数组。
 */
function readSession(path) {
  const raw = readFileSync(path)
  let off = 0
  let text = ''
  while (off < raw.length) {
    const start = raw.indexOf(MAGIC, off)
    if (start < 0) break
    const next = raw.indexOf(MAGIC, start + 4)
    const end = next < 0 ? raw.length : next
    try {
      text += zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8')
    } catch {
      // 坏帧跳过：会话日志是追加写的，最后一帧可能还没写完。
    }
    off = end
  }
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/**
 * 统计一个会话。
 *
 * @param dir - 会话目录。
 * @param replay - 是否重跑一遍压缩（会慢，但能给出"本插件在其中的作用"）。
 * @returns 统计对象。
 */
function measure(dir, replay) {
  let events
  try {
    events = readSession(join(dir, 'session.v4.jsonl.zstd'))
  } catch {
    return undefined
  }
  const out = {
    id: dir.split('/').pop().slice(0, 8),
    requests: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    results: 0,
    resultChars: 0,
    singleChars: 0,
    sessionChars: 0,
    refs: 0,
    reusedChars: 0,
  }
  const contents = []
  for (const event of events) {
    const usage = event.usage ?? event.data?.usage
    if (usage !== undefined) {
      out.requests += 1
      out.input += usage.inputTokens ?? 0
      out.cacheRead += usage.cacheReadTokens ?? 0
      out.output += usage.outputTokens ?? 0
    }
    if (event.type === 'tool/result') {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      if (text.length < 200) continue
      out.results += 1
      out.resultChars += text.length
      if (replay) contents.push(content)
    }
  }
  if (!replay) return out

  resetLedgers()
  const ledger = ledgerFor({})
  const options = { keepRatio: DEFAULT_KEEP_RATIO, minKeepTokens: DEFAULT_MIN_KEEP_TOKENS }
  for (const content of contents) {
    const optimized = optimizeContent({ tool: 'bash', content, isError: false }, options)
    const single = optimized.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    out.singleChars += single.length
    const applied = dedupeAcrossResults(toUnits(single.split('\n')), ledger, { minChars: 40, minSavedChars: 24 })
    const text = renderUnits(applied.list, renderMarkerSafe)
    out.sessionChars += text.length
    out.refs += applied.refs
    out.reusedChars += applied.savedChars
    advance(ledger, text, 40)
  }
  return out
}

/** 渲染标记（避免循环 import，单独取一次）。 */
let renderMarkerSafe = (id) => id
try {
  const policy = await import('../lib/policy.js')
  renderMarkerSafe = policy.renderMarker
} catch {
  // 兜底：拿不到就退化成原始 id，只影响 CLI 显示的精度。
}

/** 会话根目录。 */
function sessionRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * 找到本工作区的会话目录。
 *
 * @returns `{ root, ids }`。
 */
function locate() {
  const root = sessionRoot()
  const args = process.argv.slice(2)
  const workspace = process.cwd().replace(/[/.]/g, '-')
  const dirs = readdirSync(root).filter((name) => name.includes(workspace.slice(1, 40)))
  const base = dirs.length > 0 ? join(root, dirs[0]) : root
  if (args.includes('--all')) return { base, ids: readdirSync(base) }
  const given = args.filter((a) => !a.startsWith('--'))
  if (given.length > 0) return { base, ids: given }
  const ids = readdirSync(base)
    .map((id) => {
      try {
        return { id, at: statSync(join(base, id, 'session.v4.jsonl.zstd')).mtimeMs }
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, 1)
    .map((entry) => entry.id)
  return { base, ids }
}

const { base, ids } = locate()
const replay = !process.argv.includes('--fast')
const rows = []
for (const id of ids) {
  const row = measure(join(base, id), replay)
  if (row !== undefined) rows.push(row)
}
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ sessions: rows }, null, 1)}\n`)
} else {
  const total = rows.reduce(
    (sum, row) => {
      for (const key of ['requests', 'input', 'cacheRead', 'output', 'results', 'resultChars', 'singleChars', 'sessionChars', 'refs', 'reusedChars']) {
        sum[key] += row[key]
      }
      return sum
    },
    { requests: 0, input: 0, cacheRead: 0, output: 0, results: 0, resultChars: 0, singleChars: 0, sessionChars: 0, refs: 0, reusedChars: 0 },
  )
  const pct = (a, b) => (b === 0 ? '0.0' : ((1 - a / b) * 100).toFixed(1))
  process.stdout.write(
    [
      `会话 ${rows.length} 个 | 请求 ${total.requests.toLocaleString()}`,
      `  prompt ${(total.input + total.cacheRead).toLocaleString()} tok（缓存读 ${total.cacheRead.toLocaleString()} / 未命中 ${total.input.toLocaleString()}）`,
      `  输出   ${total.output.toLocaleString()} tok`,
      '',
      `  工具结果 ${total.results.toLocaleString()} 条 / ${total.resultChars.toLocaleString()} 字符`,
      ...(replay
        ? [
            `    压缩后           ${total.sessionChars.toLocaleString()} 字符（省 ${pct(total.sessionChars, total.resultChars)}%）`,
            `    其中单条压缩省   ${pct(total.singleChars, total.resultChars)}%`,
            `    其中会话去重多省 ${pct(total.sessionChars, total.singleChars)}%（${total.refs.toLocaleString()} 次引用 / ${total.reusedChars.toLocaleString()} 字符）`,
            '',
            `  工具结果占 prompt 的 ${((total.sessionChars / 4 / (total.input + total.cacheRead)) * 100).toFixed(2)}%`,
            `  省下的 token 会被重读 ${total.requests.toLocaleString()} 次 → 全会话少读约 ${(((total.resultChars - total.sessionChars) / 4) * total.requests / 1e6).toFixed(1)} M tok`,
          ]
        : ['    （--fast 模式不重跑压缩；去掉 --fast 才能给出压缩数据）']),
      '',
    ].join('\n'),
  )
}
