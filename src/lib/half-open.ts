/**
 * 半开熔断（学习自 cc-switch 的 HalfOpen 状态机）：被自动摘除的渠道在冷却期满后，
 * 由真实流量放行单个试探请求 —— 成功即恢复（不等探测周期），失败则刷新冷却继续等待。
 *
 * - 冷却期：环境变量 GW_HALF_OPEN_COOLDOWN_MS，缺省 60s
 * - 并发防雪崩：进程内占位表（channelId → 试探开始时间），试探进行中/超时前
 *   其他请求不放行该渠道；占位带超时自愈，漏删也不会永久卡死
 *
 * 独立成纯模块（不依赖 prisma / 路径别名）：单测可直接 import。
 */
const halfOpenProbing = new Map<string, number>()

export function halfOpenCooldownMs(): number {
  const v = Number(process.env.GW_HALF_OPEN_COOLDOWN_MS)
  return Number.isFinite(v) && v >= 1000 ? v : 60_000
}

/** 该半开渠道现在是否可放行试探（冷却期满 + 没有正在进行的试探） */
export function halfOpenEligible(ch: { id: string; autoDisabledAt: Date | null }, now = Date.now()): boolean {
  if (!ch.autoDisabledAt) return true
  if (now - ch.autoDisabledAt.getTime() < halfOpenCooldownMs()) return false
  const probingSince = halfOpenProbing.get(ch.id)
  if (probingSince != null && now - probingSince < halfOpenCooldownMs()) return false
  return true
}

/** 试探开始时占位（gateway 转发循环用） */
export function markProbing(channelId: string, now = Date.now()): void {
  halfOpenProbing.set(channelId, now)
}

/** 试探结束释放（成功恢复 / 失败均调用；漏调有超时自愈兜底） */
export function clearProbing(channelId: string): void {
  halfOpenProbing.delete(channelId)
}

/** 测试辅助：清空占位表 */
export function resetProbing(): void {
  halfOpenProbing.clear()
}
