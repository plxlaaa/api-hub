/**
 * 探测配置纯函数（独立于 probe.ts 的 I/O 依赖，便于单测）
 * - selectProbeTargets：渠道级 probeMode=off 过滤
 * - resolveProbeIntervalMs：GW_PROBE_INTERVAL_MS 解析与 clamp
 */
export function selectProbeTargets(channels: Array<{ id: string; metadata?: unknown }>): Array<{ id: string }> {
  return channels.filter((c) => {
    const m = c.metadata as Record<string, unknown> | null
    return m?.probeMode !== 'off'
  })
}

/** 解析探测间隔（生产不传参读 GW_PROBE_INTERVAL_MS；clamp 10s~1h，非法回退 60s） */
export function resolveProbeIntervalMs(raw?: string): number {
  const n = raw === undefined ? Number(process.env.GW_PROBE_INTERVAL_MS) : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 60_000
  return Math.min(Math.max(n, 10_000), 3_600_000)
}
