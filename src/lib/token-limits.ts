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
