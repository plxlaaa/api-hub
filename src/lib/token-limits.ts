/**
 * 统一调用密钥的 metadata 纯解析（零外部依赖，可被 Node test runner 直接测）。
 */

/** 单把统一 Key 的默认限速（次/分钟）。可在 metadata.rateLimitPerMin 单独覆盖，0 = 不限 */
export const DEFAULT_RATE_LIMIT_PER_MIN = 60

/** 读取单把 Key 的限速阈值（次/分钟）；metadata.rateLimitPerMin，缺省 60，0 或非法 = 不限 */
export function rateLimitPerMin(metadata: unknown): number {
  const m = (metadata ?? {}) as Record<string, unknown>
  const v = Number(m.rateLimitPerMin)
  if (!Number.isFinite(v) || v <= 0) return v === 0 ? 0 : DEFAULT_RATE_LIMIT_PER_MIN
  return Math.floor(v)
}

/**
 * 解析模型白名单（metadata.allowedModels，逗号/空格分隔字符串；metadata 值仅支持基础类型，
 * 所以用字符串而非数组存储，与路由级 allowTokens 形态一致）。
 * @returns 未配置/空 → null（不限制）；否则为去重前的模式列表
 */
export function parseModelWhitelist(metadata: unknown): string[] | null {
  const m = (metadata ?? {}) as Record<string, unknown>
  const raw = m.allowedModels
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') return null
  const items = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  return items.length > 0 ? items : null
}

/** 单个白名单模式匹配：`*` 全放行 / 尾部 `*` 前缀通配 / `re:` 正则（与路由引擎语法一致）/ 精确 */
export function modelMatches(pattern: string, model: string): boolean {
  if (pattern === '*') return true
  if (pattern.startsWith('re:')) {
    try {
      return new RegExp(pattern.slice(3)).test(model)
    } catch {
      return false // 非法正则视为不匹配，不让一把坏 Key 配置打挂网关
    }
  }
  if (pattern.endsWith('*')) return model.startsWith(pattern.slice(0, -1))
  return pattern === model
}

/** 模型是否允许该 Key 调用：未配置白名单 = 全放行；命中任一模式 = 放行 */
export function modelAllowed(metadata: unknown, model: string): boolean {
  const list = parseModelWhitelist(metadata)
  if (list === null) return true
  return list.some((p) => modelMatches(p, model))
}
