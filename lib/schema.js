/**
 * 配置校验：Standard Schema v1（`~standard.validate`）。
 *
 * 两条刻意的取舍：
 * 1. **未知键一律拒绝**。写错一个键名却"看起来配了"是最贵的 bug 类型——它让人以为
 *    省了 token，其实一个都没省。宁可启动时报错。
 * 2. 校验失败时**退回全默认**，而不是"配置非法就整个插件不生效"。默认值本身就是
 *    安全的那一档（开启压缩、增量默认开、不改写结构）。
 *
 * @module dsh-context-guard/schema
 */

import { DEFAULT_BUDGET_CHARS } from './policy.js'

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
export const Config = {
  /** 总开关。关掉后监听器立刻变成直通，不产生任何额外 token。 */
  enabled: new Field({ type: 'boolean', default: true }),
  /** 单结果字符预算的兜底值。 */
  budgetChars: new Field({ type: 'number', default: DEFAULT_BUDGET_CHARS, min: 512, max: 400000 }),
  /** 按工具名覆盖预算，例如 `{ bash: 4000 }`。 */
  toolBudgets: new Field({ type: 'record', default: {} }),
  /** 小于这个字符数的结果完全不处理（省下的还不够写标记）。 */
  minChars: new Field({ type: 'number', default: 400, min: 0, max: 200000 }),
  /** 省不到这个比例就不改（防止"改了半天只省 3%"这种纯添乱）。 */
  minSavingRatio: new Field({ type: 'number', default: 0.12, min: 0, max: 0.9 }),
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
const VENDOR = 'dsh-context-guard'

/**
 * 校验并补默认值。
 *
 * @param raw - 插件配置。
 * @returns 完整配置对象；`raw` 非法时返回全默认。
 */
export function resolveConfig(raw) {
  const defaults = {}
  for (const [key, field] of Object.entries(Config)) defaults[key] = field.default
  if (raw === undefined || raw === null) return defaults
  if (typeof raw !== 'object' || Array.isArray(raw)) return defaults
  const result = {}
  for (const [key, field] of Object.entries(Config)) {
    const outcome = field.check(raw[key])
    if (outcome.ok === false) return defaults
    result[key] = outcome.value
  }
  for (const key of Object.keys(raw)) {
    if (!(key in Config)) return defaults
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
  for (const [key, field] of Object.entries(Config)) {
    const outcome = field.check(value[key])
    if (outcome.ok === false) {
      issues.push({ message: `${key}: ${outcome.message}`, path: [key] })
      continue
    }
    result[key] = outcome.value
  }
  for (const key of Object.keys(value)) {
    if (!(key in Config)) issues.push({ message: `unknown configuration key "${key}"`, path: [key] })
  }
  if (issues.length > 0) return { issues }
  return { value: result }
}

/** 供 DSH 读取的 schema 对象。 */
export const schema = {
  '~standard': {
    version: 1,
    vendor: VENDOR,
    validate,
  },
}
