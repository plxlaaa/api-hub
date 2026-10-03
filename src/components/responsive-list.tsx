'use client'

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 响应式数据列表：桌面是表格，窄屏自动降级为卡片列表。
 *
 * 为什么不直接用 Table + overflow-x-auto？因为横向滚动的表格在手机上
 * 意味着「信息在屏幕外」，扫读体验很差。这里用同一份数据渲染两种形态，
 * 用 CSS 媒体查询切换（不额外渲染、不闪屏、零 JS 状态）。
 *
 * 语义：桌面 <table>，窄屏 <ul>/<li> 卡片，屏幕阅读器各读其一份。
 */

export type ResponsiveItem = {
  /** 主标题（渠道名 / 路由名 / 模型名） */
  title: React.ReactNode
  /** 副标题：备注 / 格式标签等 */
  subtitle?: React.ReactNode
  /** 状态标记区，窄屏时置于标题行右侧 */
  badge?: React.ReactNode
  /** 关键指标区，窄屏时展开为标签-数值网格 */
  metrics?: { label: string; value: React.ReactNode }[]
  /** 次要信息（URL、错误详情），窄屏时默认折叠 */
  detail?: React.ReactNode
  /** 操作区：窄屏时整行铺满按钮 */
  actions?: React.ReactNode
  /** 逃生舱：调用方挂原始对象，供 renderCell 复用（不进 DOM） */
  _raw?: unknown
}

export function ResponsiveList({
  items,
  keyOf,
  columns,
  renderCell,
  empty,
  className,
  /** 窄屏卡片是否默认展开详情 */
  defaultExpanded = false,
}: {
  items: ResponsiveItem[]
  keyOf: (item: ResponsiveItem, index: number) => string
  /** 桌面表格列定义 */
  columns: { key: string; header: React.ReactNode; className?: string; align?: 'left' | 'right' }[]
  /** 渲染某列的单元格内容 */
  renderCell: (item: ResponsiveItem, key: string) => React.ReactNode
  empty?: React.ReactNode
  className?: string
  defaultExpanded?: boolean
}) {
  return (
    <div className={className}>
      {/* ── 桌面：真表格 ─────────────────────────────── */}
      <div className="hidden md:block">
        <div className="scroll-hint overflow-x-auto rounded-lg border">
          <table className="w-full caption-bottom text-sm">
            <thead className="bg-muted/40">
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={cn(
                      'h-8 px-3 text-micro font-medium tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase',
                      c.align === 'right' ? 'text-right' : 'text-left',
                      c.className
                    )}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={keyOf(item, i)} className="border-t transition-colors hover:bg-muted/50">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn('px-3 py-2 align-middle', c.align === 'right' ? 'text-right' : 'text-left', c.className)}
                    >
                      {renderCell(item, c.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 窄屏：卡片列表 ───────────────────────────── */}
      <ul className="flex flex-col gap-1.5 md:hidden">
        {items.map((item, i) => (
          <li key={keyOf(item, i)}>
            <MobileCard item={item} defaultExpanded={defaultExpanded} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function MobileCard({ item, defaultExpanded }: { item: ResponsiveItem; defaultExpanded: boolean }) {
  const [open, setOpen] = React.useState(defaultExpanded)
  const hasDetail = Boolean(item.detail)

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.title}</p>
          {item.subtitle && <p className="mt-0.5 truncate text-micro text-muted-foreground">{item.subtitle}</p>}
        </div>
        {item.badge && <div className="shrink-0">{item.badge}</div>}
      </div>

      {item.metrics && item.metrics.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t px-3 py-2.5">
          {item.metrics.map((m) => (
            <div key={m.label} className="min-w-0">
              <dt className="truncate text-micro tracking-[0.04em] text-muted-foreground uppercase">{m.label}</dt>
              <dd className="mt-0.5 truncate text-caption font-medium">{m.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {hasDetail && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex w-full touch-target items-center justify-center gap-1 border-t px-3 text-micro font-medium text-muted-foreground"
          >
            {open ? '收起详情' : '展开详情'}
            <ChevronDown className={cn('h-3 w-3 transition-transform duration-200', open && 'rotate-180')} />
          </button>
          {open && <div className="border-t bg-muted/30 px-3 py-2.5 text-caption">{item.detail}</div>}
        </>
      )}

      {item.actions && (
        <div className="flex flex-wrap items-center gap-1.5 border-t p-2 [&>button]:min-h-9 [&>button]:flex-1">
          {item.actions}
        </div>
      )}
    </div>
  )
}

/**
 * 工具栏：桌面横排一行，窄屏可横向滚动（不换行挤压）。
 * 用于卡片头部的操作按钮组。
 */
export function Toolbar({
  children,
  className,
  scroll = true,
}: {
  children: React.ReactNode
  className?: string
  scroll?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5',
        scroll && 'no-scrollbar -mx-1 overflow-x-auto px-1',
        className
      )}
    >
      {children}
    </div>
  )
}
