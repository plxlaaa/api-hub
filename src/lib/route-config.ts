import type { ModelRoute } from '@prisma/client'

/** 渠道级配置：独立模型名（可选）、权重（可选）、智商分（可选）+ 高级规则字段 */
export interface ChannelConfig {
  id: string
  model?: string // 该渠道实际使用的模型名，缺省用路由的 targetModel
  weight?: number // 权重策略下的随机权重，缺省 1
  quality?: number // 智商分 1-10（用户标注），智商优先策略用，缺省 5
  percent?: number // 百分比分流策略下的流量占比 0-100（0=永不做主只当后备）
  activeHours?: string // 时段窗口 "HH:MM-HH:MM"（支持跨午夜，如 "22:00-06:00"）；窗口外渠道退为后备
}

export type RouteStrategy = 'priority' | 'weighted' | 'speed' | 'quality' | 'stability' | 'cost' | 'smart' | 'sticky' | 'percent'

export const STRATEGY_LABELS: Record<RouteStrategy, string> = {
  priority: '优先级',
  weighted: '权重随机',
  speed: '速度优先',
  quality: '智商优先',
  stability: '稳定优先',
  cost: '成本优先',
  smart: '性价比（价格×延迟）',
  sticky: '会话粘性',
  percent: '百分比分流',
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
    const { id, model, weight, quality, percent, activeHours } = item as Record<string, unknown>
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
    if (typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      cfg.percent = Math.round(percent)
    }
    if (typeof activeHours === 'string' && parseActiveHours(activeHours)) {
      cfg.activeHours = activeHours.trim()
    }
    out.push(cfg)
  }
  return out
}

/**
 * 校验时段窗口格式 "HH:MM-HH:MM"（支持跨午夜）。
 * @returns 合法返回 [startMin, endMin]（分钟数），非法返回 null
 */
export function parseActiveHours(v: string): [number, number] | null {
  const m = /^\s*(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})\s*$/.exec(v)
  if (!m) return null
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null
  return [sh * 60 + sm, eh * 60 + em]
}

/** 当前分钟数是否落在时段窗口内（跨午夜窗口如 22:00-06:00 视为环绕） */
export function inActiveHours(activeHours: string, date: Date): boolean {
  const range = parseActiveHours(activeHours)
  if (!range) return true // 非法配置不拦截渠道（宁多试不错杀）
  const [start, end] = range
  const cur = date.getHours() * 60 + date.getMinutes()
  if (start === end) return true // 零长度窗口视为全天
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end // 跨午夜环绕
}

/** 校验策略字段（与 STRATEGY_LABELS 同源，新策略加类型后自动生效，不再漏白名单） */
const STRATEGY_NAMES: RouteStrategy[] = Object.keys(STRATEGY_LABELS) as RouteStrategy[]

export function normalizeStrategy(input: unknown): RouteStrategy {
  return STRATEGY_NAMES.includes(input as RouteStrategy) ? (input as RouteStrategy) : 'priority'
}
