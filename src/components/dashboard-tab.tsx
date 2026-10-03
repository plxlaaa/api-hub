'use client'
import { useRef, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, FileDown, Loader2, RefreshCw, ScrollText, Store, Trophy, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyState, SkeletonCards } from '@/components/feedback'
import {
  LatencyReadout,
  Metric,
  MetricGrid,
  RatioBar,
  SectionHeading,
  StatusChip,
  StatusDot,
  StatusLabel,
  fmtLatency,
} from '@/components/metrics'
import { channelStatus } from '@/lib/channel-ui'
import { api, fmtTime } from '@/lib/api-client'
import type { ApiTokenItem, Channel, ProbeLogItem, Stats } from '@/types'
import { cn } from '@/lib/utils'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'

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
  /** 异常 = 探测离线 + 熔断摘除（两者都需要运维介入） */
  const offline = channels.filter((c) => c.enabled && (c.status === 'offline' || c.autoDisabled)).length
  const disabled = channels.filter((c) => !c.enabled).length
  /** 成功率数值（0-100），无数据时为 null —— 供语义色分档与展示共用 */
  const successRateValue =
    stats && stats.today.calls > 0 ? ((stats.today.calls - stats.today.fails) / stats.today.calls) * 100 : null
  const successRate = successRateValue == null ? '—' : `${Math.round(successRateValue)}%`

  /** 探测延迟均值：仅统计有延迟样本的渠道 */
  const latencySamples = channels.filter((c) => c.latencyMs != null)
  const probeAvg =
    latencySamples.length > 0 ? latencySamples.reduce((s, c) => s + (c.latencyMs ?? 0), 0) / latencySamples.length : null

  // 渠道横评 Top5：按累计调用量排序（数据来自 V23 渠道统计聚合）
  const topChannels = [...channels].filter((c) => (c.stats?.calls ?? 0) > 0).sort((a, b) => (b.stats?.calls ?? 0) - (a.stats?.calls ?? 0)).slice(0, 5)
  const [trendMode, setTrendMode] = useState<'24h' | '7d'>('24h')

  // 配置备份（fetch+blob 下载，Cookie 会话自动携带）
  const exportConfig = async (withKeys: boolean) => {
    try {
      const res = await fetch(`/api/config/export${withKeys ? '?keys=1' : ''}`)
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
      {/* 备份工具栏：窄屏横向滚动，避免按钮堆三行 */}
      <div className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4">
        <Button size="sm" variant="outline" onClick={() => exportConfig(false)} className="shrink-0">
          <FileDown className="h-4 w-4" />
          导出配置（不含密钥）
        </Button>
        <Button size="sm" variant="outline" onClick={() => exportConfig(true)} className="shrink-0">
          <FileDown className="h-4 w-4" />
          导出完整备份（含密钥）
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={importConfig.isPending}
          onClick={() => importFileRef.current?.click()}
        >
          {importConfig.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          导入备份
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

      {/* ── 渠道健康：仪表读数区 ─────────────────────── */}
      <section aria-label="渠道健康" className="panel p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">渠道健康</h2>
          <div className="flex flex-wrap items-center gap-3 text-caption">
            <StatusLabel kind="ok" live={offline === 0 && online > 0}>{online} 在线</StatusLabel>
            {offline > 0 && <StatusLabel kind="danger">{offline} 异常</StatusLabel>}
            {disabled > 0 && <StatusLabel kind="idle">{disabled} 停用</StatusLabel>}
          </div>
        </div>
        <MetricGrid>
          <Metric
            label="渠道总数"
            value={channels.length}
            unit="个"
            kind={channels.length === 0 ? 'idle' : 'info'}
            hint={channels.length === 0 ? '尚未接入上游' : `已启用 ${channels.length - disabled} 个`}
          />
          <Metric label="在线" value={online} unit="个" kind={online > 0 ? 'ok' : 'idle'} hint="探测正常可转发" />
          <Metric
            label="异常"
            value={offline}
            unit="个"
            kind={offline > 0 ? 'danger' : 'ok'}
            hint={offline > 0 ? '需检查 Key 或上游' : '全部正常'}
          />
          <Metric label="已停用" value={disabled} unit="个" kind="idle" hint="不参与路由" />
        </MetricGrid>
      </section>

      {/* ── 调用统计：仪表读数区 ─────────────────────── */}
      <section aria-label="调用统计" className="panel p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">调用统计</h2>
          <span className="text-caption text-muted-foreground">
            今日成功率{' '}
            <span
              className={cn(
                'tabular font-medium',
                successRateValue == null && 'text-status-idle',
                successRateValue != null && successRateValue >= 95 && 'text-status-ok',
                successRateValue != null && successRateValue >= 80 && successRateValue < 95 && 'text-status-info',
                successRateValue != null && successRateValue >= 50 && successRateValue < 80 && 'text-status-warn',
                successRateValue != null && successRateValue < 50 && 'text-status-danger'
              )}
            >
              {successRate}
            </span>
          </span>
        </div>
        <MetricGrid>
          <Metric
            label="今日调用"
            value={(stats?.today.calls ?? 0).toLocaleString()}
            unit="次"
            kind="info"
            hint={`失败 ${stats?.today.fails ?? 0} 次`}
          />
          <Metric
            label="今日失败"
            value={(stats?.today.fails ?? 0).toLocaleString()}
            unit="次"
            kind={(stats?.today.fails ?? 0) > 0 ? 'danger' : 'ok'}
            hint={(stats?.today.fails ?? 0) > 0 ? '检查下方日志定位原因' : '无失败请求'}
          />
          <Metric
            label="累计调用"
            value={(stats?.total.calls ?? 0).toLocaleString()}
            unit="次"
            kind="idle"
            hint="自网关启用以来"
          />
          <Metric
            label="探测延迟"
            value={probeAvg == null ? '—' : (probeAvg / 1000).toFixed(2)}
            unit={probeAvg == null ? undefined : 's'}
            kind={probeAvg == null ? 'idle' : probeAvg < 1500 ? 'ok' : probeAvg < 4000 ? 'info' : 'warn'}
            hint={probeAvg == null ? '暂无探测样本' : `${channels.filter((c) => c.latencyMs != null).length} 个渠道均值`}
          />
        </MetricGrid>
      </section>

      {/* ── 密钥配额 ─────────────────────────────────── */}
      {tokens.length > 0 && (
        <section aria-label="密钥配额" className="panel p-4">
          <SectionHeading
            title="密钥配额"
            description={`共 ${tokens.filter((t) => t.enabled).length} 个启用密钥`}
          />
          <ul className="mt-3.5 flex flex-col gap-1.5">
            {tokens.map((t) => {
              const hasLimit = t.quotaLimit !== null
              const pct = hasLimit ? Math.min(100, Math.round((t.quotaUsed / t.quotaLimit!) * 100)) : null
              const exhausted = hasLimit && t.quotaUsed >= t.quotaLimit!
              return (
                <li
                  key={t.id}
                  className="flex flex-col gap-1.5 rounded-lg border border-hairline px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
                >
                  <div className="flex min-w-0 items-center gap-2 sm:w-44 sm:shrink-0">
                    <StatusDot kind={t.enabled ? 'ok' : 'idle'} />
                    <span className="truncate text-caption font-medium" title={t.name}>
                      {t.name}
                    </span>
                    {!t.enabled && (
                      <Badge variant="outline" className="shrink-0 px-1 py-0 text-micro text-status-idle">
                        停用
                      </Badge>
                    )}
                  </div>
                  {pct != null ? (
                    <>
                      <RatioBar
                        value={pct}
                        kind={exhausted ? 'danger' : pct > 80 ? 'warn' : 'ok'}
                        className="min-w-0 flex-1"
                      />
                      <span
                        className={cn(
                          'tabular shrink-0 text-micro sm:w-28 sm:text-right',
                          exhausted ? 'font-medium text-status-danger' : 'text-muted-foreground'
                        )}
                      >
                        {t.quotaUsed.toLocaleString()} / {t.quotaLimit!.toLocaleString()}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-micro text-muted-foreground sm:flex-1">不限量</span>
                      <span className="tabular shrink-0 text-micro text-muted-foreground">
                        已用 {t.quotaUsed.toLocaleString()} 次
                      </span>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* ── 调用趋势 ─────────────────────────────────── */}
      <section aria-label="调用趋势" className="panel p-4">
        <SectionHeading
          title={trendMode === '24h' ? '近 24 小时调用趋势' : '近 7 天调用趋势'}
          description="调用与失败的逐时/逐日分布"
          action={
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="时间范围">
              {(['24h', '7d'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={trendMode === m}
                  className={cn(
                    'min-h-7 rounded-[5px] px-2.5 text-caption font-medium',
                    trendMode === m
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => setTrendMode(m)}
                >
                  {m === '24h' ? '24 小时' : '7 天'}
                </button>
              ))}
            </div>
          }
        />
        <div className="mt-4">
          {trendMode === '24h' ? (
            !stats || stats.total.calls === 0 ? (
              <EmptyState
                compact
                icon={BarChart3}
                title="暂无调用数据"
                description="用统一 Key 或在「对话测试」发一条消息，这里就会出现趋势图。"
                action={
                  <Button size="sm" variant="outline" asChild>
                    <a href="?tab=chat">去对话测试</a>
                  </Button>
                }
              />
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.hourly} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} vertical={false} />
                    <XAxis dataKey="hour" tick={{ fontSize: 11 }} interval={3} stroke="currentColor" opacity={0.5} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                    <ChartTooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      cursor={{ fill: 'var(--muted)' }}
                      formatter={(value: number | string, name: string) => [value, name === 'calls' ? '调用' : '失败']}
                    />
                    <Legend formatter={(v: string) => (v === 'calls' ? '调用' : '失败')} wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="calls" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="fails" fill="var(--status-danger)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )
          ) : (
            !stats?.daily7 ? (
              <EmptyState compact icon={BarChart3} title="暂无 7 天数据" description="连续运行几天后这里会显示每日调用与 Token 消耗。" />
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.daily7} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                    <ChartTooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      cursor={{ fill: 'var(--muted)' }}
                      formatter={(value: number | string, name: string) => [
                        name === 'tokens' ? `${Number(value).toLocaleString()} tok` : value,
                        name === 'calls' ? '调用' : name === 'fails' ? '失败' : 'Token',
                      ]}
                    />
                    <Legend
                      formatter={(v: string) => (v === 'calls' ? '调用' : v === 'fails' ? '失败' : 'Token')}
                      wrapperStyle={{ fontSize: 12 }}
                    />
                    <Bar dataKey="calls" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="fails" fill="var(--status-danger)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="tokens" fill="var(--chart-3)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )
          )}
        </div>
      </section>

      {/* ── 渠道横评 Top5 ─────────────────────────────── */}
      <section aria-label="渠道横评" className="panel p-4">
        <SectionHeading title="渠道横评 Top5" description="按累计调用量排序，条形长度为成功率" />
        <div className="mt-3.5">
          {topChannels.length === 0 ? (
            <EmptyState
              compact
              icon={Trophy}
              title="还没有调用记录"
              description="发起调用后，这里会按累计调用量排出使用最多的 5 个渠道及其成功率。"
            />
          ) : (
            <ol className="flex flex-col gap-1.5">
              {topChannels.map((c, i) => {
                const s = c.stats!
                const rate = Math.round((s.ok / s.calls) * 100)
                return (
                  <li key={c.id} className="flex items-center gap-2.5 sm:gap-3">
                    <span
                      className={cn(
                        'tabular inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-micro font-semibold',
                        i === 0 ? 'bg-status-warn/15 text-status-warn' : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="w-24 min-w-0 truncate text-caption font-medium sm:w-32" title={c.name}>
                      {c.name}
                    </span>
                    <RatioBar
                      value={rate}
                      kind={rate >= 95 ? 'ok' : rate >= 80 ? 'warn' : 'danger'}
                      className="min-w-0 flex-1"
                    />
                    <span className="tabular w-24 shrink-0 text-right text-micro text-muted-foreground sm:w-32">
                      {s.calls.toLocaleString()} 次 · {fmtLatency(s.avgLatencyMs)}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </section>

      {/* ── 渠道实时状态 ─────────────────────────────── */}
      <section aria-label="渠道实时状态" className="panel p-4">
        <SectionHeading
          title="渠道实时状态"
          description="每个渠道的探测结果与今日用量"
          action={
            <Button size="sm" variant="outline" onClick={() => probeAll.mutate()} disabled={probeAll.isPending}>
              {probeAll.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              全部检测
            </Button>
          }
        />
        <div className="mt-3.5">
          {isLoading ? (
            <SkeletonCards count={3} />
          ) : channels.length === 0 ? (
            <EmptyState
              compact
              icon={Store}
              title="还没有渠道"
              description="渠道是网关的上游。先到「渠道管理」接入你的公益站 API，这里就会显示每个渠道的健康状况。"
              action={
                <Button size="sm" asChild>
                  <a href="?tab=channels">去添加渠道</a>
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {channels.map((c) => {
                const st = channelStatus(c)
                const usage = stats?.channelUsage?.[c.name]
                return (
                  <div key={c.id} className="flex flex-col gap-2 rounded-lg border border-hairline p-3 transition-colors hover:bg-muted/40">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-caption font-medium" title={c.name}>
                          {c.name}
                        </p>
                        <p className="mono-id truncate text-muted-foreground" title={c.baseUrl}>
                          {c.baseUrl}
                        </p>
                      </div>
                      <StatusChip kind={st.kind} title={st.hint} className="shrink-0">
                        {st.label}
                      </StatusChip>
                    </div>

                    <dl className="flex items-center justify-between gap-2 text-micro">
                      <div className="flex items-baseline gap-1">
                        <dt className="text-muted-foreground">延迟</dt>
                        <dd>
                          <LatencyReadout ms={c.latencyMs} showUnit={false} />
                        </dd>
                      </div>
                      <div className="min-w-0 truncate text-right text-muted-foreground">
                        <dt className="sr-only">最近探测</dt>
                        <dd className="truncate">{fmtTime(c.lastCheckAt)}</dd>
                      </div>
                    </dl>

                    {usage && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="h-5 px-1.5 text-micro">
                          24h <span className="tabular">{usage.calls}</span> 次
                        </Badge>
                        {usage.fails > 0 && (
                          <Badge variant="outline" className="h-5 border-status-danger/40 bg-status-danger-soft px-1.5 text-micro text-status-danger">
                            失败 <span className="tabular">{usage.fails}</span>
                          </Badge>
                        )}
                        {usage.avgLatencyMs != null && (
                          <span className="tabular text-micro text-muted-foreground">
                            均 {Math.round(usage.avgLatencyMs)}ms
                          </span>
                        )}
                      </div>
                    )}

                    {c.lastError && (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="truncate text-micro text-status-danger">
                              <span aria-hidden="true">⚠ </span>
                              {c.lastError}
                            </p>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs break-all">
                            <p className="text-caption">{c.lastError}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}

                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-auto min-h-8 w-full"
                      onClick={() => probeOne.mutate(c.id)}
                      disabled={probeOne.isPending}
                    >
                      {probeOne.isPending && probeOne.variables === c.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <RefreshCw className="h-3 w-3" />检测
                        </>
                      )}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {/* ── 探测日志 ─────────────────────────────────── */}
      <section aria-label="最近探测记录" className="panel p-4">
        <SectionHeading title="最近探测记录" description="定时任务对每个渠道的健康检查" />
        <div className="mt-3.5">
          {logs.length === 0 ? (
            <EmptyState
              compact
              icon={ScrollText}
              title="暂无探测记录"
              description="网关会定时探测所有启用渠道。点上方「全部检测」可立即触发一次。"
            />
          ) : (
            <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto pr-1">
              {logs.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center gap-2.5 rounded-lg border border-hairline px-2.5 py-2 text-caption"
                >
                  <StatusDot kind={l.ok ? 'ok' : 'danger'} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate font-medium">{l.channelName}</span>
                      <span
                        className={cn(
                          'shrink-0 text-micro font-medium',
                          l.ok ? 'text-status-ok' : 'text-status-danger'
                        )}
                      >
                        {l.ok ? '成功' : '失败'}
                      </span>
                    </span>
                    {(l.statusCode || l.error) && (
                      <span
                        className={cn(
                          'block truncate text-micro',
                          l.ok ? 'text-muted-foreground' : 'text-status-danger/85'
                        )}
                        title={l.error ?? undefined}
                      >
                        {l.statusCode ? `HTTP ${l.statusCode}` : ''} {l.error || ''}
                      </span>
                    )}
                  </span>
                  <LatencyReadout ms={l.latencyMs} className="shrink-0 text-caption" />
                  <span className="tabular shrink-0 text-micro text-muted-foreground">{fmtTime(l.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
