'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, FileDown, MessageSquare, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { api, fmtTime, getStoredToken } from '@/lib/api-client'
import type { RequestLogItem } from '@/types'

export function RequestLogsTab() {
  const qc = useQueryClient()
  // 筛选：'all' 全部 | '-' 管理测试（无密钥）| 具体密钥名
  const [tokenFilter, setTokenFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')
  const [channelFilter, setChannelFilter] = useState('all')
  const [okFilter, setOkFilter] = useState('all')
  const qs = new URLSearchParams({ limit: '200' })
  if (tokenFilter !== 'all') qs.set('tokenName', tokenFilter)
  if (modelFilter !== 'all') qs.set('model', modelFilter)
  if (channelFilter !== 'all') qs.set('channelName', channelFilter)
  if (okFilter !== 'all') qs.set('ok', okFilter)
  const { data: logs = [], isLoading } = useQuery<RequestLogItem[]>({
    queryKey: ['request-logs', tokenFilter, modelFilter, channelFilter, okFilter],
    queryFn: () => api(`/api/request-logs?${qs.toString()}`),
    refetchInterval: 10000,
  })
  // 筛选选项：从全量日志（不筛）里取 distinct 密钥/模型/渠道名
  const { data: allLogs = [] } = useQuery<RequestLogItem[]>({
    queryKey: ['request-logs', 'all'],
    queryFn: () => api('/api/request-logs?limit=200'),
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
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-4 w-4" /> 网关调用日志
            <span className="text-xs font-normal text-muted-foreground">（最近 {logs.length} 条 / 最多保留 2000 条）</span>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
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
                  const res = await fetch(`/api/request-logs/export?${params}`, { headers: { Authorization: `Bearer ${getStoredToken() ?? ''}` } })
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
            <div className="flex h-24 items-center justify-center text-muted-foreground">加载中…</div>
          ) : logs.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              暂无调用记录 —— 用统一 Key 对网关发起一次对话后，这里会记录每次调用的明细
            </div>
          ) : (
            <ScrollArea className="max-h-[28rem]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead className="hidden md:table-cell">尝试</TableHead>
                    <TableHead className="hidden md:table-cell">密钥</TableHead>
                    <TableHead>结果</TableHead>
                    <TableHead>延迟</TableHead>
                    <TableHead className="hidden sm:table-cell">Tokens</TableHead>
                    <TableHead className="hidden lg:table-cell">详情</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap text-xs">{fmtTime(l.createdAt)}</TableCell>
                      <TableCell className="max-w-40 truncate text-sm font-medium" title={`${l.model} → ${l.targetModel}`}>
                        {l.model}
                        {l.stream && <Badge variant="secondary" className="ml-1.5 px-1 py-0 text-[10px]">流</Badge>}
                      </TableCell>
                      <TableCell className="max-w-36 truncate text-sm text-muted-foreground" title={l.channelName}>{l.channelName}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {l.attempt != null && l.attempt > 1 ? (
                          <Badge variant="outline" className="border-amber-300 px-1.5 py-0 text-[10px] text-amber-600">第 {l.attempt} 次</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">首发</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden max-w-28 truncate text-xs text-muted-foreground md:table-cell" title={l.tokenName || '管理员测试'}>{l.tokenName || '（管理测试）'}</TableCell>
                      <TableCell>
                        {l.ok ? (
                          <Badge variant="outline" className="gap-1 border-emerald-300 text-emerald-600"><CheckCircle2 className="h-3 w-3" />成功</Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1 border-red-300 text-red-600"><XCircle className="h-3 w-3" />失败</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{l.latencyMs != null ? `${(l.latencyMs / 1000).toFixed(1)} s` : '—'}</TableCell>
                      <TableCell className="hidden text-xs sm:table-cell">{l.totalTokens ?? '—'}</TableCell>
                      <TableCell className="hidden max-w-64 truncate text-xs text-muted-foreground lg:table-cell">
                        {l.error ? (
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help text-destructive">{l.statusCode ? `HTTP ${l.statusCode} ` : ''}{l.error}</span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-sm break-all"><p className="text-xs">{l.statusCode ? `HTTP ${l.statusCode} ` : ''}{l.error}</p></TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          `→ ${l.targetModel}`
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
