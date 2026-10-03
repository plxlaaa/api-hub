'use client'

import { useCallback, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BookOpen, Bot, KeyRound, LayoutDashboard, LogOut, Network, Route, ScrollText, Store } from 'lucide-react'
import { Toaster } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoginView } from '@/components/login-view'
import { DashboardTab } from '@/components/dashboard-tab'
import { ChatTab } from '@/components/chat-tab'
import { ChannelsTab } from '@/components/channels-tab'
import { RoutesTab } from '@/components/routes-tab'
import { RequestLogsTab } from '@/components/request-logs-tab'
import { TokensTab } from '@/components/tokens-tab'
import { UsageTab } from '@/components/usage-tab'
import { ThemeToggle } from '@/components/theme-toggle'
import { getStoredToken, setAuthToken } from '@/lib/api-client'

function Shell({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/65">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Network className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">API Hub · 个人网关</h1>
              <p className="text-xs text-muted-foreground leading-tight">公益站聚合 · 探测 · 路由 · 统一调用</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button size="sm" variant="ghost" onClick={() => (window.location.href = '/square')}>
              <Store className="h-4 w-4" />模型广场
            </Button>
            <Button size="sm" variant="ghost" onClick={onLogout}>
              <LogOut className="h-4 w-4" />退出
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Tabs defaultValue="dashboard">
          <TabsList className="mb-4 flex h-auto max-w-full flex-nowrap gap-1 overflow-x-auto p-1 sm:flex-wrap sm:overflow-visible">
            <TabsTrigger value="dashboard" className="shrink-0"><LayoutDashboard className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">仪表盘</span></TabsTrigger>
            <TabsTrigger value="chat" className="shrink-0"><Bot className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">对话测试</span></TabsTrigger>
            <TabsTrigger value="channels" className="shrink-0"><Store className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">渠道管理</span></TabsTrigger>
            <TabsTrigger value="routes" className="shrink-0"><Route className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">模型路由</span></TabsTrigger>
            <TabsTrigger value="logs" className="shrink-0"><ScrollText className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">调用日志</span></TabsTrigger>
            <TabsTrigger value="tokens" className="shrink-0"><KeyRound className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">API 密钥</span></TabsTrigger>
            <TabsTrigger value="usage" className="shrink-0"><BookOpen className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">调用示例</span></TabsTrigger>
          </TabsList>
          <TabsContent value="dashboard"><DashboardTab /></TabsContent>
          <TabsContent value="chat"><ChatTab /></TabsContent>
          <TabsContent value="channels"><ChannelsTab /></TabsContent>
          <TabsContent value="routes"><RoutesTab /></TabsContent>
          <TabsContent value="logs"><RequestLogsTab /></TabsContent>
          <TabsContent value="tokens"><TokensTab /></TabsContent>
          <TabsContent value="usage"><UsageTab /></TabsContent>
        </Tabs>
      </main>

      <footer className="mt-auto border-t py-4">
        <p className="text-center text-xs text-muted-foreground">
          API Hub — 把分散的公益站 API 聚合成一个地址、一个 Key
        </p>
      </footer>
    </div>
  )
}

export default function Home() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }))
  const [token, setToken] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    const finish = () => { if (!cancelled) setChecking(false) }
    ;(async () => {
      const stored = getStoredToken()
      if (!stored) {
        queueMicrotask(finish)
        return
      }
      try {
        const res = await fetch('/api/channels', { headers: { Authorization: `Bearer ${stored}` } })
        if (res.ok) { if (!cancelled) setToken(stored) } else setAuthToken(null)
      } catch {
        setAuthToken(null)
      } finally {
        finish()
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleAuth = useCallback((t: string) => {
    setAuthToken(t)
    setToken(t)
  }, [])

  const handleLogout = useCallback(() => {
    setAuthToken(null)
    setToken(null)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      {checking ? (
        <div className="min-h-screen flex items-center justify-center text-muted-foreground">加载中…</div>
      ) : token ? (
        <Shell onLogout={handleLogout} />
      ) : (
        <LoginView onAuth={handleAuth} />
      )}
      <Toaster position="top-center" richColors />
    </QueryClientProvider>
  )
}
