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

import { apply, Config, createHandler, name, resetStatsEndpointFlag, Stats, STATS_PATH } from '../lib/index.js'
import { resolveConfig } from '../lib/schema.js'

/**
 * 最小 Cordis 上下文替身。
 *
 * @param options - `{ noWebServer }`：初始模拟"冷启动时 webServer 还不存在"。
 * @returns `{ ctx, listeners, effects, warnings }`。
 */
function fakeCtx(options = {}) {
  const listeners = []
  const effects = []
  const warnings = []
  const webServer = () => ({
    register(spec) {
      if (listeners.some((entry) => entry.event === 'http' && entry.options.path === spec.path)) {
        throw new Error(`webserver: duplicate exact route "${spec.path}"`)
      }
      listeners.push({ event: 'http', handler: spec.handler, options: spec })
      return () => {}
    },
  })

  const ctx = {
    /** 测试开关：true = 服务还没出现；改回 false = 服务后来就绪。 */
    __noWebServer: options.noWebServer === true,
    on(event, handler, opts) {
      listeners.push({ event, handler, options: opts })
      return () => {}
    },
    effect(setup, label) {
      effects.push(label)
      return setup()
    },
    get(key) {
      if (key !== 'webServer') return undefined
      return ctx.__noWebServer === true ? undefined : webServer()
    },
    /**
     * 宿主的 inject 语义：服务已就绪则立刻回调，否则等服务出现。
     * 替身里只在服务可用时立刻回调（这正是真机上的关键差异所在）。
     *
     * @param deps - 依赖名。
     * @param callback - 就绪回调。
     * @returns 无。
     */
    inject(deps, callback) {
      if (!deps.includes('webServer')) return
      if (ctx.__noWebServer === true) return
      callback(webServer())
    },
    logger: {
      info() {},
      warn(message) {
        warnings.push(message)
      },
    },
  }
  return { ctx, listeners, effects, warnings }
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
  resetStatsEndpointFlag()
  const { ctx, listeners, effects } = fakeCtx()
  apply(ctx, {})
  const listener = listeners.find((entry) => entry.event === 'tools/post-execute')
  assert.ok(listener !== undefined, '未注册 tools/post-execute')
  assert.equal(listener.options.prepend, true)
  assert.ok(effects.some((label) => /post-execute/.test(label)))
})

test('apply 注册只读统计端点', () => {
  resetStatsEndpointFlag()
  const { ctx, listeners } = fakeCtx()
  apply(ctx, {})
  const http = listeners.find((entry) => entry.event === 'http')
  assert.ok(http !== undefined)
  assert.equal(http.options.path, STATS_PATH)
  assert.equal(http.options.kind, 'exact')
})

test('apply 被调用多次时端点只注册一次（重复路径会让 webserver 抛错）', () => {
  resetStatsEndpointFlag()
  const { ctx, listeners } = fakeCtx()
  apply(ctx, {})
  apply(ctx, {})
  apply(ctx, {})
  assert.equal(listeners.filter((entry) => entry.event === 'http').length, 1)
})

test('冷启动时 webServer 还没出现也不抛错，端点等它就绪', async () => {
  resetStatsEndpointFlag()
  const { ctx, listeners } = fakeCtx({ noWebServer: true })
  apply(ctx, {})
  assert.equal(listeners.filter((entry) => entry.event === 'http').length, 0)
  // 定时重试窗口内服务出现 → 自动挂上，不需要重启。
  ctx.__noWebServer = false
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(listeners.filter((entry) => entry.event === 'http').length, 1)
  resetStatsEndpointFlag()
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
  // 预算给足：本用例测的是增量层，"又大又不重复"的内容本来就会被预算裁剪，那会干扰断言。
  const handler = createHandler(ctx, resolveConfig({ incremental: 'delta', incrementalMinChars: 200, budgetTokens: 100000 }), stats)
  // 每行都必须逐字不同：只要两行能用"抹掉数字"折成同一模板，就会被日志折叠抢先压掉，
  // 那就测不到增量层了。这里用只含字母的句子做变动。
  const body = Array.from({ length: 160 }, (_, i) => `audit entry ${wordOf(i)} recorded by the scheduler`)
  const fileText = body.join('\n')
  const grown = `${fileText}\naudit entry ${wordOf(999)} recorded by the scheduler`
  const exec = { name: 'bash', arguments: { command: 'cat audit.log' }, callId: 'call-1' }

  // 每次都必须新建结果对象：处理器按对象身份做幂等，复用对象会被（正确地）跳过。
  const one = await run(handler, exec, result(fileText), { kind: 'accept' })
  // 每行都不同、预算又给足：没有可折的重复，也没有超预算，应当原样透传。
  assert.equal(one.content, undefined, '逐行不同且未超预算的内容应当透传')

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

test('Config 必须是 Standard Schema（宿主装载期直接读它）', () => {
  // Cordis 的 resolveConfig 读的是 `runtime.Config['~standard'].validate(config)`。
  // 早期版本把 Config 导成"字段表"，宿主读到 undefined 后抛
  // `Cannot read properties of undefined (reading 'validate')`，插件静默不激活。
  const standard = Config['~standard']
  assert.equal(typeof standard, 'object')
  assert.equal(typeof standard.validate, 'function')
  const result = standard.validate({ enabled: true })
  assert.equal('then' in result, false, '校验必须同步返回')
  assert.equal(result.issues, undefined)
  assert.equal(result.value.enabled, true)
})

test('Config 对未知键返回 issues（宿主会抛 ValidationError）', () => {
  const result = Config['~standard'].validate({ enable: true })
  assert.ok(Array.isArray(result.issues))
  assert.match(result.issues[0].message, /unknown configuration key/)
})
