import * as React from 'react'
import { AlertCircle, Inbox, Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * 共享体验原语：空态 / 加载 / 错误 / 状态标记
 * 目标是让「任何异步区域都不会白屏」，且四态视觉语言一致。
 * 依据 .impeccable.md 原则 5：反馈即时且诚实。
 */

/* ── 空态 ────────────────────────────────────────────── */

/**
 * 空态不是一句「暂无数据」就完事——必须说明「为什么空」+「下一步做什么」。
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-2.5 px-6 py-14',
        className
      )}
    >
      <div
        className={cn(
          'flex items-center justify-center rounded-xl border border-dashed text-muted-foreground/70',
          compact ? 'h-9 w-9' : 'h-12 w-12'
        )}
      >
        <Icon className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
      </div>
      <p className={cn('font-medium', compact ? 'text-sm' : 'text-base')}>{title}</p>
      {description && (
        <p className="max-w-sm text-pretty text-caption text-muted-foreground measure">{description}</p>
      )}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}

/* ── 加载 ────────────────────────────────────────────── */

/** 通用行/块骨架：比转圈更诚实（说明正在加载的是什么形状） */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2 p-3', className)} role="status" aria-label="加载中" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="skeleton-sheen h-7 w-7 rounded-md" />
          <Skeleton className="skeleton-sheen h-3.5 flex-1" style={{ maxWidth: `${90 - i * 12}%` }} />
          <Skeleton className="skeleton-sheen h-3.5 w-14 rounded" />
        </div>
      ))}
      <span className="sr-only">加载中…</span>
    </div>
  )
}

export function SkeletonCards({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div
      className={cn('grid gap-2 sm:grid-cols-2 lg:grid-cols-3', className)}
      role="status"
      aria-label="加载中"
      aria-busy="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="panel space-y-2.5 p-3.5">
          <Skeleton className="skeleton-sheen h-3.5 w-2/5" />
          <Skeleton className="skeleton-sheen h-7 w-3/5" />
          <Skeleton className="skeleton-sheen h-2.5 w-4/5" />
        </div>
      ))}
      <span className="sr-only">加载中…</span>
    </div>
  )
}

/** 表格内嵌加载行：让表格保持结构、不塌陷 */
export function TableSkeleton({ colSpan, rows = 4 }: { colSpan: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} aria-busy="true">
          <td colSpan={colSpan} className="p-3">
            <div className="flex items-center gap-3">
              <Skeleton className="skeleton-sheen h-6 w-6 rounded-md" />
              <Skeleton className="skeleton-sheen h-3 flex-1" style={{ maxWidth: `${85 - i * 15}%` }} />
            </div>
          </td>
        </tr>
      ))}
    </>
  )
}

/** 全屏/大块加载：带文案，避免「空白 + 转圈」的疑惑 */
export function LoadingBlock({ label = '正在加载…', className }: { label?: string; className?: string }) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center gap-2.5 py-14 text-muted-foreground', className)}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-5 w-5 animate-spin text-primary" />
      <p className="text-caption">{label}</p>
    </div>
  )
}

/* ── 错误 ────────────────────────────────────────────── */

/**
 * 错误态要说清三件事：发生了什么 / 为什么 / 现在能做什么。
 * action 提供「重试」等可执行的下一步。
 */
export function ErrorState({
  title = '加载失败',
  error,
  onRetry,
  retryLabel = '重试',
  hint,
  className,
  compact = false,
}: {
  title?: string
  error?: unknown
  onRetry?: () => void
  retryLabel?: string
  hint?: string
  className?: string
  compact?: boolean
}) {
  const isOffline =
    typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && !navigator.onLine
  const isAuth =
    typeof error === 'object' && error !== null && (error as { status?: number }).status === 401
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : isOffline
          ? '网络连接已断开'
          : '未知错误'

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2.5 text-center',
        compact ? 'px-4 py-8' : 'px-6 py-12',
        className
      )}
      role="alert"
    >
      <div
        className={cn(
          'flex items-center justify-center rounded-xl',
          compact ? 'h-9 w-9' : 'h-11 w-11',
          isOffline ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger'
        )}
      >
        {isOffline ? <WifiOff className={compact ? 'h-4 w-4' : 'h-5 w-5'} /> : <AlertCircle className={compact ? 'h-4 w-4' : 'h-5 w-5'} />}
      </div>
      <p className={cn('font-medium', compact ? 'text-sm' : 'text-base')}>{title}</p>
      <p className="max-w-md break-words text-caption text-muted-foreground measure">{message}</p>
      {isAuth ? (
        <p className="text-caption text-muted-foreground">请刷新页面重新登录。</p>
      ) : hint ? (
        <p className="text-caption text-muted-foreground">{hint}</p>
      ) : null}
      {onRetry && !isAuth && (
        <Button size="sm" variant="outline" onClick={onRetry} className="mt-1">
          <RefreshCw className="h-3.5 w-3.5" />
          {retryLabel}
        </Button>
      )}
    </div>
  )
}

/**
 * 四态统一容器：把「加载/错误/空/内容」的分支逻辑收在一处，
 * 让每个 Tab 不必重复写 if/else。
 */
export function AsyncBoundary<T>({
  isLoading,
  error,
  data,
  onRetry,
  isEmpty,
  empty,
  loading,
  children,
}: {
  isLoading: boolean
  error?: unknown
  data: T | undefined
  onRetry?: () => void
  isEmpty?: (data: T) => boolean
  empty?: React.ReactNode
  loading?: React.ReactNode
  children: (data: T) => React.ReactNode
}) {
  if (isLoading) return <>{loading ?? <LoadingBlock />}</>
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (data === undefined || data === null) return <LoadingBlock />
  if (isEmpty?.(data)) return <>{empty ?? <EmptyState title="暂无数据" />}</>
  return <>{children(data)}</>
}
