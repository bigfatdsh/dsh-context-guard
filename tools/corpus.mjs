/**
 * 语料生成器：造出**形状真实**的工具输出，用来量化压缩率。
 *
 * 这里刻意不用随机噪声填充：每种语料都按真实工具的输出形态拼（行号 + 制表符、
 * unified diff 的 hunk 结构、`ls -l` 的固定列、日志的时间戳 + 级别、JSON 的缩进阶梯）。
 * 压不动的语料也该造出来，否则基准会虚高。
 *
 * @module dsh-meta-optimizer/tools/corpus
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(here, '..', 'test', 'corpus')

/** 造一段源码，带 `行号→` 前缀（DSH 的 read 工具就是这个形状）。 */
function numberedSource(lineCount) {
  const out = []
  for (let i = 1; i <= lineCount; i += 1) {
    const width = String(i).padStart(5)
    if (i % 17 === 0) out.push(`${width}\u2192`)
    else if (i % 5 === 0) out.push(`${width}\u2192  // step ${i}: keep the pipeline deterministic`)
    else if (i % 3 === 0) out.push(`${width}\u2192    return items.map((item) => item.id)`)
    else out.push(`${width}\u2192  const value${i % 11} = compute(input, ${i})`)
  }
  return `${out.join('\n')}\n`
}

/** 造一份 unified diff：多个文件、大段未变上下文。 */
function unifiedDiff() {
  const out = []
  for (let file = 1; file <= 6; file += 1) {
    out.push(`diff --git a/lib/module${file}.js b/lib/module${file}.js`)
    out.push(`index ${(file * 1234567).toString(16)}..${(file * 7654321).toString(16)} 100644`)
    out.push(`--- a/lib/module${file}.js`)
    out.push(`+++ b/lib/module${file}.js`)
    out.push(`@@ -1,${40 + file} +1,${42 + file} @@`)
    for (let i = 0; i < 18; i += 1) out.push(` const stable${i} = load(${i})`)
    out.push(`-const old${file} = legacy(input)`)
    out.push(`+const fresh${file} = modern(input)`)
    out.push(`+const extra${file} = modern(extra)`)
    for (let i = 18; i < 40; i += 1) out.push(` const stable${i} = load(${i})`)
    out.push(`@@ -80,6 +82,7 @@`)
    for (let i = 0; i < 5; i += 1) out.push(` keep${i}()`)
    out.push(`+added${file}()`)
  }
  return out.join('\n')
}

/** 造一段 `ls -l` 长清单。 */
function longListing(entries) {
  const out = []
  for (let i = 0; i < entries; i += 1) {
    const kind = i % 9 === 0 ? 'drwxr-xr-x' : '-rw-r--r--'
    const size = 100 + ((i * 977) % 90000)
    out.push(`${kind}  1 user  staff  ${String(size).padStart(6)} Oct  1 10:${String(i % 60).padStart(2, '0')} asset-${i}.bin`)
  }
  return out.join('\n')
}

/** 造一段带时间戳与级别的运行日志（大量重复事件）。 */
function appLog(lines) {
  const out = []
  for (let i = 0; i < lines; i += 1) {
    const stamp = `2026-01-01 10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`
    if (i % 25 === 0) out.push(`${stamp} WARN  retrying upstream request attempt ${(i % 25) + 1}`)
    else if (i % 97 === 0) out.push(`${stamp} ERROR upstream returned 503 for /api/item/${i}`)
    else out.push(`${stamp} INFO  handled /api/item/${i} in ${10 + (i % 90)}ms`)
  }
  return out.join('\n')
}

/** 造一段构建/测试产出。 */
function buildOutput() {
  const out = ['> dsh-meta-optimizer@1.0.0 test', '> node --test "test/*.test.js"', '']
  for (let i = 0; i < 40; i += 1) out.push(`Compiling src/module${i}.js`)
  for (let i = 0; i < 30; i += 1) out.push(`ok ${i + 1} - 用例 ${i + 1}`)
  out.push('')
  out.push('1..30')
  out.push('# tests 30')
  out.push('# pass 30')
  out.push('# fail 0')
  return out.join('\n')
}

/** 造一段失败测试输出（本插件应当原样保留全部报错）。 */
function failingTestOutput() {
  const out = ['> node --test', '']
  for (let i = 0; i < 12; i += 1) out.push(`ok ${i + 1} - 通过 ${i + 1}`)
  out.push('not ok 13 - 计算应当相等')
  out.push('  ---')
  out.push('    expected: 42')
  out.push('    actual:   41')
  out.push('    at Object.<anonymous> (/app/test/math.test.js:13:9)')
  out.push('  ...')
  out.push('# fail 1')
  return out.join('\n')
}

/** 造一份缩进很深的 JSON（工具返回的结构化数据）。 */
function jsonPayload(items) {
  const value = {
    ok: true,
    page: 1,
    items: Array.from({ length: items }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      tags: ['alpha', 'beta'],
      meta: { size: i * 3, checksum: `c${i}`, nested: { depth: 2, path: `/var/data/${i}` } },
    })),
  }
  return JSON.stringify(value, null, 2)
}

/** 造一段 `git status` 输出。 */
function gitStatus(files) {
  const out = ['On branch main', 'Your branch is up to date with "origin/main".', '', 'Changes not staged for commit:']
  for (let i = 0; i < files; i += 1) out.push(`  modified:   lib/file${i}.js`)
  out.push('')
  out.push('Untracked files:')
  for (let i = 0; i < 8; i += 1) out.push(`  notes/draft-${i}.md`)
  out.push('')
  out.push('no changes added to commit (use "git add" and/or "git commit -a")')
  return out.join('\n')
}

/** 造一段目录树。 */
function directoryTree(dirs) {
  const out = ['project']
  for (let i = 0; i < dirs; i += 1) {
    out.push(`├── dir${i}`)
    for (let j = 0; j < 4; j += 1) out.push(`│   ├── file-${i}-${j}.ts`)
    out.push(`│   └── index.ts`)
  }
  out.push('└── README.md')
  return out.join('\n')
}

/** 造一段重复堆栈（同一处报错被打印很多次）。 */
function repeatedStack(times) {
  const frame = '    at processTicksAndRejections (node:internal/process/task_queues:95:5)'
  const out = []
  for (let i = 0; i < times; i += 1) {
    out.push(`TypeError: cannot read properties of undefined (reading 'id')`)
    out.push(`    at handler (/app/src/router.js:${100 + i}:17)`)
    out.push(frame)
    out.push(frame)
    out.push(frame)
  }
  return out.join('\n')
}

/**
 * 全部语料：`{ id, tool, kind, text }`。
 *
 * `tool` 决定预算与"保守档"，`kind` 只是给人看的标注。
 *
 * @returns 语料数组。
 */
export function corpus() {
  const cases = [
    { id: 'numbered-source', tool: 'read', kind: 'numbered-source', text: numberedSource(600) },
    { id: 'unified-diff', tool: 'bash', kind: 'diff', text: unifiedDiff() },
    { id: 'long-listing', tool: 'bash', kind: 'listing', text: longListing(400) },
    { id: 'app-log', tool: 'bash', kind: 'log', text: appLog(500) },
    { id: 'build-output', tool: 'bash', kind: 'build', text: buildOutput() },
    { id: 'failing-test', tool: 'bash', kind: 'build', text: failingTestOutput() },
    { id: 'json-payload', tool: 'bash', kind: 'json', text: jsonPayload(150) },
    { id: 'git-status', tool: 'bash', kind: 'status', text: gitStatus(60) },
    { id: 'directory-tree', tool: 'bash', kind: 'tree', text: directoryTree(25) },
    { id: 'repeated-stack', tool: 'bash', kind: 'log', text: repeatedStack(40) },
  ]
  // 真实抓取的输出也一起算：它们最接近线上分布。
  try {
    for (const file of readdirSync(corpusDir).sort()) {
      const text = readFileSync(join(corpusDir, file), 'utf8')
      cases.push({ id: `real:${file}`, tool: 'bash', kind: 'real', text })
    }
  } catch {
    // 没抓到真实语料也能跑。
  }
  return cases
}
