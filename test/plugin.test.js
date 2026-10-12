/**
 * 插件层（宿主半边）的测试。
 *
 * 用一个最小 Cordis 上下文替身，直接驱动 `tools/post-execute` 处理器，
 * 证明三件事：
 * 1. 装配正确（监听器挂在 `tools/post-execute` 上、`prepend` 生效、`ctx.effect` 被用）；
 * 2. 该透传的一律透传（报错、富内容、黑名单、太短、关开关）；
 * 3. 该动手时结果确实变小，且**净收益为负时回滚**。
 *
 * @module dsh-context-guard/test/plugin
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { apply, createHandler, name, Stats } from '../lib/index.js'
import { resolveConfig } from '../lib/schema.js'

/** 最小 Cordis 上下文替身。 */
function fakeCtx() {
  const listeners = []
  const effects = []
  const warnings = []
  return {
    listeners,
    effects,
    warnings,
    ctx: {
      on(event, handler, options) {
        listeners.push({ event, handler, options })
        return () => {}
      },
      effect(setup, label) {
        effects.push(label)
        return setup()
      },
      get(key) {
        if (key === 'webServer') {
          return {
            register(spec) {
              listeners.push({ event: 'http', handler: spec.handler, options: spec })
              return () => {}
            },
          }
        }
        return undefined
      },
      logger: {
        info() {},
        warn(message) {
          warnings.push(message)
        },
      },
    },
  }
}

/** 造一个只含字母、逐行不同的词，用来躲开"数字被模板抹平"的折叠。 */
function wordOf(seed) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  let value = seed * 2654435761 % 4294967296
  let out = ''
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[value % 26]
    value = Math.floor(value / 26) + 7
  }
  return out
}

/** 造一条工具结果。 */
const result = (text, extra = {}) => ({ isError: false, content: [{ type: 'text', text }], ...extra })

/** 跑一次处理器。 */
async function run(handler, exec, res, decide) {
  const next = async () => decide ?? { kind: 'accept' }
  return handler(exec, res, next)
}

const bigJson = JSON.stringify(
  { items: Array.from({ length: 80 }, (_, i) => ({ id: i, name: `item-${i}`, tags: ['a', 'b'] })) },
  null,
  2,
)

test('apply 把处理器挂在 tools/post-execute 上并 prepend', () => {
  const { ctx, listeners, effects } = fakeCtx()
  apply(ctx, {})
  const listener = listeners.find((entry) => entry.event === 'tools/post-execute')
  assert.ok(listener !== undefined, '未注册 tools/post-execute')
  assert.equal(listener.options.prepend, true)
  assert.ok(effects.some((label) => /post-execute/.test(label)))
})

test('apply 注册只读统计端点', () => {
  const { ctx, listeners } = fakeCtx()
  apply(ctx, {})
  const http = listeners.find((entry) => entry.event === 'http')
  assert.ok(http !== undefined)
  assert.equal(http.options.path, '/dsh-context-guard/stats')
  assert.equal(http.options.kind, 'exact')
})

test('开关关闭时一个字都不动', async () => {
  const { ctx } = fakeCtx()
  const handler = createHandler(ctx, resolveConfig({ enabled: false }), new Stats())
  const decision = await run(handler, { name: 'bash' }, result(bigJson), { kind: 'accept' })
  assert.equal(decision.content, undefined)
})

test('报错结果默认不动', async () => {
  const { ctx } = fakeCtx()
  const handler = createHandler(ctx, resolveConfig({}), new Stats())
  const errorResult = { isError: true, content: [{ type: 'text', text: bigJson }] }
  const decision = await run(handler, { name: 'bash' }, errorResult, { kind: 'accept' })
  assert.equal(decision.content, undefined)
})

test('富内容块原样保留', async () => {
  const { ctx } = fakeCtx()
  const handler = createHandler(ctx, resolveConfig({}), new Stats())
  const image = { type: 'image', data: 'AAAA', mediaType: 'image/png' }
  const res = { isError: false, content: [image, { type: 'text', text: bigJson }] }
  const decision = await run(handler, { name: 'bash' }, res, { kind: 'accept' })
  assert.equal(decision.content[0], image)
  assert.ok(decision.content[1].text.length < bigJson.length)
})

test('太短的结果不动', async () => {
  const { ctx } = fakeCtx()
  const handler = createHandler(ctx, resolveConfig({ minChars: 400 }), new Stats())
  const decision = await run(handler, { name: 'bash' }, result('short'), { kind: 'accept' })
  assert.equal(decision.content, undefined)
})

test('黑名单工具不动', async () => {
  const { ctx } = fakeCtx()
  const handler = createHandler(ctx, resolveConfig({ skipTools: ['read'] }), new Stats())
  const decision = await run(handler, { name: 'read' }, result(bigJson), { kind: 'accept' })
  assert.equal(decision.content, undefined)
})

test('大 JSON 被压小且仍是合法 JSON', async () => {
  const { ctx } = fakeCtx()
  const stats = new Stats()
  const handler = createHandler(ctx, resolveConfig({}), stats)
  const decision = await run(handler, { name: 'bash' }, result(bigJson), { kind: 'accept' })
  assert.equal(decision.kind, 'accept')
  const text = decision.content[0].text
  assert.ok(text.length < bigJson.length)
  assert.deepEqual(JSON.parse(text), JSON.parse(bigJson))
  assert.ok(stats.tokensSaved > 0)
})

test('上游已经给定 content 时以上游为准', async () => {
  const { ctx } = fakeCtx()
  const handler = createHandler(ctx, resolveConfig({}), new Stats())
  const upstream = [{ type: 'text', text: bigJson }]
  const decision = await run(handler, { name: 'bash' }, result('ignored'), { kind: 'accept', content: upstream })
  assert.ok(decision.content[0].text.length < bigJson.length)
})

test('同一次调用第二次只给增量', async () => {
  const { ctx } = fakeCtx()
  const stats = new Stats()
  const handler = createHandler(ctx, resolveConfig({ incremental: 'delta', incrementalMinChars: 200 }), stats)
  // 每行都必须逐字不同：只要两行能用"抹掉数字"折成同一模板，就会被日志折叠抢先压掉，
  // 那就测不到增量层了。这里用只含字母的句子做变动。
  const body = Array.from({ length: 160 }, (_, i) => `audit entry ${wordOf(i)} recorded by the scheduler`)
  const fileText = body.join('\n')
  const grown = `${fileText}\naudit entry ${wordOf(999)} recorded by the scheduler`
  const exec = { name: 'bash', arguments: { command: 'cat audit.log' }, callId: 'call-1' }

  // 每次都必须新建结果对象：处理器按对象身份做幂等，复用对象会被（正确地）跳过。
  const one = await run(handler, exec, result(fileText), { kind: 'accept' })
  assert.equal(one.content, undefined, '逐行都不同的内容本来就压不动，应当透传')

  const two = await run(handler, exec, result(grown), { kind: 'accept' })
  assert.ok(two.content !== undefined, '第二次应当走增量')
  assert.match(two.content[0].text, /\+ audit entry \w+ recorded by the scheduler/)
  assert.ok(two.content[0].text.length < fileText.length / 4)

  const three = await run(handler, exec, result(fileText), { kind: 'accept' })
  assert.match(three.content[0].text, /unchanged/)
  assert.equal(stats.identicalHits, 0)
  assert.equal(stats.incrementalHits, 2)
})

test('incremental=off 时不做增量', async () => {
  const { ctx } = fakeCtx()
  const handler = createHandler(ctx, resolveConfig({ incremental: 'off' }), new Stats())
  const lines = Array.from({ length: 200 }, (_, i) => `line ${'y'.repeat(i % 4)} ${wordOf(i)} carried no digits at all here`)
  const first = lines.join('\n')
  const exec = { name: 'bash', arguments: { command: 'x' } }
  await run(handler, exec, result(first), { kind: 'accept' })
  const two = await run(handler, exec, result(first), { kind: 'accept' })
  assert.ok(two.content === undefined || !/unchanged/.test(two.content[0].text))
})

test('同一结果对象只处理一次', async () => {
  const { ctx } = fakeCtx()
  const stats = new Stats()
  const handler = createHandler(ctx, resolveConfig({}), stats)
  const res = result(bigJson)
  await run(handler, { name: 'bash' }, res, { kind: 'accept' })
  const seenAfterFirst = stats.seen
  await run(handler, { name: 'bash' }, res, { kind: 'accept' })
  assert.equal(stats.seen, seenAfterFirst)
})

test('省不到 minSavingRatio 就回滚', async () => {
  const { ctx } = fakeCtx()
  const stats = new Stats()
  const handler = createHandler(ctx, resolveConfig({ minSavingRatio: 0.9, incremental: 'off' }), stats)
  const decision = await run(handler, { name: 'bash' }, result(bigJson), { kind: 'accept' })
  assert.equal(decision.content, undefined)
  assert.equal(stats.rollbacks, 1)
})

test('上游抛错时处理器把异常交给调用方（不吞）', async () => {
  const { ctx } = fakeCtx()
  const handler = createHandler(ctx, resolveConfig({}), new Stats())
  await assert.rejects(async () => handler({ name: 'bash' }, result('x'), async () => {
    throw new Error('upstream failed')
  }))
})

test('处理器内部出错时退回上游决定并记 warn', async () => {
  const { ctx, warnings } = fakeCtx()
  const stats = new Stats()
  const handler = createHandler(ctx, resolveConfig({}), stats)
  // content 里放一个取 text 会抛的怪对象，逼出 catch 分支。
  const evil = {
    isError: false,
    content: [
      {
        type: 'text',
        get text() {
          throw new Error('boom')
        },
      },
    ],
  }
  const decision = await run(handler, { name: 'bash' }, evil, { kind: 'accept' })
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(stats.failures, 1)
  assert.ok(warnings.some((line) => /skipped one result/.test(line)))
})

test('统计快照可序列化', () => {
  const stats = new Stats()
  const snapshot = stats.snapshot()
  assert.equal(typeof snapshot.tokensSaved, 'number')
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
})

test('插件名固定', () => {
  assert.equal(name, 'context-guard')
})
