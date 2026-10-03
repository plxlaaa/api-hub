import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 状态标记原语：状态点、延迟读数、指标块、键值对。
 * 全部 tabular-nums —— 数字是这里的主角（.impeccable.md 原则 1）。
 */

export type StatusKind = 'ok' | 'warn' | 'danger' | 'idle' | 'info'

const DOT_CLASS: Record<StatusKind, string> = {
  ok: 'bg-status-ok shadow-[0_0_0_3px_color-mix(in_oklab,var(--status-ok)_18%,transparent)]',
  warn: 'bg-status-warn shadow-[0_0_0_3px_color-mix(in_oklab,var(--status-warn)_18%,transparent)]',
  danger: 'bg-status-danger shadow-[0_0_0_3px_color-mix(in_oklab,var(--status-danger)_18%,transparent)]',
  idle: 'bg-status-idle shadow-[0_0_0_3px_color-mix(in_oklab,var(--status-idle)_18%,transparent)]',
  info: 'bg-status-info shadow-[0_0_0_3px_color-mix(in_oklab,var(--status-info)_18%,transparent)]',
}

const TEXT_CLASS: Record<StatusKind, string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  danger: 'text-status-danger',
  idle: 'text-status-idle',
  info: 'text-status-info',
}

const CHIP_CLASS: Record<StatusKind, string> = {
  ok: 'bg-status-ok-soft text-status-ok',
  warn: 'bg-status-warn-soft text-status-warn',
  danger: 'bg-status-danger-soft text-status-danger',
  idle: 'bg-status-idle-soft text-status-idle',
  info: 'bg-status-info-soft text-status-info',
}

/** 状态点：3px 实心圆 + 柔和光晕。在线态极缓呼吸（2.4s），离线静止。 */
export function StatusDot({
  kind,
  live = false,
  className,
}: {
  kind: StatusKind
  /** 状态是否「活跃」——在线时给极克制的呼吸暗示，失败/关闭时不闪 */
  live?: boolean
  className?: string
}) {
  return (
    <span
      className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', DOT_CLASS[kind], live && 'animate-pulse', className)}
      aria-hidden="true"
    />
  )
}

/** 状态点 + 文案的一行式标签 */
export function StatusLabel({
  kind,
  children,
  live = false,
  className,
}: {
  kind: StatusKind
  children: React.ReactNode
  live?: boolean
  className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-caption font-medium', TEXT_CLASS[kind], className)}>
      <StatusDot kind={kind} live={live} />
      {children}
    </span>
  )
}

/** 药丸状状态标签：用于表格/卡片里的状态列 */
export function StatusChip({
  kind,
  children,
  className,
  title,
}: {
  kind: StatusKind
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-micro font-medium whitespace-nowrap',
        CHIP_CLASS[kind],
        className
      )}
    >
      <StatusDot kind={kind} />
      {children}
    </span>
  )
}

/* ── 延迟读数：按阈值分档着色 ─────────────────────────── */

/** 阈值（毫秒）：与探测超时/熔断阈值同量级 */
export const LATENCY_TIERS = [
  { max: 1500, kind: 'ok' as StatusKind, label: '快' },
  { max: 4000, kind: 'info' as StatusKind, label: '正常' },
  { max: 10000, kind: 'warn' as StatusKind, label: '慢' },
  { max: Infinity, kind: 'danger' as StatusKind, label: '很慢' },
]

export function latencyKind(ms: number | null | undefined): StatusKind {
  if (ms == null) return 'idle'
  return (LATENCY_TIERS.find((t) => ms <= t.max)?.kind ?? 'idle') as StatusKind
}

export function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
}

/** 延迟读数：值 + 单位分色（数字醒目、单位弱化），按档位着色 */
export function LatencyReadout({
  ms,
  showUnit = true,
  className,
}: {
  ms: number | null | undefined
  showUnit?: boolean
  className?: string
}) {
  const kind = latencyKind(ms)
  if (ms == null) return <span className={cn('text-status-idle', className)}>—</span>
  const value = ms < 1000 ? String(Math.round(ms)) : (ms / 1000).toFixed(ms < 10000 ? 1 : 0)
  const unit = ms < 1000 ? 'ms' : 's'
  return (
    <span className={cn('tabular inline-flex items-baseline gap-0.5 font-medium', TEXT_CLASS[kind], className)}>
      {value}
      {showUnit && <span className="text-micro font-normal opacity-70">{unit}</span>}
    </span>
  )
}

/* ── 指标块：仪表读数 ─────────────────────────────────── */

/**
 * 一块指标：标签（小、宽字距、弱化） + 读数（大、等宽、带单位后缀）+ 可选副信息。
 * 密度靠「重复同一形状」建立，而不是靠加大间距。
 */
export function Metric({
  label,
  value,
  unit,
  hint,
  kind = 'idle',
  className,
  size = 'md',
}: {
  label: string
  value: React.ReactNode
  unit?: string
  hint?: React.ReactNode
  kind?: StatusKind
  className?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="truncate text-micro font-medium tracking-[0.06em] text-muted-foreground uppercase">{label}</p>
      <p
        className={cn(
          'readout mt-1 flex items-baseline gap-1',
          size === 'lg' ? 'text-3xl sm:text-4xl' : size === 'sm' ? 'text-lg' : 'text-2xl',
          TEXT_CLASS[kind]
        )}
      >
        <span className="truncate">{value}</span>
        {unit && <span className="text-caption font-normal text-muted-foreground">{unit}</span>}
      </p>
      {hint && <p className="mt-1 truncate text-micro text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** 指标网格：自适应列数，窄屏 2 列，宽屏 4 列 */
export function MetricGrid({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4', className)}>{children}</div>
}

/* ── 键值行：模型名 / ID / URL 等技术字段 ──────────────── */

export function KeyValue({
  label,
  children,
  mono = false,
  className,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex items-baseline gap-2 py-0.5', className)}>
      <dt className="shrink-0 text-micro tracking-[0.04em] text-muted-foreground uppercase">{label}</dt>
      <dd className={cn('min-w-0 flex-1 truncate text-caption', mono && 'mono-id text-muted-foreground')}>{children}</dd>
    </div>
  )
}

/** 可截断的技术字段（URL / 模型名），点击可展开全文 */
export function Truncate({
  children,
  className,
  title,
}: {
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <span title={title ?? (typeof children === 'string' ? children : undefined)} className={cn('block truncate', className)}>
      {children}
    </span>
  )
}

/** 百分比条：成功率/配额使用率等 0-100 量。宽度用内联 style，避免动态类名问题。 */
export function RatioBar({
  value,
  kind,
  className,
  showLabel = true,
}: {
  /** 0-100 */
  value: number
  kind?: StatusKind
  className?: string
  showLabel?: boolean
}) {
  const pct = Math.max(0, Math.min(100, value))
  const barKind: StatusKind = kind ?? (pct >= 99 ? 'ok' : pct >= 80 ? 'info' : pct >= 50 ? 'warn' : 'danger')
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-300 ease-out', DOT_CLASS[barKind])}
          style={{ width: `${pct}%`, boxShadow: 'none' }}
        />
      </div>
      {showLabel && <span className={cn('tabular shrink-0 text-micro font-medium', TEXT_CLASS[barKind])}>{Math.round(pct)}%</span>}
    </div>
  )
}

/** 区块标题：小标签 + 说明，替代常见的「万物大标题」 */
export function SectionHeading({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-0.5 text-caption text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{action}</div>}
    </div>
  )
}
