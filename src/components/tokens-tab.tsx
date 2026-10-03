'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Gauge, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { EmptyState, SkeletonRows } from '@/components/feedback'
import { KeyValue, StatusDot } from '@/components/metrics'
import { ResponsiveList } from '@/components/responsive-list'
import { api, fmtTime, fmtTokens } from '@/lib/api-client'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import type { ApiTokenItem } from '@/types'

/** 用量进度条（limit=null 显示「不限」） */
function QuotaCell({ t }: { t: ApiTokenItem }) {
  if (t.quotaLimit === null) {
    return (
      <div className="text-xs text-muted-foreground">
        <p>{t.quotaUsed} 次调用</p>
        <p>不限量</p>
      </div>
    )
  }
  const pct = Math.min(100, Math.round((t.quotaUsed / t.quotaLimit) * 100))
  const exhausted = t.quotaUsed >= t.quotaLimit
  return (
    <div className="w-24 text-xs">
      <p className={'mb-1 ' + (exhausted ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
        {t.quotaUsed} / {t.quotaLimit}{exhausted ? ' 已用尽' : ''}
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={'h-full rounded-full ' + (exhausted ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function TokensTab() {
  const qc = useQueryClient()
  const { data: tokens = [], isLoading } = useQuery<ApiTokenItem[]>({
    queryKey: ['tokens'],
    queryFn: () => api('/api/tokens'),
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  // 配额编辑
  const [quotaOpen, setQuotaOpen] = useState<ApiTokenItem | null>(null)
  const [quotaInput, setQuotaInput] = useState('')

  const create = useMutation({
    mutationFn: () => api<{ key: string }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name, quotaLimit: quotaInput.trim() === '' ? null : Number(quotaInput) }) }),
    onSuccess: (d) => {
      toast.success('密钥已生成')
      setNewKey(d.key)
      qc.invalidateQueries({ queryKey: ['tokens'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('密钥已删除'); setDeleteId(null); qc.invalidateQueries({ queryKey: ['tokens'] }) },
    onError: (e) => toast.error(e.message),
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/tokens/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
    onError: (e) => toast.error(e.message),
  })

  const saveQuota = useMutation({
    mutationFn: ({ id, quotaLimit, quotaReset }: { id: string; quotaLimit: number | null; quotaReset?: boolean }) =>
      api(`/api/tokens/${id}`, { method: 'PUT', body: JSON.stringify({ quotaLimit, quotaReset }) }),
    onSuccess: () => {
      toast.success('配额已更新')
      setQuotaOpen(null)
      qc.invalidateQueries({ queryKey: ['tokens'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const copy = async (text: string, label: string) => {
    const ok = await copyToClipboard(text)
    if (ok) toast.success(`${label}已复制`)
    else toast.error('复制失败，请手动复制')
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  /** CC Switch Deep Link（V1 协议）：打开后 CC Switch 弹出导入供应商确认 */
  const ccSwitchLink = (key: string, name: string) => {
    const p = new URLSearchParams({
      resource: 'provider',
      app: 'codex',
      name: `API Hub · ${name}`,
      endpoint: `${origin}/v1`,
      apiKey: key,
      notes: 'OpenAI 兼容个人网关（API Hub）',
    })
    return `ccswitch://v1/import?${p.toString()}`
  }

  /** 连接信息格式：可直接发给使用者的完整接入说明 */
  const connInfo = (key: string, name: string) => [
    '【API Hub · 个人网关】',
    `密钥名称：${name}`,
    `接口地址：${origin}/v1`,
    `API Key：${key}`,
    '',
    '查看模型列表：',
    `curl ${origin}/v1/models -H "Authorization: Bearer ${key}"`,
    '',
    '调用示例（OpenAI 兼容）：',
    `curl ${origin}/v1/chat/completions \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model": "<模型名>", "messages": [{"role": "user", "content": "你好"}]}'`,
  ].join('\n')

  /** 复制下拉按钮（三格式） */
  const CopyMenu = ({ k, name }: { k: string; name: string }) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" title="复制"><Copy className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>一键复制</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => copy(k, 'API Key')}>仅 API Key</DropdownMenuItem>
        <DropdownMenuItem onClick={() => copy(ccSwitchLink(k, name), 'CC Switch 导入链接')}>CC Switch 格式（一键导入）</DropdownMenuItem>
        <DropdownMenuItem onClick={() => copy(connInfo(k, name), '连接信息')}>连接信息格式（地址+Key+示例）</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <CardTitle className="text-base">
            <span className="hidden lg:inline">统一调用密钥</span>
            <span className="lg:hidden">共 </span>
            <span className="tabular text-caption font-normal text-muted-foreground">{tokens.length}</span>
            <span className="lg:hidden text-caption font-normal text-muted-foreground">个密钥</span>
          </CardTitle>
          <Button size="sm" onClick={() => { setNewKey(null); setCreateOpen(true) }} className="shrink-0">
            <Plus className="h-4 w-4" />生成密钥
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <SkeletonRows rows={3} />
          ) : tokens.length === 0 ? (
            <EmptyState
              compact
              icon={KeyRound}
              title="还没有统一调用密钥"
              description="生成一个 Key，客户端就能用它访问网关转发的所有模型，无需再关心上游渠道的 Key。"
              action={
                <Button size="sm" onClick={() => { setNewKey(null); setCreateOpen(true) }}>
                  <Plus className="h-4 w-4" />生成第一个密钥
                </Button>
              }
            />
          ) : (
            <div className="max-h-[32rem] overflow-y-auto pr-1">
              <ResponsiveList
                keyOf={(t) => (t._raw as ApiTokenItem).id}
                className="space-y-1.5"
                columns={[
                  { key: 'name', header: '名称' },
                  { key: 'key', header: '密钥' },
                  { key: 'usage', header: '用量' },
                  { key: 'lastUsed', header: '最后使用', className: 'hidden md:table-cell' },
                  { key: 'enabled', header: '启用', className: 'w-20' },
                  { key: 'actions', header: '操作', align: 'right', className: 'w-28' },
                ]}
                items={tokens.map((t) => {
                  const hasLimit = t.quotaLimit !== null
                  const pct = hasLimit ? Math.min(100, Math.round((t.quotaUsed / t.quotaLimit!) * 100)) : null
                  return {
                    title: t.name,
                    subtitle: <span className="mono-id">{t.key}</span>,
                    badge: (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 text-caption font-medium',
                          t.enabled ? 'text-status-ok' : 'text-status-idle'
                        )}
                      >
                        <StatusDot kind={t.enabled ? 'ok' : 'idle'} />
                        {t.enabled ? '启用' : '停用'}
                      </span>
                    ),
                    metrics: [
                      {
                        label: '已用配额',
                        value:
                          pct == null ? (
                            <span className="text-muted-foreground">不限量</span>
                          ) : (
                            <span className="tabular">
                              {t.quotaUsed} / {t.quotaLimit}
                            </span>
                          ),
                      },
                      {
                        label: '调用次数',
                        value: <span className="tabular">{(t.usage?.calls ?? 0).toLocaleString()}</span>,
                      },
                      {
                        label: '消耗 Token',
                        value:
                          t.usage && t.usage.tokens > 0 ? (
                            fmtTokens(t.usage.tokens)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          ),
                      },
                      {
                        label: '最后使用',
                        value: <span className="tabular text-caption">{fmtTime(t.lastUsedAt)}</span>,
                      },
                    ],
                    detail: (
                      <div className="flex flex-col gap-1.5">
                        <KeyValue label="完整密钥" mono>
                          {t.key}
                        </KeyValue>
                        <KeyValue label="创建时间">{fmtTime(t.createdAt)}</KeyValue>
                        {t.usage?.lastCallAt && <KeyValue label="最近调用">{fmtTime(t.usage.lastCallAt)}</KeyValue>}
                      </div>
                    ),
                    actions: (
                      <>
                        <CopyMenu k={t.key} name={t.name} />
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-9"
                          title="用量配额"
                          onClick={() => {
                            setQuotaOpen(t)
                            setQuotaInput(t.quotaLimit === null ? '' : String(t.quotaLimit))
                          }}
                        >
                          <Gauge className="h-3.5 w-3.5" />
                          配额
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-9 text-status-danger"
                          title="删除密钥"
                          onClick={() => setDeleteId(t.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </>
                    ),
                    _raw: t,
                  }
                })}
                renderCell={(item, key) => {
                  const t = item._raw as ApiTokenItem
                  switch (key) {
                    case 'name':
                      return <span className="font-medium">{t.name}</span>
                    case 'key':
                      return <code className="mono-id rounded bg-muted px-1.5 py-0.5">{t.key}</code>
                    case 'usage':
                      return (
                        <div>
                          <QuotaCell t={t} />
                          {t.usage && t.usage.calls > 0 ? (
                            <p className="mt-0.5 text-micro tabular text-muted-foreground">
                              {t.usage.calls} 次调用{t.usage.tokens > 0 ? ` · ${fmtTokens(t.usage.tokens)}` : ''}
                            </p>
                          ) : (
                            <p className="mt-0.5 text-micro text-muted-foreground">未调用</p>
                          )}
                        </div>
                      )
                    case 'lastUsed':
                      return <span className="tabular text-micro text-muted-foreground">{fmtTime(t.lastUsedAt)}</span>
                    case 'enabled':
                      return (
                        <Switch
                          checked={t.enabled}
                          onCheckedChange={(v) => toggle.mutate({ id: t.id, enabled: v })}
                          aria-label={`${t.name} 启用开关`}
                        />
                      )
                    case 'actions':
                      return (
                        <div className="flex items-center justify-end gap-0.5">
                          <CopyMenu k={t.key} name={t.name} />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            title="用量配额"
                            onClick={() => {
                              setQuotaOpen(t)
                              setQuotaInput(t.quotaLimit === null ? '' : String(t.quotaLimit))
                            }}
                          >
                            <Gauge className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-status-danger"
                            title="删除密钥"
                            onClick={() => setDeleteId(t.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )
                    default:
                      return null
                  }
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* 生成密钥 */}
      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v)
          if (!v) {
            setNewKey(null)
            setName('')
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          {newKey ? (
            <>
              <DialogHeader>
                <DialogTitle>密钥已生成</DialogTitle>
                <DialogDescription>完整密钥仅此一次展示，请立即复制保存。</DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-3">
                <code className="flex-1 break-all text-xs">{newKey}</code>
                <Button size="sm" variant="outline" onClick={() => copy(newKey, '密钥')}><Copy className="h-3 w-3" /></Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="outline" onClick={() => copy(ccSwitchLink(newKey, name || '默认密钥'), 'CC Switch 导入链接')}>
                  复制 CC Switch 格式
                </Button>
                <Button size="sm" variant="outline" onClick={() => copy(connInfo(newKey, name || '默认密钥'), '连接信息')}>
                  复制连接信息
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                CC Switch 格式：粘贴到浏览器地址栏回车，或粘贴进 CC Switch 的「Deep Link 导入」，即可一键添加本网关为供应商（OpenAI 兼容 / Codex）。
              </p>
              <DialogFooter>
                <Button onClick={() => setCreateOpen(false)}>我已保存，关闭</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>生成统一调用密钥</DialogTitle>
                <DialogDescription>客户端用这个 Key 调用本网关，无需再保存各公益站的 Key。</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label>密钥名称 *</Label>
                <Input placeholder="例如：我的 Mac / ChatBox 客户端" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label>请求次数上限（选填）</Label>
                <Input
                  type="number" min={1} placeholder="留空 = 不限量"
                  value={quotaInput} onChange={(e) => setQuotaInput(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">设置后超过上限的请求将被拒绝（429），随时可在列表中调整或清零用量。</p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
                <Button onClick={() => name.trim() ? create.mutate() : toast.error('请填写名称')} disabled={create.isPending}>
                  {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  生成
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 配额编辑 */}
      <Dialog open={quotaOpen !== null} onOpenChange={(v) => !v && setQuotaOpen(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>用量配额 · {quotaOpen?.name}</DialogTitle>
            <DialogDescription>
              已用 {quotaOpen?.quotaUsed ?? 0} 次。设为 0 次上限相当于立即停用；清零用量不会中断正在进行的调用。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>请求次数上限</Label>
            <Input
              type="number" min={0} placeholder="留空 = 不限量"
              value={quotaInput} onChange={(e) => setQuotaInput(e.target.value)}
            />
          </div>
          <DialogFooter className="flex gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={() => quotaOpen && saveQuota.mutate({ id: quotaOpen.id, quotaLimit: quotaOpen.quotaLimit, quotaReset: true })}
            >
              用量清零
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setQuotaOpen(null)}>取消</Button>
              <Button
                onClick={() => {
                  if (!quotaOpen) return
                  const limit = quotaInput.trim() === '' ? null : Math.max(0, Math.floor(Number(quotaInput)))
                  saveQuota.mutate({ id: quotaOpen.id, quotaLimit: limit })
                }}
                disabled={saveQuota.isPending}
              >
                保存
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deleteId !== null} onOpenChange={(v) => !v && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该密钥？</AlertDialogTitle>
            <AlertDialogDescription>使用此密钥的客户端将立即无法调用网关。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => deleteId && remove.mutate(deleteId)}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
