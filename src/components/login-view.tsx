'use client'

import { useEffect, useState } from 'react'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginView({ onAuth }: { onAuth: (token: string) => void }) {
  const [initialized, setInitialized] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
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
      if (password.length < 4) return setError('管理密码至少 4 位')
      if (password !== confirm) return setError('两次输入的密码不一致')
    } else if (!password) {
      return setError('请输入管理密码')
    }
    setLoading(true)
    try {
      const res = await fetch(initialized === false ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '操作失败')
      onAuth(data.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-emerald-50 via-white to-zinc-50 dark:from-zinc-900 dark:via-zinc-800 dark:to-zinc-900">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">API Hub · 个人网关</CardTitle>
          <CardDescription>
            {initialized === false ? '首次使用，请设置管理密码' : '输入管理密码进入控制台'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">管理密码</Label>
            <Input
              id="password"
              type="password"
              placeholder={initialized === false ? '设置密码（至少 4 位）' : '输入密码'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              autoFocus
            />
          </div>
          {initialized === false && (
            <div className="space-y-2">
              <Label htmlFor="confirm">确认密码</Label>
              <Input
                id="confirm"
                type="password"
                placeholder="再次输入密码"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button className="w-full" onClick={submit} disabled={loading || initialized === null}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            {initialized === false ? '设置并进入' : '登录'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
