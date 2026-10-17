import type { ChannelConfig } from '@/lib/route-config'
import { inActiveHours } from './route-config.ts'
import type { Channel } from '@prisma/client'

export interface Candidate {
  cfg: ChannelConfig
  ch: Channel
}

/** 排序上下文：粘性策略需要调用方身份 + 模型名做稳定哈希 */
export interface OrderContext {
  tokenKey?: string // 稳定标识（token id 或 key），同一调用方粘同一渠道
  model?: string // 请求的模型名，参与哈希（不同模型可落不同渠道）
  rand?: number // 注入随机数（0-1），单测可复现分流结果；缺省 Math.random()
  routeMeta?: Record<string, unknown> // 路由 metadata（smart 策略读 smartWaitSeconds）
}

export type RouteStrategy = 'priority' | 'weighted' | 'speed' | 'quality' | 'stability' | 'cost' | 'smart' | 'sticky' | 'percent'

export const STRATEGIES: RouteStrategy[] = ['priority', 'weighted', 'speed', 'quality', 'stability', 'cost', 'smart', 'sticky', 'percent']

export const STRATEGY_LABELS: Record<RouteStrategy, string> = {
  priority: '优先级',
  weighted: '权重随机',
  speed: '速度优先',
  quality: '质量优先',
  stability: '稳定性优先',
  cost: '成本优先',
  smart: '性价比（价格×延迟）',
  sticky: '会话粘性',
  percent: '百分比分流',
}

export function normalizeStrategy(v: unknown): RouteStrategy {
  return STRATEGIES.includes(v as RouteStrategy) ? (v as RouteStrategy) : 'priority'
}

/**
 * 路由策略注册表：每个策略一个纯排序函数（candidates → ordered）。
 * 新增策略三步：① RouteStrategy 联合类型加名字 ② 实现排序函数 ③ 注册进 STRATEGY_REGISTRY + 写 basis 文案。
 * 网关转发与预览共用 orderCandidates，保证预览=实际行为。
 */
type StrategyFn = (candidates: Candidate[], ctx?: OrderContext) => Candidate[] | Promise<Candidate[]>

/** 权重随机：不放回加权抽样（随机性导致预览每次可能不同） */
const weightedStrategy: StrategyFn = (candidates) => {
  if (candidates.length <= 1) return candidates
  const pool = [...candidates]
  const ordered: Candidate[] = []
  while (pool.length > 0) {
    const total = pool.reduce((s, x) => s + (x.cfg.weight ?? 1), 0)
    // 权重全为 0（或全非法）时 total=0，除法会得到 NaN 并恒取 idx=0 —— 退化为顺序追加
    if (!Number.isFinite(total) || total <= 0) {
      ordered.push(...pool)
      break
    }
    let pick = Math.random() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      const w = pool[i].cfg.weight ?? 1
      pick -= w
      // pick<=0 会误中 weight=0 的项（它们本不该被抽中），故跳过并继续扣减
      if (pick <= 0 && w > 0) {
        idx = i
        break
      }
    }
    // 本轮所有候选权重都为 0 → 直接按剩余顺序追加，避免死循环
    if (pool.every((x) => (x.cfg.weight ?? 1) <= 0)) {
      ordered.push(...pool)
      break
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

/**
 * 稳定性优先：近 7 天调用成功率降序（无记录 0.5），同率按延迟升序。
 *
 * 性能：这是网关热路径（每个请求都会调用），原本每次都做一次 7 天 groupBy 全表聚合。
 * 这里加 60s 内存缓存 —— 成功率是缓慢变化的统计量，60s 延迟对排序结果无感知影响，
 * 但把每请求一次聚合查询降到每分钟一次。
 */
const STABILITY_CACHE_TTL_MS = 60_000
let stabilityCache: { at: number; rates: Map<string, number> } | null = null

const stabilityStrategy: StrategyFn = async (candidates) => {
  const now = Date.now()
  let rates: Map<string, number>
  if (stabilityCache && now - stabilityCache.at < STABILITY_CACHE_TTL_MS) {
    rates = stabilityCache.rates
  } else {
    // 惰性导入 db：让本模块保持「无顶层重依赖」，路由规则单测可以直接 import 纯函数部分
    const { db } = await import('@/lib/db')
    const since = new Date(now - 7 * 24 * 3600_000)
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
    rates = new Map<string, number>()
    for (const [name, s] of stats) {
      rates.set(name, s.total > 0 ? s.ok / s.total : 0.5)
    }
    stabilityCache = { at: now, rates }
  }
  const rate = (name: string) => rates.get(name) ?? 0.5
  return [...candidates].sort((a, b) => {
    const ra = rate(a.ch.name)
    const rb = rate(b.ch.name)
    if (ra !== rb) return rb - ra
    const la = a.ch.latencyMs ?? Number.MAX_SAFE_INTEGER
    const lb = b.ch.latencyMs ?? Number.MAX_SAFE_INTEGER
    return la === lb ? 0 : la - lb
  })
}

/** 主动失效稳定性缓存（调用日志写入后无需调用，此函数供测试/管理操作使用） */
export function invalidateStabilityCache(): void {
  stabilityCache = null
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

/**
 * 会话粘性：稳定哈希（FNV-1a）决定主渠道，同一 (tokenKey, model) 永远落同一渠道。
 *
 * 价值：多轮对话的上游 KV 缓存按渠道会话缓存，每次换渠道缓存全失效（慢 + 贵）。
 * 粘住渠道后缓存命中率高。渠道挂掉时自然漂移到后备（列表里下一个），恢复后回粘。
 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const stickyStrategy: StrategyFn = (candidates, ctx) => {
  if (candidates.length <= 1) return candidates
  const key = `${ctx?.tokenKey ?? 'anonymous'}|${ctx?.model ?? ''}`
  const idx = fnv1a(key) % candidates.length
  // 主渠道提到首位，其余保持配置顺序做后备
  return [candidates[idx], ...candidates.filter((_, i) => i !== idx)]
}

/**
 * 百分比分流（A/B 灰度）：按 cfg.percent 归一化加权随机选主，其余按配置顺序做后备。
 * 与 weighted 的区别：percent 是明确的流量占比语义（总和归一化），weight 是相对权重；
 * 且 percent=0 的渠道永不做主、只当后备 —— 正好用来做「5% 试新渠道，其余保底」。
 */
const percentStrategy: StrategyFn = (candidates, ctx) => {
  const weighted = candidates.map((c) => ({ c, w: c.cfg.percent ?? 1 }))
  const total = weighted.reduce((s, x) => s + x.w, 0)
  if (!Number.isFinite(total) || total <= 0 || candidates.length <= 1) return candidates
  let pick = (ctx?.rand ?? Math.random()) * total
  let primary = candidates[candidates.length - 1] // 全 0 兜底
  for (const x of weighted) {
    pick -= x.w
    if (pick <= 0 && x.w > 0) {
      primary = x.c
      break
    }
  }
  return [primary, ...candidates.filter((c) => c !== primary)]
}

/**
 * 性价比（smart）：价格与延迟合成单一评分 —— 学习自 cc-switch-route 的智能排序。
 *
 *   score = price + (latencySec × 0.1 / waitSeconds)
 *
 * - price：与成本优先同源的加权价 (priceIn + 3×priceOut)/4（美元/百万token）
 * - waitSeconds：用户愿为「每省 1 美元/百万token」多等多少秒（路由 metadata.smartWaitSeconds，
 *   缺省 10s）—— 是延迟↔价格的汇率旋钮：调大偏省钱，调小偏求快
 * - 排序纪律（同 cc-switch）：指标齐全的渠道在前，缺价格或延迟的按缺口数退后，
 *   双缺垫底 —— 未知不冒充便宜也不冒充快
 */
const smartStrategy: StrategyFn = (candidates, ctx) => {
  const raw = Number(ctx?.routeMeta?.smartWaitSeconds)
  const waitSec = Number.isFinite(raw) && raw > 0 ? raw : 10
  // 加权价（与成本优先同源）：输出价 3:1 加权；只标一档时按已知档粗估，全未标 = null
  const effPrice = (x: Candidate): number | null => {
    const m = (x.ch.metadata ?? {}) as Record<string, unknown>
    const pin = typeof m.priceIn === 'number' && m.priceIn >= 0 ? m.priceIn : null
    const pout = typeof m.priceOut === 'number' && m.priceOut >= 0 ? m.priceOut : null
    if (pin != null && pout != null) return (pin + 3 * pout) / 4
    if (pin != null) return pin
    if (pout != null) return pout
    return null
  }
  const meta = (x: Candidate) => {
    const p = effPrice(x)
    const l = x.ch.latencyMs
    const known = (p != null ? 2 : 0) + (l != null ? 1 : 0)
    const score = p != null ? p + ((l ?? 0) / 1000) * (0.1 / waitSec) : Number.POSITIVE_INFINITY
    return { p, l, known, score }
  }
  return [...candidates].sort((a, b) => {
    const ma = meta(a)
    const mb = meta(b)
    if (ma.known !== mb.known) return mb.known - ma.known // 指标全的在前
    if (ma.known === 0) return 0 // 双缺保持配置顺序
    if (ma.score !== mb.score) return ma.score - mb.score
    return 0
  })
}

const STRATEGY_REGISTRY: Record<RouteStrategy, StrategyFn> = {
  priority: priorityStrategy,
  weighted: weightedStrategy,
  speed: speedStrategy,
  quality: qualityStrategy,
  stability: stabilityStrategy,
  cost: costStrategy,
  smart: smartStrategy,
  sticky: stickyStrategy,
  percent: percentStrategy,
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
  smart: (c) => {
    const m = (c.ch.metadata ?? {}) as Record<string, unknown>
    const hasP = typeof m.priceIn === 'number' || typeof m.priceOut === 'number'
    const l = c.ch.latencyMs
    if (!hasP && l == null) return '价格/延迟均未知 · 排最后'
    if (!hasP) return `延迟 ${l}ms · 价格未知`
    if (l == null) return `¥ ${m.priceIn ?? '?'}/${m.priceOut ?? '?'} · 延迟未知`
    return `¥ ${m.priceIn ?? '?'}/${m.priceOut ?? '?'} · ${l}ms`
  },
  sticky: (c) => (c.cfg.model ? `会话哈希 · 独立模型 ${c.cfg.model}` : '会话哈希稳定选主'),
  percent: (c) => `流量占比 ${c.cfg.percent ?? 100}%`,
}

export async function orderCandidates(
  candidates: Candidate[],
  strategy: RouteStrategy,
  ctx?: OrderContext
): Promise<{ ordered: Candidate[]; basis: Map<string, string> }> {
  const basis = new Map<string, string>()
  const fn = STRATEGY_REGISTRY[strategy] ?? STRATEGY_REGISTRY.priority
  let ordered = await fn(candidates, ctx)

  // 时段窗口管线：窗口外的渠道退到队尾做后备（不摘除 —— 挂了总比没有强）。
  // 对所有策略生效（priority 粘性等都要尊重「凌晨走便宜渠道」这类配置）。
  const inWindow: Candidate[] = []
  const outOfWindow: Candidate[] = []
  const now = new Date()
  for (const x of ordered) {
    if (x.cfg.activeHours && !inActiveHours(x.cfg.activeHours, now)) outOfWindow.push(x)
    else inWindow.push(x)
  }
  if (outOfWindow.length > 0) {
    ordered = [...inWindow, ...outOfWindow]
    for (const x of outOfWindow) basis.set(`window:${x.ch.id}`, `窗口 ${x.cfg.activeHours} 外 · 后备`)
  }

  // 生成每个渠道的排序依据说明（预览展示用）
  const label = BASIS_LABEL[strategy]
  for (let i = 0; i < ordered.length; i++) {
    const x = ordered[i]
    const suffix = basis.get(`window:${x.ch.id}`) ?? ''
    const text = label ? label(x, i) : `优先级 #${i + 1}`
    basis.set(x.ch.id, suffix ? `${text} · ${suffix}` : text)
  }
  return { ordered, basis }
}
