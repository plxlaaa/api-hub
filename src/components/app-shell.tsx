'use client'

import * as React from 'react'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  BookOpen,
  Bot,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Network,
  Route,
  ScrollText,
  Store,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { StatusDot } from '@/components/metrics'
import { LoginView } from '@/components/login-view'
import { DashboardTab } from '@/components/dashboard-tab'
import { ChatTab } from '@/components/chat-tab'
import { ChannelsTab } from '@/components/channels-tab'
import { RoutesTab } from '@/components/routes-tab'
import { RequestLogsTab } from '@/components/request-logs-tab'
import { TokensTab } from '@/components/tokens-tab'
import { UsageTab } from '@/components/usage-tab'
import { ThemeToggle } from '@/components/theme-toggle'
import { cn } from '@/lib/utils'

interface Overview {
  stats: {
    today: { calls: number; fails: number }
    totalCalls: number
    channelsOnline: number
    channelsDown: number
  }
}

type NavItem = {
  value: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  /** 底部栏只放最常用的 4 个，其余进「更多」 */
  primary?: boolean
  hint: string
}

const NAV: NavItem[] = [
  { value: 'dashboard', label: '仪表盘', icon: LayoutDashboard, primary: true, hint: '渠道健康与用量总览' },
  { value: 'channels', label: '渠道管理', icon: Store, primary: true, hint: '增删改上游公益站与 Key' },
  { value: 'routes', label: '模型路由', icon: Route, primary: true, hint: '模型映射与负载策略' },
  { value: 'logs', label: '调用日志', icon: ScrollText, primary: true, hint: '逐次调用的成败与延迟' },
  { value: 'chat', label: '对话测试', icon: Bot, hint: '真实请求验证渠道可用性' },
  { value: 'tokens', label: 'API 密钥', icon: KeyRound, hint: '网关统一调用密钥与配额' },
  { value: 'usage', label: '调用示例', icon: BookOpen, hint: '在各客户端接入网关' },
]

const ALL_VALUES = NAV.map((n) => n.value)

/** 读取并校验 ?tab=，非法值回落到仪表盘 */
function useTabParam(): [string, (v: string) => void] {
  const router = useRouter()
  const params = useSearchParams()
  const raw = params.get('tab')
  const current = raw && ALL_VALUES.includes(raw) ? raw : 'dashboard'
  const set = React.useCallback(
    (v: string) => {
      router.replace(v === 'dashboard' ? '/' : `/?tab=${v}`, { scroll: false })
    },
    [router]
  )
  return [current, set]
}

/** 全局健康指示：吸顶头部常驻，运维一眼看到「系统现在好不好」 */
function HealthPill() {
  const { data } = useQuery<Overview>({
    queryKey: ['overview'],
    queryFn: async () => {
      const res = await fetch('/api/overview', { credentials: 'same-origin' })
      if (!res.ok) throw new Error('健康状态获取失败')
      return res.json()
    },
    refetchInterval: 15_000,
    retry: 1,
  })

  const online = data?.stats.channelsOnline ?? 0
  const down = data?.stats.channelsDown ?? 0
  const total = online + down

  if (data?.stats.channelsOnline == null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-micro text-muted-foreground">
        <StatusDot kind="idle" />
        <span className="hidden sm:inline">状态读取中</span>
      </span>
    )
  }

  const kind = down > 0 ? 'danger' : online > 0 ? 'ok' : 'idle'
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-micro font-medium"
      title={`在线 ${online} 个渠道${down > 0 ? `，${down} 个异常` : ''}`}
    >
      <StatusDot kind={kind} live={down === 0 && online > 0} />
      <span className="tabular">
        {online}
        <span className="text-muted-foreground">/{total}</span>
      </span>
      <span className="hidden text-muted-foreground sm:inline">在线</span>
      {down > 0 && (
        <span className="tabular text-status-danger">
          {down} 异常
        </span>
      )}
    </span>
  )
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
        <Network className="h-4 w-4 text-primary" />
      </div>
      {!compact && (
        <div className="min-w-0">
          <h1 className="truncate text-sm leading-tight font-semibold tracking-tight">API Hub</h1>
          <p className="hidden truncate text-micro leading-tight text-muted-foreground sm:block">
            公益站聚合 · 探测 · 路由
          </p>
        </div>
      )}
    </div>
  )
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const router = useRouter()
  const [tab, setTab] = useTabParam()
  const [moreOpen, setMoreOpen] = React.useState(false)
  const current = NAV.find((n) => n.value === tab) ?? NAV[0]
  const primaryNav = NAV.filter((n) => n.primary)
  const secondaryNav = NAV.filter((n) => !n.primary)

  // 切换 tab 时回到顶部，避免从长列表切过去还停在半空
  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [tab])

  const go = (v: string) => {
    setTab(v)
    setMoreOpen(false)
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {/* ── 吸顶头部：安全区 + 毛玻璃 ─────────────────── */}
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
        <div className="pt-safe" />
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <BrandMark />

          <div className="ml-auto flex items-center gap-1.5">
            <HealthPill />
            <ThemeToggle />
            <Button
              size="sm"
              variant="ghost"
              className="hidden sm:inline-flex"
              onClick={() => router.push('/square')}
              title="浏览可用模型"
            >
              <Store className="h-4 w-4" />
              模型广场
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="hidden h-9 w-9 sm:inline-flex"
              onClick={onLogout}
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut className="h-4 w-4" />
            </Button>

            {/* 窄屏：更多操作收进抽屉 */}
            <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
              <SheetTrigger asChild>
                <Button size="icon" variant="ghost" className="touch-target-icon h-9 w-9 sm:hidden" aria-label="更多操作">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="rounded-t-xl pb-safe">
                <SheetHeader className="text-left">
                  <SheetTitle>更多</SheetTitle>
                  <SheetDescription className="sr-only">次级功能与账户操作</SheetDescription>
                </SheetHeader>
                <div className="flex flex-col gap-1.5 pb-2">
                  {secondaryNav.map((n) => (
                    <button
                      key={n.value}
                      type="button"
                      onClick={() => go(n.value)}
                      className={cn(
                        'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                        tab === n.value ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                      )}
                    >
                      <n.icon className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{n.label}</span>
                        <span className="block truncate text-micro text-muted-foreground">{n.hint}</span>
                      </span>
                    </button>
                  ))}
                  <div className="my-1 h-px bg-border" />
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      router.push('/square')
                    }}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <Store className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">模型广场</span>
                      <span className="block truncate text-micro text-muted-foreground">浏览全部可用模型</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={onLogout}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-status-danger hover:bg-danger-soft"
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    <span className="font-medium">退出登录</span>
                  </button>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>

        {/* ── 桌面导航：带文字的完整标签 ─────────────── */}
        <nav className="mx-auto hidden h-10 max-w-7xl items-center gap-0.5 px-3 lg:flex" aria-label="主导航">
          {NAV.map((n) => (
            <button
              key={n.value}
              type="button"
              onClick={() => go(n.value)}
              aria-current={tab === n.value ? 'page' : undefined}
              className={cn(
                'relative flex h-8 items-center gap-1.5 rounded-md px-2.5 text-caption font-medium whitespace-nowrap',
                tab === n.value ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <n.icon className="h-3.5 w-3.5" />
              {n.label}
              {tab === n.value && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
            </button>
          ))}
        </nav>
      </header>

      {/* ── 主内容 ───────────────────────────────────── */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-4 pb-24 lg:pb-8">
        {/* 窄屏：当前区块的标题 + 说明（桌面在导航里已有，这里补上下文） */}
        <div className="mb-3 lg:hidden">
          <h2 className="text-base font-semibold tracking-tight">{current.label}</h2>
          <p className="text-caption text-muted-foreground">{current.hint}</p>
        </div>
        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'channels' && <ChannelsTab />}
        {tab === 'routes' && <RoutesTab />}
        {tab === 'logs' && <RequestLogsTab />}
        {tab === 'chat' && <ChatTab />}
        {tab === 'tokens' && <TokensTab />}
        {tab === 'usage' && <UsageTab />}
      </main>

      {/* ── 窄屏：吸底 Tab 栏（拇指可达区） ───────────── */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur-md supports-[backdrop-filter]:bg-background/85 lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        aria-label="主导航"
      >
        <div className="mx-auto grid max-w-lg grid-cols-5">
          {primaryNav.map((n) => (
            <button
              key={n.value}
              type="button"
              onClick={() => go(n.value)}
              aria-current={tab === n.value ? 'page' : undefined}
              className={cn(
                'flex min-h-14 flex-col items-center justify-center gap-0.5 text-micro font-medium',
                tab === n.value ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <n.icon className={cn('h-4.5 w-4.5', tab === n.value && 'drop-shadow-sm')} />
              {n.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className={cn(
              'flex min-h-14 flex-col items-center justify-center gap-0.5 text-micro font-medium',
              secondaryNav.some((n) => n.value === tab) ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <MoreHorizontal className="h-4.5 w-4.5" />
            更多
          </button>
        </div>
      </nav>

      <footer className="hidden border-t py-4 lg:block">
        <p className="text-center text-micro text-muted-foreground">
          API Hub — 把分散的公益站 API 聚合成一个地址、一个 Key
        </p>
      </footer>
    </div>
  )
}

export { Shell }

/* ── 登录态探测：骨架而非「加载中…」三个字 ─────────────── */
function AppSkeleton() {
  return (
    <div className="min-h-dvh" role="status" aria-busy="true" aria-label="正在加载控制台">
      <div className="border-b">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <div className="skeleton-sheen h-8 w-8 rounded-lg" />
          <div className="skeleton-sheen h-3.5 w-24 rounded" />
        </div>
      </div>
      <div className="mx-auto max-w-7xl space-y-3 px-4 py-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="panel space-y-2 p-3.5">
              <div className="skeleton-sheen h-2.5 w-16 rounded" />
              <div className="skeleton-sheen h-7 w-24 rounded" />
            </div>
          ))}
        </div>
        <div className="panel space-y-2 p-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="skeleton-sheen h-7 w-7 rounded-md" />
              <div className="skeleton-sheen h-3 flex-1" style={{ maxWidth: `${90 - i * 11}%` }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
    setAuthed(false)
  }, [])

  const handleAuth = useCallback(() => setAuthed(true), [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
        if (!cancelled) setAuthed(res.ok)
      } catch {
        if (!cancelled) setAuthed(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Suspense fallback={<AppSkeleton />}>
      {authed === null ? (
        <AppSkeleton />
      ) : authed ? (
        <Shell onLogout={handleLogout} />
      ) : (
        <LoginView onAuth={handleAuth} />
      )}
    </Suspense>
  )
}
