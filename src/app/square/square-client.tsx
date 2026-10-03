'use client'

import { useEffect, useState } from 'react'
import { useQuery, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Activity, ArrowLeft, Coins, Cpu, RefreshCw, Server, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface SquareChannel {
  name: string
  status: string
  latencyMs: number | null
  lastCheckAt: string | null
}

interface SquareModel {
  name: string
  description: string | null
  priceIn: number | null
  priceOut: number | null
  strategy: string
  channels: SquareChannel[]
  onlineCount: number
  channelCount: number
  updatedAt: string
}

interface SquareData {
  models: SquareModel[]
  stats: { modelCount: number; channelTotal: number; channelOnline: number }
  generatedAt: string
}

const STRATEGY_BADGE: Record<string, { label: string; cls: string }> = {
  priority: { label: '优先级路由', cls: 'border-emerald-300 text-emerald-600' },
  weighted: { label: '权重分流', cls: 'border-amber-300 text-amber-600' },
  speed: { label: '⚡ 速度优先', cls: 'border-sky-300 text-sky-600' },
  quality: { label: '🧠 智商优先', cls: 'border-violet-300 text-violet-600' },
  stability: { label: '🛡️ 稳定优先', cls: 'border-blue-300 text-blue-600' },
}

function fmtPrice(p: number | null): string {
  if (p == null) return '未标注'
  if (p === 0) return '免费'
  return `$${p}`
}

function fmtAgo(iso: string | null): string {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        status === 'online' ? 'bg-emerald-500 animate-pulse' : status === 'offline' ? 'bg-red-500' : 'bg-muted-foreground/40'
      )}
    />
  )
}

export function SquareClient() {
  const [qc] = useState(() => new QueryClient())
  return (
    <QueryClientProvider client={qc}>
      <SquareInner />
    </QueryClientProvider>
  )
}

function SquareInner() {
  const [now, setNow] = useState(() => Date.now())
  const { data, isLoading, refetch, isFetching } = useQuery<SquareData>({
    queryKey: ['square'],
    queryFn: () => fetch('/api/public/square').then((r) => r.json()),
    refetchInterval: 30_000,
  })

  // 心跳时间显示
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => { void now }, [now])

  const stats = data?.stats

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* 顶部 */}
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">模型广场</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              聚合多个上游渠道 · 自动故障转移 · 统一 OpenAI 兼容接口
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => (window.location.href = '/')}>
            <ArrowLeft className="h-4 w-4" /> 管理台
          </Button>
        </header>

        {/* 统计栏 */}
        <div className="mb-8 grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="rounded-lg bg-primary/10 p-2"><Cpu className="h-5 w-5 text-primary" /></div>
              <div>
                <p className="text-2xl font-bold leading-none">{stats?.modelCount ?? '–'}</p>
                <p className="mt-1 text-xs text-muted-foreground">可用模型</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="rounded-lg bg-emerald-500/10 p-2"><Server className="h-5 w-5 text-emerald-600" /></div>
              <div>
                <p className="text-2xl font-bold leading-none">
                  {stats ? `${stats.channelOnline}/${stats.channelTotal}` : '–'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">渠道在线</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center justify-between py-4">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-sky-500/10 p-2"><Activity className="h-5 w-5 text-sky-600" /></div>
                <div>
                  <p className="text-2xl font-bold leading-none">{data ? fmtAgo(data.generatedAt) : '–'}</p>
                  <p className="mt-1 text-xs text-muted-foreground">状态更新</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => refetch()} aria-label="刷新">
                <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* 模型卡片 */}
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse"><CardContent className="h-44" /></Card>
            ))}
          </div>
        ) : !data || data.models.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-muted-foreground">
              暂无可用模型，请到管理台添加路由
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {data.models.map((m) => {
              const st = STRATEGY_BADGE[m.strategy] ?? STRATEGY_BADGE.priority
              const allOnline = m.channelCount > 0 && m.onlineCount === m.channelCount
              return (
                <Card key={m.name} className="transition-shadow hover:shadow-md">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="font-mono text-lg">{m.name}</CardTitle>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={cn('text-xs font-normal', st.cls)}>{st.label}</Badge>
                      </div>
                    </div>
                    {m.description && <p className="text-sm text-muted-foreground">{m.description}</p>}
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* 价格 */}
                    <div className="flex items-center gap-4 text-sm">
                      <span className="flex items-center gap-1.5">
                        <Coins className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">输入</span>
                        <span className={cn('font-semibold', m.priceIn === 0 ? 'text-emerald-600' : '')}>{fmtPrice(m.priceIn)}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">输出</span>
                        <span className={cn('font-semibold', m.priceOut === 0 ? 'text-emerald-600' : '')}>{fmtPrice(m.priceOut)}</span>
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">/ 百万 token</span>
                    </div>
                    {/* 渠道状态 */}
                    <div className="rounded-md border bg-muted/30 p-2.5">
                      <p className="mb-1.5 flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Zap className="h-3 w-3" /> 渠道
                        </span>
                        <span className={cn('font-medium', allOnline ? 'text-emerald-600' : m.onlineCount === 0 ? 'text-red-500' : 'text-amber-600')}>
                          {m.onlineCount}/{m.channelCount} 在线
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {m.channels.length === 0 && <span className="text-xs text-muted-foreground">未配置渠道</span>}
                        {m.channels.map((c) => (
                          <span key={c.name} className="flex items-center gap-1.5 text-xs">
                            <StatusDot status={c.status} />
                            {c.name}
                            {c.latencyMs != null && c.status === 'online' && (
                              <span className="text-muted-foreground">{c.latencyMs}ms</span>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                    <p className="text-right text-xs text-muted-foreground">路由更新于 {fmtAgo(m.updatedAt)}</p>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}

        <footer className="mt-10 text-center text-xs text-muted-foreground">
          调用方式：OpenAI 兼容接口 · 模型名填上方显示名 · 数据每 30 秒自动刷新
        </footer>
      </div>
    </div>
  )
}
