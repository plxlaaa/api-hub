import type { ModelRoute } from '@prisma/client'

/** 渠道级配置：独立模型名（可选）、权重（可选）、智商分（可选） */
export interface ChannelConfig {
  id: string
  model?: string // 该渠道实际使用的模型名，缺省用路由的 targetModel
  weight?: number // 权重策略下的随机权重，缺省 1
  quality?: number // 智商分 1-10（用户标注），智商优先策略用，缺省 5
}

export type RouteStrategy = 'priority' | 'weighted' | 'speed' | 'quality' | 'stability' | 'cost'

export const STRATEGY_LABELS: Record<RouteStrategy, string> = {
  priority: '优先级',
  weighted: '权重随机',
  speed: '速度优先',
  quality: '智商优先',
  stability: '稳定优先',
  cost: '成本优先',
}

/** 解析路由的渠道配置：优先 channelConfigs，空则回退旧 channelIds */
export function parseChannelConfigs(route: Pick<ModelRoute, 'channelConfigs' | 'channelIds'>): ChannelConfig[] {
  let cfgs: ChannelConfig[] = []
  try {
    const parsed = JSON.parse(route.channelConfigs || '[]')
    if (Array.isArray(parsed)) cfgs = parsed.filter((c) => c && typeof c.id === 'string')
  } catch {
    /* ignore */
  }
  if (cfgs.length > 0) return cfgs
  try {
    const ids = JSON.parse(route.channelIds || '[]')
    if (Array.isArray(ids)) return ids.map((id) => ({ id: String(id) }))
  } catch {
    /* ignore */
  }
  return []
}

/** 校验并规范化前端提交的 channelConfigs */
export function normalizeChannelConfigs(input: unknown): ChannelConfig[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const out: ChannelConfig[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (!item || typeof item !== 'object') return null
    const { id, model, weight, quality } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) return null
    seen.add(id)
    const cfg: ChannelConfig = { id }
    if (typeof model === 'string' && model.trim()) cfg.model = model.trim()
    if (typeof weight === 'number' && Number.isFinite(weight) && weight >= 0) {
      cfg.weight = Math.min(Math.round(weight), 100)
    }
    if (typeof quality === 'number' && Number.isFinite(quality) && quality >= 1 && quality <= 10) {
      cfg.quality = Math.round(quality)
    }
    out.push(cfg)
  }
  return out
}

/** 校验策略字段（与 STRATEGY_LABELS 同源，新策略加类型后自动生效，不再漏白名单） */
const STRATEGY_NAMES: RouteStrategy[] = Object.keys(STRATEGY_LABELS) as RouteStrategy[]

export function normalizeStrategy(input: unknown): RouteStrategy {
  return STRATEGY_NAMES.includes(input as RouteStrategy) ? (input as RouteStrategy) : 'priority'
}
