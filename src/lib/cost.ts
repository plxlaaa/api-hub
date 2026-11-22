/**
 * 费用估算（纯函数，独立模块便于单测——gateway/probe 有 @/ 依赖 node 原生跑不动）
 * 价格语义与成本优先策略同源：渠道 metadata.priceIn/priceOut（美元/百万 token）
 */
export interface CostUsage {
  promptTokens: number | null
  completionTokens: number | null
}

/**
 * 估算请求费用（美元）：priceIn/1M×prompt + priceOut/1M×completion。
 * 缺任一价格或 token 数返回 null（费用未知 ≠ 免费，不显示 0）。
 */
export function estimateCostUsd(metadata: unknown, usage: CostUsage): number | null {
  const m = (metadata ?? {}) as Record<string, unknown>
  const pin = typeof m.priceIn === 'number' && m.priceIn >= 0 ? m.priceIn : null
  const pout = typeof m.priceOut === 'number' && m.priceOut >= 0 ? m.priceOut : null
  if (pin === null || pout === null || usage.promptTokens === null || usage.completionTokens === null) return null
  return (pin * usage.promptTokens + pout * usage.completionTokens) / 1_000_000
}
