/**
 * dsh-context-guard —— 工具结果进上下文之前的最后一道压缩关卡。
 *
 * ## 它站在哪里
 *
 * 挂在宿主的 **`tools/post-execute`** 瀑布钩子上：工具已经跑完、结果还没写进会话与请求
 * 的那一刻。这是唯一一个"既看得见完整原文、又还没付 token"的位置。
 *
 * 为什么只挂这一个钩子：
 * - 它是宿主公开契约（`dsh-tools` 的 `ToolRuntime.postExecute`），不是私有实现；
 * - **根上注册一次就够**。作用域事件按 `scopeTarget()` 路由，无标签监听器是全局的：
 *   标签为祖先的监听器收得到分发到后代键的事件，因此根监听器覆盖所有 agent，
 *   也覆盖 PTC / `run_code` 里的嵌套调用（它们最终都会经过同一条 post-execute）。
 *   不需要给每个 agent 各注册一份，也就不会随 agent 数量增长。
 *
 * ## 处理顺序（每一步都能单独解释、单独关闭）
 *
 * 1. **拒绝改动的闸门**：结果带 `isError`（默认）、非文本块、二进制、太短、工具在黑名单
 *    → 立刻透传，一个字都不动。
 * 2. **跨调用增量**（`incremental`）：同一个"工具名 + 参数"上次的输出还在上下文里时，
 *    本次只给"没变"或"变了哪几行"。
 * 3. **无损规范化 + 结构化压缩 + 预算裁剪**（`policy.js`）：按识别出的内容类型下刀。
 * 4. **净收益闸门**：省不到 `minSavingRatio`、或结果反而变大 → 回滚成原文。
 *
 * 任何一步抛错都只写一条 warn，然后返回 `next()` 的原决定 —— 模型拿到的仍是完整结果。
 * 也就是说，这个插件最坏的情况是"没省"，不会是"出错"。
 *
 * @module dsh-context-guard
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ReplayStore } from './replay.js'
import { Config, resolveConfig } from './schema.js'
import { applyIncremental, optimizeContent } from './policy.js'

/** Cordis 插件名。 */
export const name = 'context-guard'

/**
 * 入口依赖：**没有**。
 *
 * 统计端点用的 `webServer` 走 `ctx.get()` 可选获取：把一个"只是锦上添花"的服务写成硬依赖，
 * 会让整机在其他 profile（没有 webServer 的组合）上拒绝装载本插件——那是拿核心功能去赌
 * 一个诊断端点的可用性，不划算。
 */
export const inject = []

/** 设置面板的展示信息。 */
export const meta = {
  title: '输出前压缩 Context Guard',
  description: '工具结果进上下文之前再做一次极致压缩：类型感知的结构化压缩 + 跨调用增量 + 预算内按信息量取舍；有净收益才动手。',
}

/**
 * 对外暴露给宿主做配置校验的 schema。
 *
 * 名字必须叫 `Config`：Cordis 的 `resolveConfig(runtime, config)` 读的是
 * `runtime.Config['~standard'].validate(config)`，装载阶段会先用它把 profile 里的
 * `config` 校验并补默认值，然后把结果交给 `apply` 的第二个参数。
 */
export { Config }

/** 压缩统计。 */
export class Stats {
  constructor() {
    /** 看到的工具结果数。 */
    this.seen = 0
    /** 真正改动过的结果数。 */
    this.changed = 0
    /** 跨调用增量命中数（完全没变 + 只给增量）。 */
    this.incrementalHits = 0
    /** 完全没变命中数。 */
    this.identicalHits = 0
    /** 回滚次数（省得不够或结果变大）。 */
    this.rollbacks = 0
    /** 出错跳过次数。 */
    this.failures = 0
    /** 累计省下的估算 token。 */
    this.tokensSaved = 0
    /** 累计省下的字符。 */
    this.charsSaved = 0
    /** 各步骤命中次数。 */
    this.steps = new Map()
    /** 各内容类型命中次数。 */
    this.kinds = new Map()
  }

  /**
   * 记一次生效。
   *
   * @param result - {@link optimizeContent} 的返回。
   * @returns 无。
   */
  record(result) {
    this.changed += 1
    this.tokensSaved += result.saved
    this.charsSaved += Math.max(0, result.charsBefore - result.charsAfter)
    for (const step of result.steps) this.steps.set(step, (this.steps.get(step) ?? 0) + 1)
    this.kinds.set(result.kind, (this.kinds.get(result.kind) ?? 0) + 1)
  }

  /**
   * 快照。
   *
   * @returns 可序列化的统计。
   */
  snapshot() {
    return {
      seen: this.seen,
      changed: this.changed,
      incrementalHits: this.incrementalHits,
      identicalHits: this.identicalHits,
      rollbacks: this.rollbacks,
      failures: this.failures,
      tokensSaved: this.tokensSaved,
      charsSaved: this.charsSaved,
      steps: Object.fromEntries(this.steps),
      kinds: Object.fromEntries(this.kinds),
    }
  }
}

/**
 * 创建共享处理器。
 *
 * 处理器是**幂等**的：同一条结果对象只处理一次。
 *
 * @param ctx - Cordis 上下文（仅用于日志）。
 * @param config - 已解析的配置。
 * @param stats - 共享统计。
 * @returns 处理器函数。
 */
export function createHandler(ctx, config, stats) {
  const handled = new WeakSet()
  const store = new ReplayStore({ maxEntries: config.memoryEntries })
  const skip = new Set(config.skipTools)

  /**
   * 处理一条工具结果。
   *
   * @param exec - 工具执行上下文。
   * @param result - 工具结果。
   * @param next - 瀑布链的下一环。
   * @returns 决定对象。
   */
  return async function handler(exec, result, next) {
    const decision = await next()
    if (config.enabled !== true) return decision
    if (result === null || typeof result !== 'object') return decision
    if (handled.has(result)) return decision
    handled.add(result)
    stats.seen += 1

    try {
      const tool = typeof exec?.name === 'string' ? exec.name : 'unknown'
      if (skip.has(tool)) return decision
      if (result.isError === true && config.compressErrors !== true) return decision
      const content = Array.isArray(decision.content) ? decision.content : result.content
      if (!Array.isArray(content) || content.length === 0) return decision

      const callId = typeof exec?.callId === 'string' ? exec.callId : undefined
      const key = ReplayStore.key(tool, exec?.arguments)
      const previous = config.incremental === 'off' ? undefined : store.get(key)

      const outcome = optimizeContent(
        { tool, callId, content, isError: result.isError === true },
        {
          budgetTokens: config.budgetTokens,
          toolBudgets: config.toolBudgets,
          minChars: config.minChars,
          minSavingRatio: config.minSavingRatio,
          incremental: config.incremental,
          incrementalMinChars: config.incrementalMinChars,
          memoryEntries: config.memoryEntries,
          repeatRun: config.repeatRun,
          repeatMinLength: config.repeatMinLength,
          repeatMinSaved: config.repeatMinSaved,
          diffContext: config.diffContext,
          maxBlankRun: config.maxBlankRun,
          jsonIndent: config.jsonIndent,
          conservative: config.conservative,
          previousText: previous === undefined ? undefined : previous.text,
        },
      )

      const nextContent = []
      let incrementalMode = 'none'
      for (const block of outcome.content) {
        if (block === null || typeof block !== 'object' || block.type !== 'text') {
          nextContent.push(block)
          continue
        }
        const text = String(block.text ?? '')
        if (previous === undefined || config.incremental === 'off' || text.length < config.incrementalMinChars) {
          nextContent.push(block)
          continue
        }
        const applied = applyIncremental(previous.text, text, { minChars: config.incrementalMinChars })
        if (applied.mode === 'none') {
          nextContent.push(block)
          continue
        }
        if (config.incremental === 'identical' && applied.mode !== 'identical') {
          nextContent.push(block)
          continue
        }
        incrementalMode = applied.mode
        stats.incrementalHits += 1
        if (applied.mode === 'identical') stats.identicalHits += 1
        nextContent.push({ ...block, text: applied.text })
      }

      // 记账：总是存**本次真实输出**（归一化后、未增量化的），下次比对才有意义。
      if (config.incremental !== 'off') {
        const plain = content
          .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
          .map((block) => String(block.text ?? ''))
          .join('\n')
        store.set(key, plain, callId)
      }

      if (!outcome.changed && incrementalMode === 'none') {
        if (outcome.gated === true) stats.rollbacks += 1
        return decision
      }

      // 净收益闸门：把增量化的结果一起算进去，省得不够就回滚。
      const decided = { ...decision, kind: 'accept', content: nextContent }
      const before = outcome.tokensBefore
      const after = contentTokens(nextContent)
      const saved = before - after
      const ratio = before > 0 ? saved / before : 0
      if (saved <= 0 || (outcome.changed && ratio < config.minSavingRatio && incrementalMode === 'none')) {
        stats.rollbacks += 1
        return decision
      }

      stats.record({ ...outcome, saved, charsAfter: charsOf(nextContent), kind: incrementalMode === 'none' ? outcome.kind : `incremental:${incrementalMode}` })
      writeTrace({
        event: 'optimized',
        tool,
        steps: outcome.steps,
        kind: incrementalMode === 'none' ? outcome.kind : `incremental:${incrementalMode}`,
        charsBefore: outcome.charsBefore,
        charsAfter: charsOf(nextContent),
        tokensSaved: saved,
      })
      if (config.log) {
        ctx?.logger?.info?.(
          `context-guard: ${tool} ${outcome.steps.join('+') || 'incremental'} -${saved}tok (${Math.round(ratio * 100)}%)`,
        )
      }
      return decided
    } catch (error) {
      stats.failures += 1
      ctx?.logger?.warn?.(`context-guard: skipped one result: ${error?.message ?? error}`)
      return decision
    }
  }
}

/** 内容块数组里的文本 token 估算（局部复用，避免循环依赖）。 */
function contentTokens(content) {
  let total = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      total += Math.ceil(String(block.text ?? '').length / 4) + 4
    } else if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
      total += Math.ceil(String(block.name ?? '').length / 4) + Math.ceil(JSON.stringify(block.arguments ?? {}).length / 4) + 4
    } else if (block !== null && typeof block === 'object') {
      total += Math.ceil(JSON.stringify(block).length / 4) + 4
    }
  }
  return total
}

/** 内容块数组里的文本字符数。 */
function charsOf(content) {
  let total = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      total += String(block.text ?? '').length
    }
  }
  return total
}

/**
 * 插件入口。
 *
 * @param ctx - Cordis 上下文。
 * @param rawConfig - 插件配置。
 * @returns 无。
 */
export function apply(ctx, rawConfig) {
  // 立刻拷贝一份：宿主交给插件的 config 对象由 loader 持有（可能被冻结，也可能被上层
  // 复用）。插件**绝不**改写宿主给的对象，只读自己的副本。
  const config = resolveConfig(rawConfig === undefined || rawConfig === null ? {} : { ...rawConfig })
  const stats = new Stats()
  const handler = createHandler(ctx, config, stats)

  // 挂一次，覆盖所有 agent：根监听器不带作用域标签，作用域事件路由会把
  // 分发到任意后代键的事件都放行给它。
  ctx.effect(
    () => ctx.on('tools/post-execute', handler, { prepend: true }),
    'context-guard: post-execute',
  )

  // 装载留痕：Electron 宿主会把 stderr 吞掉，插件的 logger 也未必落到能看的地方。
  // 写一行自己的启动记录，是"插件到底有没有被装载"唯一可靠的证据（排查了两个小时才明白）。
  writeTrace({
    event: 'apply',
    config: summary(config),
    postExecuteListener: true,
    webServer: probeWebServer(ctx),
  })

  if (config.log) {
    ctx?.logger?.info?.(`context-guard ready: budget=${config.budgetTokens}tok incremental=${config.incremental}`)
  }

  mountStatsEndpoint(ctx, stats, config)
}

/** 统计端点的路径。 */
export const STATS_PATH = '/dsh-context-guard/stats'

/** 进程内已注册过端点的标记：同一次启动里 apply 可能被调用多次（多个 app 层各挂一遍）。 */
let statsEndpointMounted = false

/**
 * 复位"端点已挂"标记。只给测试用：模块级状态在同一个进程里跨用例复用，不复位就互相干扰。
 *
 * @returns 无。
 */
export function resetStatsEndpointFlag() {
  statsEndpointMounted = false
}

/**
 * 探测 webServer 服务的当前状态（只用于留痕）。
 *
 * @param ctx - Cordis 上下文。
 * @returns `'absent'` / `'registerable'` / `'unusable'`。
 */
function probeWebServer(ctx) {
  const service = (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    } catch {
      return undefined
    }
  })()
  if (service === undefined) return 'absent'
  return typeof service.register === 'function' ? 'registerable' : 'unusable'
}

/**
 * 挂只读统计端点。
 *
 * 这件事有两个**必须**照顾到的现实（都是实测踩出来的）：
 *
 * 1. **冷启动时 `webServer` 还不存在**。宿主是按行装载的，本插件的行可能排在 webserver 行
 *    之前，那一刻 `ctx.get('webServer')` 是 undefined。所以用 `ctx.inject(['webServer'], cb)`：
 *    服务一旦就绪回调才跑，页面稍后刷新即可用。直接判 undefined 就放弃的话，端点会永远挂不上
 *    （实测：第一次启动报 `registerable`、第二次冷启动报 `absent`，就是这么来的）。
 * 2. **`apply` 可能被调用多次**（多个 app 层各挂一遍，实测三次）。webserver 对重复路径直接抛
 *    `duplicate exact route`，未捕获的抛错会把整个 effect 回滚掉——结果是最先注册成功的那条
 *    路由被后两次失败一起带走，端点 404，而压缩本身照常工作（因为它不依赖 effect）。
 *    所以：注册要幂等（进程内一次性 + try/catch），任何失败都只留痕、不抛。
 *
 * @param ctx - Cordis 上下文。
 * @param stats - 共享统计。
 * @param config - 已解析配置。
 * @returns 无。
 */
function mountStatsEndpoint(ctx, stats, config) {
  const handler = (req, res) => {
    const body = JSON.stringify({ ...stats.snapshot(), config: redact(config) })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  /**
   * 试挂一次。
   *
   * @param webServer - 候选服务。
   * @returns `'registered'`（挂上了）/ `'exists'`（已经在）/ `'missing'`（服务还没有）。
   */
  const tryMount = (webServer) => {
    if (statsEndpointMounted) return 'exists'
    if (webServer === undefined || typeof webServer.register !== 'function') return 'missing'
    try {
      webServer.register({ kind: 'exact', path: STATS_PATH, handler })
      statsEndpointMounted = true
      writeTrace({ event: 'endpoint', path: STATS_PATH, result: 'registered' })
      return 'registered'
    } catch (error) {
      const detail = String(error?.message ?? error)
      // webserver 对重复路径抛错。但"重复"有两种来源：同一进程里别的 apply 挂过了（那就是
      // 搞定了），或者宿主自己占了这条路（那就是真失败）。前者是常态，两种都按"已存在"处理，
      // 端点照样能应答；只有服务压根没有时才算没挂上、继续重试。
      statsEndpointMounted = true
      writeTrace({ event: 'endpoint', path: STATS_PATH, result: 'already-registered', detail })
      return 'exists'
    }
  }

  const service = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    } catch {
      return undefined
    }
  }

  // 三条路一起上，因为**没有**哪条单独可靠（都是真机上试出来的）：
  //  * `ctx.get()` 只在服务**已经**可用时拿得到；冷启动时本插件的行排在 webserver 行前面，
  //    那一刻是 undefined（实测）。
  //  * `ctx.inject` 在"服务变成可用"时回调；如果 webserver 早就绪，它可能根本不回调。
  //  * 本插件可能根本没被 apply（宿主吞掉 stderr 时完全看不出来），所以留痕必须无条件写。
  tryMount(service())
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (injected) => tryMount(injected ?? service()))
    } catch (error) {
      writeTrace({ event: 'inject-threw', detail: String(error?.message ?? error) })
    }
  }
  scheduleRetry(service, tryMount)
}

/** 端点重试的间隔（毫秒）。 */
const RETRY_INTERVAL_MS = 250
/** 端点重试的总时长上限（毫秒）。 */
const RETRY_WINDOW_MS = 30000

/**
 * 在有限时间窗内重试挂端点，服务一就绪就停。
 *
 * 用 `setTimeout` 而不是 `setInterval`：每次只留一个定时器，成功即不再排下一次。
 * 定时器 `unref()`，绝不会拖住宿主退出。
 *
 * @param service - 取当前 webServer 的函数。
 * @param tryMount - 试挂函数。
 * @returns 无。
 */
function scheduleRetry(service, tryMount) {
  if (statsEndpointMounted) return
  const deadline = Date.now() + RETRY_WINDOW_MS
  let attempts = 0
  const tick = () => {
    if (statsEndpointMounted) return
    if (Date.now() > deadline) {
      writeTrace({ event: 'endpoint', path: STATS_PATH, result: 'gave-up', attempts })
      return
    }
    attempts += 1
    if (tryMount(service()) !== 'missing') {
      writeTrace({ event: 'endpoint', path: STATS_PATH, result: 'registered-on-retry', attempts })
      return
    }
    const timer = setTimeout(tick, RETRY_INTERVAL_MS)
    timer.unref?.()
  }
  const timer = setTimeout(tick, RETRY_INTERVAL_MS)
  timer.unref?.()
}

/**
 * 把装载/运行痕迹写到 `<DSH_HOME>/context-guard.trace.jsonl`。
 *
 * 只记**事实**（装没装、配置摘要、有没有 webServer），不记任何工具结果内容。
 * 写失败一律静默：留痕绝不能影响压缩。
 *
 * @param entry - 一条痕迹。
 * @returns 无。
 */
function writeTrace(entry) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    appendFileSync(join(home, 'context-guard.trace.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`)
  } catch {
    // 留痕失败不影响任何功能。
  }
}

/**
 * 配置摘要（给痕迹用，不含任何内容）。
 *
 * @param config - 完整配置。
 * @returns 摘要。
 */
function summary(config) {
  return {
    enabled: config.enabled,
    budgetTokens: config.budgetTokens,
    minChars: config.minChars,
    minSavingRatio: config.minSavingRatio,
    incremental: config.incremental,
    conservative: config.conservative,
    skipTools: config.skipTools.length,
  }
}

/**
 * 端点里只回显"不会泄露内容"的配置项。
 *
 * @param config - 完整配置。
 * @returns 精简配置。
 */
function redact(config) {
  return {
    enabled: config.enabled,
    budgetTokens: config.budgetTokens,
    minChars: config.minChars,
    minSavingRatio: config.minSavingRatio,
    incremental: config.incremental,
    incrementalMinChars: config.incrementalMinChars,
    repeatRun: config.repeatRun,
    diffContext: config.diffContext,
    jsonIndent: config.jsonIndent,
    conservative: config.conservative,
    compressErrors: config.compressErrors,
    skipTools: config.skipTools,
    toolBudgets: config.toolBudgets,
  }
}
