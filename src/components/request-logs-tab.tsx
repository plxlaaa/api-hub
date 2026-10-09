'use client'

import { useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, FileDown, Loader2, MessageSquare, RefreshCw, ScrollText, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyState, SkeletonRows } from '@/components/feedback'
import { KeyValue, LatencyReadout, StatusChip, Truncate } from '@/components/metrics'
import { ResponsiveList } from '@/components/responsive-list'
import { api, apiList, fmtTime } from '@/lib/api-client'
import type { RequestLogItem } from '@/types'

export function RequestLogsTab() {
  const qc = useQueryClient()
  // 筛选：'all' 全部 | '-' 管理测试（无密钥）| 具体密钥名
  const [tokenFilter, setTokenFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')
  const [channelFilter, setChannelFilter] = useState('all')
  const [okFilter, setOkFilter] = useState('all')
  // 游标分页：首屏 100 条，底部「加载更多」按 nextCursor 续拉（后端已就绪）
  const PAGE_SIZE = 100
  const logsQ = useInfiniteQuery({
    queryKey: ['request-logs', tokenFilter, modelFilter, channelFilter, okFilter],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (tokenFilter !== 'all') q.set('tokenName', tokenFilter)
      if (modelFilter !== 'all') q.set('model', modelFilter)
      if (channelFilter !== 'all') q.set('channelName', channelFilter)
      if (okFilter !== 'all') q.set('ok', okFilter)
      if (pageParam) q.set('cursor', pageParam)
      return api<{ items: RequestLogItem[]; nextCursor: string | null; hasMore: boolean }>(`/api/request-logs?${q.toString()}`)
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10000,
  })
  const logs = useMemo(() => logsQ.data?.pages.flatMap((p) => p.items) ?? [], [logsQ.data])
  const isLoading = logsQ.isLoading
  const hasMoreLogs = logsQ.hasNextPage
  // 筛选选项：从全量日志（不筛）里取 distinct 密钥/模型/渠道名
  const { data: allLogs = [] } = useQuery<RequestLogItem[]>({
    queryKey: ['request-logs', 'all'],
    queryFn: () => apiList<RequestLogItem>('/api/request-logs?limit=200'),
    refetchInterval: 30000,
  })
  const tokenOptions = useMemo(() => {
    const names = new Set<string>()
    for (const l of allLogs) names.add(l.tokenName || '（管理测试）')
    return Array.from(names).sort()
  }, [allLogs])
  const modelOptions = useMemo(() => {
    const names = new Set<string>()
    for (const l of allLogs) if (l.model) names.add(l.model)
    return Array.from(names).sort()
  }, [allLogs])
  const channelOptions = useMemo(() => {
    const names = new Set<string>()
    for (const l of allLogs) if (l.channelName) names.add(l.channelName)
    return Array.from(names).sort()
  }, [allLogs])
  const currentFilterIsCustom = tokenFilter !== 'all' && !tokenOptions.includes(tokenFilter === '-' ? '（管理测试）' : tokenFilter)

  const clear = useMutation({
    mutationFn: () => api('/api/request-logs', { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('调用日志已清空')
      qc.invalidateQueries({ queryKey: ['request-logs'] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
            <MessageSquare className="h-4 w-4 shrink-0" />
            网关调用日志
            <span className="text-caption font-normal text-muted-foreground">
              已加载 <span className="tabular">{logs.length}</span> 条{hasMoreLogs ? ' · 还有更早记录' : ''} · 最多保留 2000 条
            </span>
          </CardTitle>
          <div className="no-scrollbar -mx-1 flex w-full min-w-0 items-center gap-1.5 overflow-x-auto px-1">
            <Select value={modelFilter} onValueChange={setModelFilter}>
              <SelectTrigger className="h-8 w-40 text-xs" title="按模型筛选">
                <SelectValue placeholder="全部模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部模型</SelectItem>
                {modelOptions.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={channelFilter} onValueChange={setChannelFilter}>
              <SelectTrigger className="h-8 w-40 text-xs" title="按渠道筛选">
                <SelectValue placeholder="全部渠道" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部渠道</SelectItem>
                {channelOptions.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={okFilter} onValueChange={setOkFilter}>
              <SelectTrigger className="h-8 w-32 text-xs" title="按结果筛选">
                <SelectValue placeholder="全部结果" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部结果</SelectItem>
                <SelectItem value="1">仅成功</SelectItem>
                <SelectItem value="0">仅失败</SelectItem>
              </SelectContent>
            </Select>
            <Select value={tokenFilter} onValueChange={setTokenFilter}>
              <SelectTrigger className="h-8 w-44 text-xs" title="按发起请求的密钥筛选">
                <SelectValue placeholder="全部密钥" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部密钥</SelectItem>
                <SelectItem value="-">（管理测试）</SelectItem>
                {tokenOptions.filter((n) => n !== '（管理测试）').map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
                {currentFilterIsCustom && <SelectItem value={tokenFilter}>{tokenFilter}</SelectItem>}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={() => qc.invalidateQueries({ queryKey: ['request-logs'] })}>
              <RefreshCw className="h-4 w-4" /> 刷新
            </Button>
            <Button
              size="sm"
              variant="outline"
              title="按当前筛选条件导出 CSV（最多 5000 条）"
              disabled={logs.length === 0}
              onClick={async () => {
                try {
                  const params = new URLSearchParams()
                  if (modelFilter !== 'all') params.set('model', modelFilter)
                  if (channelFilter !== 'all') params.set('channelName', channelFilter)
                  if (okFilter !== 'all') params.set('ok', okFilter)
                  if (tokenFilter !== 'all') params.set('tokenName', tokenFilter)
                  const res = await fetch(`/api/request-logs/export?${params}`)
                  if (!res.ok) throw new Error(`导出失败 (${res.status})`)
                  const blob = await res.blob()
                  const a = document.createElement('a')
                  a.href = URL.createObjectURL(blob)
                  a.download = `调用日志-${new Date().toISOString().slice(0, 10)}.csv`
                  a.click()
                  URL.revokeObjectURL(a.href)
                  toast.success('CSV 已导出')
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : '导出失败')
                }
              }}
            >
              <FileDown className="h-4 w-4" /> 导出 CSV
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" disabled={logs.length === 0}>
                  <Trash2 className="h-4 w-4" /> 清空
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认清空全部调用日志？</AlertDialogTitle>
                  <AlertDialogDescription>此操作不可恢复，统计中的累计数据也会归零。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => clear.mutate()}>
                    清空
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <SkeletonRows rows={6} />
          ) : logs.length === 0 ? (
            <EmptyState
              compact
              icon={ScrollText}
              title="暂无调用记录"
              description="用统一 Key 对网关发起一次对话后，这里会逐条记录模型、渠道、延迟、Token 与失败原因。"
              action={
                <Button size="sm" variant="outline" asChild>
                  <a href="?tab=chat">去对话测试</a>
                </Button>
              }
            />
          ) : (
            <div className="max-h-[32rem] overflow-y-auto pr-1">
              <ResponsiveList
                keyOf={(l) => (l._raw as RequestLogItem).id}
                className="space-y-1.5"
                columns={[
                  { key: 'time', header: '时间', className: 'whitespace-nowrap' },
                  { key: 'model', header: '模型' },
                  { key: 'channel', header: '渠道' },
                  { key: 'attempt', header: '尝试', className: 'hidden md:table-cell' },
                  { key: 'token', header: '密钥', className: 'hidden md:table-cell' },
                  { key: 'result', header: '结果' },
                  { key: 'latency', header: '延迟', align: 'right' },
                  { key: 'tokens', header: 'Tokens', align: 'right', className: 'hidden sm:table-cell' },
                  { key: 'detail', header: '详情', className: 'hidden lg:table-cell max-w-64' },
                ]}
                items={logs.map((l) => ({
                  title: (
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{l.model}</span>
                      {l.stream && (
                        <Badge variant="secondary" className="shrink-0 px-1 py-0 text-micro">
                          流
                        </Badge>
                      )}
                    </span>
                  ),
                  subtitle: l.channelName,
                  badge: l.ok ? <StatusChip kind="ok">成功</StatusChip> : <StatusChip kind="danger">失败</StatusChip>,
                  metrics: [
                    { label: '延迟', value: <LatencyReadout ms={l.latencyMs} /> },
                    {
                      label: 'Tokens',
                      value: l.totalTokens == null ? <span className="text-muted-foreground">—</span> : <span className="tabular">{l.totalTokens.toLocaleString()}</span>,
                    },
                    {
                      label: '尝试',
                      value:
                        l.attempt != null && l.attempt > 1 ? (
                          <span className="text-status-warn">第 {l.attempt} 次</span>
                        ) : (
                          <span className="text-muted-foreground">首发</span>
                        ),
                    },
                    {
                      label: '实际模型',
                      value: <span className="mono-id truncate">{l.targetModel}</span>,
                    },
                  ],
                  detail: l.error ? (
                    <p className="break-words text-caption text-status-danger">
                      {l.statusCode ? `HTTP ${l.statusCode} · ` : ''}
                      {l.error}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <KeyValue label="发起密钥">{l.tokenName || '（管理员测试）'}</KeyValue>
                      <KeyValue label="实际模型" mono>
                        {l.targetModel}
                      </KeyValue>
                      <KeyValue label="时间">{fmtTime(l.createdAt)}</KeyValue>
                      {l.statusCode && <KeyValue label="状态码">HTTP {l.statusCode}</KeyValue>}
                    </div>
                  ),
                  _raw: l,
                }))}
                renderCell={(item, key) => {
                  const l = item._raw as RequestLogItem
                  switch (key) {
                    case 'time':
                      return <span className="tabular text-micro whitespace-nowrap text-muted-foreground">{fmtTime(l.createdAt)}</span>
                    case 'model':
                      return (
                        <div className="min-w-0 max-w-40">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate font-medium">{l.model}</p>
                            {l.stream && (
                              <Badge variant="secondary" className="shrink-0 px-1 py-0 text-micro">
                                流
                              </Badge>
                            )}
                          </div>
                          <p className="mono-id truncate text-micro text-muted-foreground">→ {l.targetModel}</p>
                        </div>
                      )
                    case 'channel':
                      return <Truncate className="max-w-36 text-caption text-muted-foreground">{l.channelName}</Truncate>
                    case 'attempt':
                      return l.attempt != null && l.attempt > 1 ? (
                        <Badge variant="outline" className="border-status-warn/40 bg-status-warn-soft px-1.5 py-0 text-micro text-status-warn">
                          第 {l.attempt} 次
                        </Badge>
                      ) : (
                        <span className="text-micro text-muted-foreground">首发</span>
                      )
                    case 'token':
                      return (
                        <Truncate className="max-w-28 text-micro text-muted-foreground" title={l.tokenName || '管理员测试'}>
                          {l.tokenName || '（管理测试）'}
                        </Truncate>
                      )
                    case 'result':
                      return l.ok ? (
                        <StatusChip kind="ok">成功</StatusChip>
                      ) : (
                        <StatusChip kind="danger" title={l.error ?? undefined}>
                          {l.statusCode ? String(l.statusCode) : '失败'}
                        </StatusChip>
                      )
                    case 'latency':
                      return (
                        <div className="text-right">
                          <LatencyReadout ms={l.latencyMs} />
                        </div>
                      )
                    case 'tokens':
                      return (
                        <span className="tabular text-caption">{l.totalTokens?.toLocaleString() ?? '—'}</span>
                      )
                    case 'detail':
                      return l.error ? (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block cursor-help truncate text-micro text-status-danger">
                                {l.statusCode ? `HTTP ${l.statusCode} ` : ''}
                                {l.error}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm break-all">
                              <p className="text-caption">
                                {l.statusCode ? `HTTP ${l.statusCode} · ` : ''}
                                {l.error}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className="mono-id block truncate text-micro text-muted-foreground">→ {l.targetModel}</span>
                      )
                    default:
                      return null
                  }
                }}
              />
              {hasMoreLogs && (
                <div className="flex justify-center pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => logsQ.fetchNextPage()}
                    disabled={logsQ.isFetchingNextPage}
                  >
                    {logsQ.isFetchingNextPage ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    加载更多（已显示 {logs.length} 条）
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
