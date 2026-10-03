'use client'
import { useRef, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, CheckCircle2, FileDown, KeyRound, Loader2, MessageSquare, RefreshCw, TrendingUp, Trophy, Upload, Wifi, WifiOff, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { api, fmtTime, getStoredToken } from '@/lib/api-client'
import type { ApiTokenItem, Channel, ProbeLogItem, Stats } from '@/types'
import { cn } from '@/lib/utils'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'

const STATUS_META: Record<string, { label: string; dot: string; badge: string }> = {
  online: { label: '在线', dot: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
  offline: { label: '离线', dot: 'bg-red-500', badge: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
  unknown: { label: '未知', dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' },
}

function StatusBadge({ channel }: { channel: Channel }) {
  const meta = STATUS_META[channel.enabled ? channel.status : 'unknown'] ?? STATUS_META.unknown
  const label = channel.enabled ? meta.label : '已停用'
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', meta.badge)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', channel.enabled ? meta.dot : 'bg-zinc-400')} />
      {label}
    </span>
  )
}

export function DashboardTab() {
  const qc = useQueryClient()
  const { data: channels = [], isLoading } = useQuery<Channel[]>({
    queryKey: ['channels'],
    queryFn: () => api('/api/channels'),
    refetchInterval: 8000,
  })
  const { data: logs = [] } = useQuery<ProbeLogItem[]>({
    queryKey: ['logs'],
    queryFn: () => api('/api/logs'),
    refetchInterval: 10000,
  })
  const { data: tokens = [] } = useQuery<ApiTokenItem[]>({
    queryKey: ['tokens'],
    queryFn: () => api('/api/tokens'),
    refetchInterval: 15000,
  })
  const { data: stats } = useQuery<Stats>({
    queryKey: ['stats'],
    queryFn: () => api('/api/stats'),
    refetchInterval: 15000,
  })

  const probeAll = useMutation({
    mutationFn: () => api('/api/channels/probe-all', { method: 'POST' }),
    onSuccess: () => {
      toast.success('已触发全部渠道检测')
      setTimeout(() => qc.invalidateQueries({ queryKey: ['channels'] }), 1500)
    },
    onError: (e) => toast.error(e.message),
  })

  const probeOne = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; fixedNote?: string | null }>(`/api/channels/${id}/probe`, { method: 'POST' }),
    onSuccess: (result) => {
      if (result.fixedNote) toast.success('探测通过，' + result.fixedNote, { duration: 8000 })
      else if (result.ok) toast.success('探测通过')
      else toast.error('探测失败，请看渠道最近错误')
      qc.invalidateQueries({ queryKey: ['channels'] })
      qc.invalidateQueries({ queryKey: ['logs'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const online = channels.filter((c) => c.enabled && c.status === 'online').length
  const offline = channels.filter((c) => c.enabled && c.status === 'offline').length
  const disabled = channels.filter((c) => !c.enabled).length
  const successRate = stats && stats.today.calls > 0
    ? `${Math.round(((stats.today.calls - stats.today.fails) / stats.today.calls) * 100)}%`
    : '—'

  // 渠道横评 Top5：按累计调用量排序（数据来自 V23 渠道统计聚合）
  const topChannels = [...channels].filter((c) => (c.stats?.calls ?? 0) > 0).sort((a, b) => (b.stats?.calls ?? 0) - (a.stats?.calls ?? 0)).slice(0, 5)
  const [trendMode, setTrendMode] = useState<'24h' | '7d'>('24h')

  // 配置备份（fetch+blob 下载，带 Authorization 头）
  const exportConfig = async (withKeys: boolean) => {
    try {
      const res = await fetch(`/api/config/export${withKeys ? '?keys=1' : ''}`, { headers: { Authorization: `Bearer ${getStoredToken() ?? ''}` } })
      if (!res.ok) throw new Error(`导出失败 (${res.status})`)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `api-hub备份-${new Date().toISOString().slice(0, 10)}${withKeys ? '-含密钥' : ''}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success(withKeys ? '完整备份已导出（含密钥，请妥善保管）' : '配置备份已导出（不含密钥）')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    }
  }
  const importFileRef = useRef<HTMLInputElement>(null)
  const importConfig = useMutation({
    mutationFn: (file: File) =>
      new Promise<{ channelsAdded: number; channelsSkipped: number; routesAdded: number; routesSkipped: number; channelsMissingKey: number }>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = async () => {
          try {
            const json = JSON.parse(String(reader.result))
            const res = await api<{ channelsAdded: number; channelsSkipped: number; routesAdded: number; routesSkipped: number; channelsMissingKey: number }>('/api/config/import', { method: 'POST', body: JSON.stringify(json) })
            resolve(res)
          } catch (e) {
            reject(e instanceof Error ? e : new Error('文件解析失败'))
          }
        }
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsText(file)
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['channels'] })
      qc.invalidateQueries({ queryKey: ['routes'] })
      const parts = [`渠道 +${r.channelsAdded}（跳过 ${r.channelsSkipped}）`, `路由 +${r.routesAdded}（跳过 ${r.routesSkipped}）`]
      if (r.channelsMissingKey > 0) parts.push(`${r.channelsMissingKey} 个渠道缺密钥需补填`)
      toast.success('配置导入完成', { description: parts.join(' · ') })
    },
    onError: (e) => toast.error('导入失败', { description: e.message }),
  })

  return (
    <div className="space-y-6">
      {/* 备份工具栏 */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => exportConfig(false)}><FileDown className="h-4 w-4" /> 导出配置（不含密钥）</Button>
        <Button size="sm" variant="outline" onClick={() => exportConfig(true)}><FileDown className="h-4 w-4" /> 导出完整备份（含密钥）</Button>
        <Button size="sm" variant="outline" disabled={importConfig.isPending} onClick={() => importFileRef.current?.click()}>
          {importConfig.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} 导入备份
        </Button>
        <input
          ref={importFileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) importConfig.mutate(f)
            e.target.value = ''
          }}
        />
      </div>

      {/* 渠道统计卡 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10"><Activity className="h-5 w-5 text-primary" /></div>
          <div><p className="text-xs text-muted-foreground">渠道总数</p><p className="tabular text-2xl font-semibold">{channels.length}</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-600/10"><Wifi className="h-5 w-5 text-emerald-600" /></div>
          <div><p className="text-xs text-muted-foreground">在线</p><p className="tabular text-2xl font-semibold text-emerald-600">{online}</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-500/10"><WifiOff className="h-5 w-5 text-red-500" /></div>
          <div><p className="text-xs text-muted-foreground">离线</p><p className="tabular text-2xl font-semibold text-red-500">{offline}</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-500/10"><XCircle className="h-5 w-5 text-zinc-400" /></div>
          <div><p className="text-xs text-muted-foreground">已停用</p><p className="tabular text-2xl font-semibold text-zinc-400">{disabled}</p></div>
        </CardContent></Card>
      </div>

      {/* 调用统计卡 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10"><MessageSquare className="h-5 w-5 text-primary" /></div>
          <div><p className="text-xs text-muted-foreground">今日调用</p><p className="tabular text-2xl font-semibold">{stats?.today.calls ?? 0}</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-500/10"><XCircle className="h-5 w-5 text-red-500" /></div>
          <div><p className="text-xs text-muted-foreground">今日失败</p><p className="tabular text-2xl font-semibold text-red-500">{stats?.today.fails ?? 0}</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10"><TrendingUp className="h-5 w-5 text-primary" /></div>
          <div><p className="text-xs text-muted-foreground">累计调用</p><p className="tabular text-2xl font-semibold">{stats?.total.calls ?? 0}</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-600/10"><CheckCircle2 className="h-5 w-5 text-emerald-600" /></div>
          <div><p className="text-xs text-muted-foreground">今日成功率</p><p className="tabular text-2xl font-semibold text-emerald-600">{successRate}</p></div>
        </CardContent></Card>
      </div>

      {/* 密钥配额汇总 */}
      {tokens.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" /> 密钥配额汇总</CardTitle>
            <span className="text-xs text-muted-foreground">
              共 {tokens.filter((t) => t.enabled).length} 个启用密钥
            </span>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {tokens.map((t) => {
                const pct = t.quotaLimit ? Math.min(100, Math.round((t.quotaUsed / t.quotaLimit) * 100)) : 0
                const exhausted = t.quotaLimit !== null && t.quotaUsed >= t.quotaLimit
                return (
                  <div key={t.id} className="flex items-center gap-3">
                    <div className="flex w-44 min-w-0 items-center gap-2">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', t.enabled ? 'bg-emerald-500' : 'bg-zinc-400')} />
                      <span className="truncate text-sm font-medium" title={t.name}>{t.name}</span>
                      {!t.enabled && <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] text-zinc-400">停用</Badge>}
                    </div>
                    {t.quotaLimit !== null ? (
                      <div className="flex flex-1 items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn('h-full rounded-full', exhausted ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-emerald-500')}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className={cn('w-24 shrink-0 text-right text-xs tabular-nums', exhausted ? 'font-medium text-red-500' : 'text-muted-foreground')}>
                          {t.quotaUsed}/{t.quotaLimit}（{pct}%）
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-1 items-center justify-between">
                        <span className="text-xs text-muted-foreground">不限量</span>
                        <span className="text-xs tabular-nums text-muted-foreground">已用 {t.quotaUsed} 次</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 调用趋势：24h / 7d 切换 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{trendMode === '24h' ? '近 24 小时调用趋势' : '近 7 天调用趋势'}</CardTitle>
          <div className="flex rounded-md border text-xs">
            {(['24h', '7d'] as const).map((m) => (
              <button
                key={m}
                className={cn('px-2.5 py-1', trendMode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                onClick={() => setTrendMode(m)}
              >
                {m === '24h' ? '24 小时' : '7 天'}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {trendMode === '24h' ? (
            !stats || stats.total.calls === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                暂无调用数据 —— 用统一 Key 发起对话后，这里会出现趋势图
              </div>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.hourly} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                    <XAxis dataKey="hour" tick={{ fontSize: 11 }} interval={3} stroke="currentColor" opacity={0.5} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                    <ChartTooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      formatter={(value: number | string, name: string) => [value, name === 'calls' ? '调用' : '失败']}
                    />
                    <Legend formatter={(v: string) => (v === 'calls' ? '调用' : '失败')} wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="calls" fill="#10b981" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="fails" fill="#ef4444" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )
          ) : (
            !stats?.daily7 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">暂无数据</div>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.daily7} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                    <ChartTooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      formatter={(value: number | string, name: string) => [name === 'tokens' ? `${Number(value).toLocaleString()} tok` : value, name === 'calls' ? '调用' : name === 'fails' ? '失败' : 'Token']}
                    />
                    <Legend formatter={(v: string) => (v === 'calls' ? '调用' : v === 'fails' ? '失败' : 'Token')} wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="calls" fill="#10b981" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="fails" fill="#ef4444" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="tokens" fill="#6366f1" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )
          )}
        </CardContent>
      </Card>

      {/* 渠道横评 Top5 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base"><Trophy className="h-4 w-4 text-amber-500" /> 渠道横评 Top5</CardTitle>
          <span className="text-xs text-muted-foreground">按累计调用量排序</span>
        </CardHeader>
        <CardContent>
          {topChannels.length === 0 ? (
            <div className="flex h-16 items-center justify-center text-sm text-muted-foreground">
              还没有调用记录 —— 发起调用后这里会出现渠道排行
            </div>
          ) : (
            <div className="space-y-2.5">
              {topChannels.map((c, i) => {
                const s = c.stats!
                const rate = Math.round((s.ok / s.calls) * 100)
                return (
                  <div key={c.id} className="flex items-center gap-3">
                    <span className={cn('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold', i === 0 ? 'bg-amber-500 text-white' : 'bg-muted text-muted-foreground')}>{i + 1}</span>
                    <span className="w-32 min-w-0 truncate text-sm font-medium" title={c.name}>{c.name}</span>
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className={cn('h-full rounded-full', rate >= 95 ? 'bg-emerald-500' : rate >= 80 ? 'bg-amber-500' : 'bg-red-500')} style={{ width: `${Math.max(4, rate)}%` }} />
                    </div>
                    <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {s.calls} 次 · {rate}%{s.avgLatencyMs != null ? ` · ${(s.avgLatencyMs / 1000).toFixed(1)}s` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 渠道状态 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">渠道实时状态</CardTitle>
          <Button size="sm" variant="outline" onClick={() => probeAll.mutate()} disabled={probeAll.isPending}>
            {probeAll.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            全部检测
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex h-24 items-center justify-center text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中…</div>
          ) : channels.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              还没有渠道，请到「渠道管理」添加你的公益站 API
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {channels.map((c) => (
                <div key={c.id} className="rounded-lg border p-4 space-y-2 transition-colors hover:bg-accent/40">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.baseUrl}</p>
                    </div>
                    <StatusBadge channel={c} />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>延迟：{c.latencyMs != null ? `${c.latencyMs} ms` : '—'}</span>
                    <span>检查于 {fmtTime(c.lastCheckAt)}</span>
                  </div>
                  {stats?.channelUsage?.[c.name] && (
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
                        24h {stats.channelUsage[c.name].calls} 次
                      </Badge>
                      {stats.channelUsage[c.name].fails > 0 && (
                        <Badge variant="destructive" className="h-5 px-1.5 text-[11px]">
                          失败 {stats.channelUsage[c.name].fails}
                        </Badge>
                      )}
                      {stats.channelUsage[c.name].avgLatencyMs != null && (
                        <span className="text-muted-foreground">均 {stats.channelUsage[c.name].avgLatencyMs}ms</span>
                      )}
                    </div>
                  )}
                  {c.lastError && (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <p className="truncate text-xs text-destructive cursor-help">⚠ {c.lastError}</p>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs break-all"><p className="text-xs">{c.lastError}</p></TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  <Button
                    size="sm" variant="secondary" className="h-7 w-full"
                    onClick={() => probeOne.mutate(c.id)} disabled={probeOne.isPending}
                  >
                    {probeOne.isPending && probeOne.variables === c.id
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <><RefreshCw className="h-3 w-3" />检测</>}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 探测日志 */}
      <Card>
        <CardHeader><CardTitle className="text-base">最近探测记录</CardTitle></CardHeader>
        <CardContent>
          <ScrollArea className="max-h-80">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>渠道</TableHead>
                  <TableHead>结果</TableHead>
                  <TableHead>延迟</TableHead>
                  <TableHead className="hidden md:table-cell">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="h-16 text-center text-muted-foreground">暂无记录</TableCell></TableRow>
                ) : (
                  logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap text-xs">{fmtTime(l.createdAt)}</TableCell>
                      <TableCell className="text-sm">{l.channelName}</TableCell>
                      <TableCell>
                        {l.ok ? (
                          <Badge variant="outline" className="gap-1 border-emerald-300 text-emerald-600"><CheckCircle2 className="h-3 w-3" />成功</Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1 border-red-300 text-red-600"><XCircle className="h-3 w-3" />失败</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{l.latencyMs != null ? `${l.latencyMs} ms` : '—'}</TableCell>
                      <TableCell className="hidden max-w-64 truncate text-xs text-muted-foreground md:table-cell">
                        {l.statusCode ? `HTTP ${l.statusCode}` : ''} {l.error || ''}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
