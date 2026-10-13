/**
 * 配置校验：Standard Schema v1（`~standard.validate`）。
 *
 * 两条刻意的取舍：
 * 1. **未知键一律拒绝**。写错一个键名却"看起来配了"是最贵的 bug 类型——它让人以为
 *    省了 token，其实一个都没省。宁可启动时报错。
 * 2. 校验失败时**退回全默认**，而不是"配置非法就整个插件不生效"。默认值本身就是
 *    安全的那一档（开启压缩、增量默认开、不改写结构）。
 *
 * @module dsh-meta-optimizer/schema
 */

import { DEFAULT_BUDGET_TOKENS, DEFAULT_KEEP_RATIO, DEFAULT_MIN_KEEP_TOKENS } from './policy.js'

/** 单个字段。 */
class Field {
  /**
   * @param options - `{ type, default, min, max, optional, options }`。
   */
  constructor(options) {
    this.type = options.type
    this.default = options.default
    this.min = options.min
    this.max = options.max
    this.choices = options.options
    this.optional = options.optional === true
  }

  /**
   * 校验一个值。
   *
   * @param value - 待校验值。
   * @returns `{ ok, value }` 或 `{ ok: false, message }`。
   */
  check(value) {
    if (value === undefined || value === null) {
      return this.optional ? { ok: true, value: undefined } : { ok: true, value: this.default }
    }
    if (this.type === 'boolean') {
      if (typeof value !== 'boolean') return { ok: false, message: 'expected a boolean' }
      return { ok: true, value }
    }
    if (this.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, message: 'expected a finite number' }
      }
      if (this.min !== undefined && value < this.min) return { ok: false, message: `must be >= ${this.min}` }
      if (this.max !== undefined && value > this.max) return { ok: false, message: `must be <= ${this.max}` }
      return { ok: true, value }
    }
    if (this.type === 'enum') {
      if (!this.choices.includes(value)) {
        return { ok: false, message: `expected one of: ${this.choices.join(', ')}` }
      }
      return { ok: true, value }
    }
    if (this.type === 'record') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, message: 'expected an object of { toolName: charBudget }' }
      }
      /** @type {Record<string, number>} */
      const out = {}
      for (const [key, raw] of Object.entries(value)) {
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
          return { ok: false, message: `"${key}" must be a positive number of characters` }
        }
        out[key] = Math.floor(raw)
      }
      return { ok: true, value: out }
    }
    if (this.type === 'names') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return { ok: false, message: 'expected an array of tool names' }
      }
      return { ok: true, value: [...new Set(value)] }
    }
    return { ok: false, message: `unknown field type "${this.type}"` }
  }
}

/**
 * 配置字段表。
 *
 * 默认值刻意选"安全但有效"：压缩开着、增量开着、结构改写不开。
 */
const FIELDS = {
  /** 总开关。关掉后监听器立刻变成直通，不产生任何额外 token。 */
  enabled: new Field({ type: 'boolean', default: true }),
  /**
   * 单结果**token** 预算的兜底值。
   *
   * 单位是 token（字符 / 4，口径与 DSH 官方估算一致）。实测：真实语料里 89% 的 token
   * 集中在"超过 1000 字符"的结果上，所以这个数直接决定了省量。
   */
  budgetTokens: new Field({ type: 'number', default: DEFAULT_BUDGET_TOKENS, min: 128, max: 200000 }),
  /** 按工具名覆盖预算（token），例如 `{ bash: 800 }`。 */
  toolBudgets: new Field({ type: 'record', default: {} }),
  /**
   * 小于这个字符数的结果完全不处理。
   *
   * 200 是实测定的：语料里最小的可压样本 288 字符就能压掉 38.9%，而一百多字符的输出
   * 本来也没什么可压，省下的还不够写标记。
   */
  minChars: new Field({ type: 'number', default: 200, min: 0, max: 200000 }),
  /**
   * 省不到这个比例就不改。
   *
   * 3% 是实测定的：真实抓取的 `ls -laR` 只能压掉 2.9%，卡在 12% 就整条不动；按 3% 放行
   * 能在不增加任何风险（不变量照旧全过）的前提下多拿到这类边缘收益。最后还有净收益兜底：
   * 省下的 token 必须大于新增标记的开销，否则一样回滚。
   */
  minSavingRatio: new Field({ type: 'number', default: 0.03, min: 0, max: 0.9 }),
  /** 跨调用增量：同一调用重复执行时只给"没变"或"变了哪几行"。 */
  incremental: new Field({ type: 'enum', options: ['off', 'identical', 'delta'], default: 'delta' }),
  /** 进入增量比对的最小字符数。 */
  incrementalMinChars: new Field({ type: 'number', default: 600, min: 0, max: 100000 }),
  /** 记账表容量：越大越能识别"隔了很久的重复"，内存占用线性增长。 */
  memoryEntries: new Field({ type: 'number', default: 64, min: 0, max: 4096 }),
  /** 连续重复行折叠阈值（同一行连续出现几次开始折叠）。 */
  repeatRun: new Field({ type: 'number', default: 3, min: 2, max: 100 }),
  /** 全文级重复行折叠：行长度下限。 */
  repeatMinLength: new Field({ type: 'number', default: 24, min: 8, max: 4096 }),
  /** 全文级重复行折叠：被折掉的总字符数下限。 */
  repeatMinSaved: new Field({ type: 'number', default: 64, min: 0, max: 100000 }),
  /** diff 上下文行保留量（每个变动点前后各留几行）。 */
  diffContext: new Field({ type: 'number', default: 3, min: 0, max: 200 }),
  /** 连续空行最多保留几行。 */
  maxBlankRun: new Field({ type: 'number', default: 1, min: 0, max: 20 }),
  /** JSON 缩进：0 表示压成一行。 */
  jsonIndent: new Field({ type: 'number', default: 0, min: 0, max: 8 }),
  /**
   * 按比例压：设成 0.25 就是"不管多大都压到四分之一"。
   *
   * 默认 `0.45`（约压到一半）。**这是唯一能显著提高省量的旋钮**：真实语料里 53% 的 token
   * 落在"又大又不重复"的结果上，那些内容没有重复可折，只靠预算是动不了的。
   *
   * 实测（2596 条真实结果）：0.45 省约 33%、约 2.5% 的结果会丢掉少量高信息量片段；
   * 设 0 则省 19.5%、几乎不丢。**要高省量就得接受这个取舍**，这也是同类工具（例如
   * `dsh-tool-token-optimizer`）做到 60%+ 的全部秘密：它按比例砍，一样会丢信号。
   */
  keepRatio: new Field({ type: 'number', default: DEFAULT_KEEP_RATIO, min: 0, max: 0.95 }),
  /** 按比例压时的最少保留 token（避免把短结果压成一行）。 */
  minKeepTokens: new Field({ type: 'number', default: DEFAULT_MIN_KEEP_TOKENS, min: 32, max: 20000 }),
  /** 只做无损规范化，不做任何结构改写（排错时的保守档）。 */
  conservative: new Field({ type: 'boolean', default: false }),
  /** 报错结果也压缩。默认关：报错上下文最贵，一个字都不该省。 */
  compressErrors: new Field({ type: 'boolean', default: false }),
  /** 不处理的工具名。 */
  skipTools: new Field({ type: 'names', default: [] }),
  /** 打印每次压缩的明细（排错用）。 */
  log: new Field({ type: 'boolean', default: false }),
  /** 把累计节省写到 `<DSH_HOME>/context-guard.json`。 */
  persistStats: new Field({ type: 'boolean', default: true }),
}

/** Standard Schema 的 vendor 名。 */
const VENDOR = 'dsh-meta-optimizer'

/**
 * 校验并补默认值。
 *
 * @param raw - 插件配置。
 * @returns 完整配置对象；`raw` 非法时返回全默认。
 */
export function resolveConfig(raw) {
  const defaults = {}
  for (const [key, field] of Object.entries(FIELDS)) defaults[key] = field.default
  if (raw === undefined || raw === null) return defaults
  if (typeof raw !== 'object' || Array.isArray(raw)) return defaults
  const result = {}
  for (const [key, field] of Object.entries(FIELDS)) {
    const outcome = field.check(raw[key])
    if (outcome.ok === false) return defaults
    result[key] = outcome.value
  }
  for (const key of Object.keys(raw)) {
    if (!(key in FIELDS)) return defaults
  }
  return result
}

/**
 * Standard Schema 接口。
 *
 * @param value - 插件配置。
 * @returns `{ value }` 或 `{ issues }`。
 */
function validate(value) {
  if (value === undefined || value === null) return { value: resolveConfig(undefined) }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [{ message: 'configuration must be an object' }] }
  }
  const issues = []
  const result = {}
  for (const [key, field] of Object.entries(FIELDS)) {
    const outcome = field.check(value[key])
    if (outcome.ok === false) {
      issues.push({ message: `${key}: ${outcome.message}`, path: [key] })
      continue
    }
    result[key] = outcome.value
  }
  for (const key of Object.keys(value)) {
    if (!(key in FIELDS)) issues.push({ message: `unknown configuration key "${key}"`, path: [key] })
  }
  if (issues.length > 0) return { issues }
  return { value: result }
}

/**
 * 供宿主读取的配置 schema。
 *
 * **形状是硬约束**：Cordis 的 `resolveConfig(runtime, config)` 读的是
 * `runtime.Config['~standard'].validate(config)`（见 cordis 的 `resolveConfig`）。
 * 也就是说导出的 `Config` 必须**本身**就是 Standard Schema 对象：
 *
 * ```js
 * { '~standard': { version, vendor, validate } }
 * ```
 *
 * 早期版本把 `Config` 导成了"字段表"（`{ enabled: Field, ... }`），于是宿主读到的是
 * `Field['~standard'] === undefined`，装载时直接抛
 * `TypeError: Cannot read properties of undefined (reading 'validate')` ——
 * 插件静默不激活、端点 404，而且**不会**在界面上报错，极难排查。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: VENDOR,
    validate,
  },
}

/** 兼容旧名字：与 {@link Config} 是同一个对象。 */
export const schema = Config
