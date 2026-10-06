'use client'

import { Badge } from '@/components/ui/badge'
import { StatusDot, type StatusKind } from '@/components/metrics'
import { fmtTime } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import type { Channel, ModelRoute, RouteChannelConfig, RouteStrategy } from '@/types'

/**
 * 路由的「渠道与策略」可视化：策略徽章 + 可用数 + 各渠道状态点。
 * 桌面表格与窄屏卡片共用同一份渲染逻辑，避免两处维护。
 */

export const STRATEGY_META: Record<RouteStrategy, { label: string; desc: string }> = {
  priority: { label: '优先级', desc: '排在前面的渠道优先使用，失败自动切换下一个' },
  weighted: { label: '权重随机', desc: '按权重随机分流到各渠道，失败自动切换其他渠道' },
  speed: { label: '速度优先', desc: '自动选探测延迟最低的渠道（数据来自定时探测），失败切换次快' },
  quality: { label: '智商优先', desc: '优先用智商分高的渠道模型（在下方手动标注 1-10 分），失败切换' },
  stability: { label: '稳定优先', desc: '按近 7 天真实调用成功率排序（来自调用日志），失败切换' },
  cost: { label: '成本优先', desc: '按渠道标注价格升序（渠道 metadata 里配 priceIn/priceOut），失败切换' },
  sticky: { label: '会话粘性', desc: '同一密钥+模型稳定粘住同一渠道（上游缓存友好），渠道挂掉自动漂移' },
  percent: { label: '百分比分流', desc: '按各渠道流量占比（%）灰度切流；占比 0 的渠道只当后备永不接流' },
}

function channelTone(ch: Channel | undefined): { kind: StatusKind; note: string } {
  if (!ch) return { kind: 'danger', note: '渠道已删除' }
  if (!ch.enabled) return { kind: 'idle', note: '渠道已停用' }
  if (ch.autoDisabled) return { kind: 'danger', note: '渠道熔断中，转发自动跳过' }
  if (ch.status === 'online') return { kind: 'ok', note: '正常' }
  if (ch.status === 'offline') return { kind: 'danger', note: '探测离线' }
  return { kind: 'warn', note: '尚未探测' }
}

export function RouteAvailability({ route, channels }: { route: ModelRoute; channels: Channel[] }) {
  let online = 0
  for (const cfg of route.channelConfigs) {
    const ch = channels.find((c) => c.id === cfg.id)
    if (ch && ch.enabled && !ch.autoDisabled) online++
  }
  const total = route.channelConfigs.length
  const kind: StatusKind = total === 0 ? 'idle' : online === 0 ? 'danger' : online < total ? 'warn' : 'ok'
  return { online, total, kind }
}

/** 窄屏卡片右上角的紧凑可用性徽章 */
export function ChannelAvailBadge({ route, channels }: { route: ModelRoute; channels: Channel[] }) {
  const { online, total, kind } = RouteAvailability({ route, channels })
  if (total === 0) return <span className="text-micro text-status-warn">未绑渠道</span>
  return (
    <span
      className={cn(
        'tabular inline-flex items-center gap-1 text-micro font-medium',
        kind === 'danger' && 'text-status-danger',
        kind === 'warn' && 'text-status-warn',
        kind === 'ok' && 'text-status-ok'
      )}
      title={`${online}/${total} 个渠道可用`}
    >
      <StatusDot kind={kind} live={kind === 'ok'} />
      {online}/{total}
    </span>
  )
}

export function RouteChannelBadges({
  route,
  channels,
  nameOf,
  compact = false,
  className,
}: {
  route: ModelRoute
  channels: Channel[]
  nameOf: (id: string) => string
  /** 窄屏卡片：只显示状态点 + 名称，不显示权重前缀，节省横向空间 */
  compact?: boolean
  className?: string
}) {
  const avail = RouteAvailability({ route, channels })

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      <Badge
        variant="outline"
        className={cn(
          'text-micro font-normal',
          route.strategy === 'weighted'
            ? 'border-status-warn/50 text-status-warn'
            : 'border-primary/40 text-primary'
        )}
        title={STRATEGY_META[route.strategy].desc}
      >
        {STRATEGY_META[route.strategy].label}
      </Badge>

      <Badge
        variant="outline"
        className={cn(
          'text-micro font-normal',
          avail.kind === 'danger'
            ? 'border-status-danger/50 text-status-danger'
            : avail.kind === 'warn'
              ? 'border-status-warn/50 text-status-warn'
              : 'border-status-ok/50 text-status-ok'
        )}
        title={avail.total === 0 ? '该路由未绑定任何渠道' : avail.online === 0 ? '该路由当前没有可用渠道' : `${avail.online}/${avail.total} 个渠道可用`}
      >
        <span className="tabular">
          {avail.online}/{avail.total}
        </span>
        可用
      </Badge>

      {route.channelConfigs.map((cfg, i) => {
        const ch = channels.find((c) => c.id === cfg.id)
        const { kind, note } = channelTone(ch)
        const prefix =
          route.strategy === 'priority'
            ? String(i + 1)
            : route.strategy === 'weighted'
              ? `w${cfg.weight ?? 1}`
              : route.strategy === 'quality'
                ? `q${cfg.quality ?? 5}`
                : ''
        return (
          <Badge
            key={cfg.id}
            variant="outline"
            className={cn(
              'gap-1 text-micro font-normal',
              kind === 'idle' && 'opacity-60'
            )}
            title={note}
          >
            <StatusDot kind={kind} live={kind === 'ok'} />
            {prefix && !compact && <span className="font-semibold text-primary">{prefix}</span>}
            <span className="max-w-24 truncate">{nameOf(cfg.id)}</span>
            {cfg.model && !compact && <span className="text-muted-foreground">→{cfg.model}</span>}
          </Badge>
        )
      })}
    </div>
  )
}

/** 路由的用量读数：调用数 · 成功率 · 最近使用 · 粗估花费 */
export function RouteUsage({ route }: { route: ModelRoute }) {
  const s = route.stats
  if (!s || s.total === 0) return <span className="text-caption text-muted-foreground">未调用</span>
  const rate = Math.round((s.ok / s.total) * 100)
  const avgPrice = route.priceIn != null || route.priceOut != null ? ((route.priceIn ?? 0) + (route.priceOut ?? 0)) / 2 : null
  const cost = avgPrice != null && s.tokens > 0 ? (s.tokens / 1_000_000) * avgPrice : null
  const kind: StatusKind = rate >= 95 ? 'ok' : rate >= 80 ? 'info' : rate >= 50 ? 'warn' : 'danger'
  return (
    <div className="text-caption leading-tight">
      <p className={cn('tabular', kind === 'danger' || kind === 'warn' ? 'text-status-warn' : 'text-status-ok')}>
        {s.total.toLocaleString()} 次 · {rate}%
      </p>
      <p className="text-micro text-muted-foreground">
        {s.lastUsedAt ? `最近 ${fmtTime(s.lastUsedAt)}` : '尚无记录'}
        {cost != null && <span className="tabular"> · ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}</span>}
      </p>
    </div>
  )
}

export function routeChannelNameFn(channels: Channel[]): (id: string) => string {
  const map = new Map(channels.map((c) => [c.id, c.name]))
  return (id: string) => map.get(id) ?? '(已删除)'
}
