import { db } from '@/lib/db'
import type { ChannelConfig } from '@/lib/route-config'
import type { Channel } from '@prisma/client'

export interface Candidate {
  cfg: ChannelConfig
  ch: Channel
}

export type RouteStrategy = 'priority' | 'weighted' | 'speed' | 'quality' | 'stability' | 'cost'

export const STRATEGIES: RouteStrategy[] = ['priority', 'weighted', 'speed', 'quality', 'stability', 'cost']

export const STRATEGY_LABELS: Record<RouteStrategy, string> = {
  priority: '优先级',
  weighted: '权重随机',
  speed: '速度优先',
  quality: '质量优先',
  stability: '稳定性优先',
  cost: '成本优先',
}

export function normalizeStrategy(v: unknown): RouteStrategy {
  return STRATEGIES.includes(v as RouteStrategy) ? (v as RouteStrategy) : 'priority'
}

/**
 * 路由策略注册表：每个策略一个纯排序函数（candidates → ordered）。
 * 新增策略三步：① RouteStrategy 联合类型加名字 ② 实现排序函数 ③ 注册进 STRATEGY_REGISTRY + 写 basis 文案。
 * 网关转发与预览共用 orderCandidates，保证预览=实际行为。
 */
type StrategyFn = (candidates: Candidate[]) => Candidate[] | Promise<Candidate[]>

/** 权重随机：不放回加权抽样（随机性导致预览每次可能不同） */
const weightedStrategy: StrategyFn = (candidates) => {
  if (candidates.length <= 1) return candidates
  const pool = [...candidates]
  const ordered: Candidate[] = []
  while (pool.length > 0) {
    const total = pool.reduce((s, x) => s + (x.cfg.weight ?? 1), 0)
    let pick = Math.random() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      pick -= pool[i].cfg.weight ?? 1
      if (pick <= 0) {
        idx = i
        break
      }
    }
    ordered.push(pool.splice(idx, 1)[0])
  }
  return ordered
}

/** 速度优先：探测延迟升序（无延迟数据排最后） */
const speedStrategy: StrategyFn = (candidates) =>
  [...candidates].sort((a, b) => {
    const la = a.ch.latencyMs ?? Number.MAX_SAFE_INTEGER
    const lb = b.ch.latencyMs ?? Number.MAX_SAFE_INTEGER
    return la === lb ? 0 : la - lb
  })

/** 质量优先：智商分降序（缺省 5） */
const qualityStrategy: StrategyFn = (candidates) =>
  [...candidates].sort((a, b) => (b.cfg.quality ?? 5) - (a.cfg.quality ?? 5))

/** 稳定性优先：近 7 天调用成功率降序（无记录 0.5），同率按延迟升序 */
const stabilityStrategy: StrategyFn = async (candidates) => {
  const since = new Date(Date.now() - 7 * 24 * 3600_000)
  const grouped = await db.requestLog.groupBy({
    by: ['channelName', 'ok'],
    where: { createdAt: { gte: since }, channelName: { in: candidates.map((x) => x.ch.name) } },
    _count: { _all: true },
  })
  const stats = new Map<string, { ok: number; total: number }>()
  for (const g of grouped) {
    const s = stats.get(g.channelName) || { ok: 0, total: 0 }
    s.total += g._count._all
    if (g.ok) s.ok += g._count._all
    stats.set(g.channelName, s)
  }
  return [...candidates].sort((a, b) => {
    const rate = (name: string) => {
      const s = stats.get(name)
      return s && s.total > 0 ? s.ok / s.total : 0.5
    }
    const ra = rate(a.ch.name)
    const rb = rate(b.ch.name)
    if (ra !== rb) return rb - ra
    const la = a.ch.latencyMs ?? Number.MAX_SAFE_INTEGER
    const lb = b.ch.latencyMs ?? Number.MAX_SAFE_INTEGER
    return la === lb ? 0 : la - lb
  })
}

/** 优先级：配置顺序即尝试顺序 */
const priorityStrategy: StrategyFn = (candidates) => candidates

/**
 * 成本优先：按渠道标注价格（metadata.priceIn/priceOut，美元/百万token）升序。
 * 未标注价格的渠道排最后（视为无穷大），同价按探测延迟升序。
 */
const costStrategy: StrategyFn = (candidates) => {
  const price = (x: Candidate) => {
    const m = (x.ch.metadata ?? {}) as Record<string, unknown>
    const pin = typeof m.priceIn === 'number' && m.priceIn >= 0 ? m.priceIn : Number.POSITIVE_INFINITY
    const pout = typeof m.priceOut === 'number' && m.priceOut >= 0 ? m.priceOut : Number.POSITIVE_INFINITY
    // 输出价通常占比更高，加权 3:1 近似真实成本
    return (pin + 3 * pout) / 4
  }
  return [...candidates].sort((a, b) => {
    const pa = price(a)
    const pb = price(b)
    if (pa !== pb) return pa - pb
    const la = a.ch.latencyMs ?? Number.MAX_SAFE_INTEGER
    const lb = b.ch.latencyMs ?? Number.MAX_SAFE_INTEGER
    return la === lb ? 0 : la - lb
  })
}

const STRATEGY_REGISTRY: Record<RouteStrategy, StrategyFn> = {
  priority: priorityStrategy,
  weighted: weightedStrategy,
  speed: speedStrategy,
  quality: qualityStrategy,
  stability: stabilityStrategy,
  cost: costStrategy,
}

/** 每个策略的排序依据说明（预览展示用）；新策略记得补一条文案 */
const BASIS_LABEL: Partial<Record<RouteStrategy, (c: Candidate, pos: number) => string>> = {
  weighted: (c) => `权重 ${c.cfg.weight ?? 1}`,
  speed: (c) => (c.ch.latencyMs != null ? `延迟 ${c.ch.latencyMs}ms` : '无探测数据'),
  quality: (c) => `智商 ${c.cfg.quality ?? 5}`,
  stability: (c) => (c.ch.latencyMs != null ? `成功率驱动 · 延迟 ${c.ch.latencyMs}ms` : '成功率驱动 · 无数据'),
  cost: (c) => {
    const m = (c.ch.metadata ?? {}) as Record<string, unknown>
    if (typeof m.priceIn !== 'number' && typeof m.priceOut !== 'number') return '未标注价格 · 排最后'
    return `¥ ${m.priceIn ?? '?'}/${m.priceOut ?? '?'} 每百万tok`
  },
}

export async function orderCandidates(candidates: Candidate[], strategy: RouteStrategy): Promise<{ ordered: Candidate[]; basis: Map<string, string> }> {
  const basis = new Map<string, string>()
  const fn = STRATEGY_REGISTRY[strategy] ?? STRATEGY_REGISTRY.priority
  const ordered = await fn(candidates)

  // 生成每个渠道的排序依据说明（预览展示用）
  const label = BASIS_LABEL[strategy]
  for (let i = 0; i < ordered.length; i++) {
    const x = ordered[i]
    basis.set(x.ch.id, label ? label(x, i) : `优先级 #${i + 1}`)
  }
  return { ordered, basis }
}
