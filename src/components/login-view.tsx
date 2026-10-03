'use client'

import { useEffect, useState } from 'react'
import { KeyRound, Loader2, ShieldCheck, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginView({ onAuth }: { onAuth: () => void }) {
  const [initialized, setInitialized] = useState<boolean | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d) => setInitialized(Boolean(d.initialized)))
      .catch(() => setInitialized(false))
  }, [])

  const submit = async () => {
    setError('')
    if (initialized === false) {
      if (!setupToken.trim()) return setError('请输入一次性设置令牌（在服务器 db/setup-token.txt 或启动日志中）')
      if (username.trim().length < 2) return setError('用户名至少 2 位')
      if (password.length < 4) return setError('管理密码至少 4 位')
      if (password !== confirm) return setError('两次输入的密码不一致')
    } else if (!username.trim() || !password) {
      return setError('请输入用户名和密码')
    }
    setLoading(true)
    try {
      const res = await fetch(initialized === false ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          initialized === false
            ? { username: username.trim(), password, setupToken: setupToken.trim() }
            : { username: username.trim(), password }
        ),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '操作失败')
      onAuth()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  const isSetup = initialized === false

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-emerald-50 via-white to-zinc-50 dark:from-zinc-900 dark:via-zinc-800 dark:to-zinc-900">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">API Hub · 个人网关</CardTitle>
          <CardDescription>
            {isSetup ? '首次使用，请设置管理员账号' : '输入用户名和密码进入控制台'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isSetup && (
            <div className="space-y-2">
              <Label htmlFor="setupToken">一次性设置令牌</Label>
              <Input
                id="setupToken"
                type="text"
                placeholder="服务器 db/setup-token.txt 或启动日志中"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">首次设置需粘贴本机令牌，仅创建管理员时使用一次。</p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              type="text"
              autoComplete="username"
              placeholder={isSetup ? '设置用户名（2-32 位）' : '用户名'}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              autoFocus={!isSetup}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              placeholder={isSetup ? '设置密码（至少 4 位）' : '输入密码'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
          {isSetup && (
            <div className="space-y-2">
              <Label htmlFor="confirm">确认密码</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                placeholder="再次输入密码"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button className="w-full" onClick={submit} disabled={loading || initialized === null}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isSetup ? (
              <UserRound className="h-4 w-4" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {isSetup ? '设置并进入' : '登录'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
