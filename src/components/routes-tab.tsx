'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Copy, FlaskConical, Loader2, Pencil, Plus, RefreshCw, Route, Trash2, X, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { EmptyState, SkeletonRows } from '@/components/feedback'
import { KeyValue } from '@/components/metrics'
import { ResponsiveList } from '@/components/responsive-list'
import {
  ChannelAvailBadge,
  RouteChannelBadges,
  RouteUsage,
  STRATEGY_META,
} from '@/components/route-badges'
import { api, fmtTime, fmtTokens } from '@/lib/api-client'
import type { Channel, ModelRoute, RouteChannelConfig, RouteStrategy } from '@/types'
import { cn } from '@/lib/utils'

interface RouteForm {
  id?: string
  displayName: string
  targetModel: string
  channelConfigs: RouteChannelConfig[]
  strategy: RouteStrategy
  priceIn: string
  priceOut: string
  remark: string
  enabled: boolean
}

const EMPTY_FORM: RouteForm = { displayName: '', targetModel: '', channelConfigs: [], strategy: 'priority', priceIn: '', priceOut: '', remark: '', enabled: true }


export function RoutesTab() {
  const qc = useQueryClient()
  const { data: routes = [], isLoading } = useQuery<ModelRoute[]>({
    queryKey: ['routes'],
    queryFn: () => api('/api/routes'),
  })
  const { data: channels = [] } = useQuery<Channel[]>({
    queryKey: ['channels'],
    queryFn: () => api('/api/channels'),
    refetchInterval: 8000,
  })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<RouteForm>(EMPTY_FORM)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  // 尝试顺序预览：策略/渠道/顺序变化时自动重算（防抖 400ms），与网关共用后端排序
  const [previewData, setPreviewData] = useState<{ ordered: Array<{ id: string; name: string; model: string | null; basis: string }>; unavailable: Array<{ id: string; name: string; reason: string }> } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewErr, setPreviewErr] = useState('')
  const [previewNonce, setPreviewNonce] = useState(0)
  useEffect(() => {
    if (!dialogOpen || form.channelConfigs.length === 0) return
    // 不在 effect 体内同步 setState：加载态由下面的 timeout 统一接管，
    // 避免级联渲染（react-hooks/set-state-in-effect）
    const t = setTimeout(async () => {
      setPreviewLoading(true)
      setPreviewErr('')
      try {
        const r = await api<typeof previewData>('/api/routes/preview', {
          method: 'POST',
          body: JSON.stringify({ strategy: form.strategy, channelConfigs: form.channelConfigs }),
        })
        setPreviewData(r)
      } catch (e) {
        setPreviewErr(e instanceof Error ? e.message : '预览失败')
      } finally {
        setPreviewLoading(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [dialogOpen, form.strategy, form.channelConfigs, previewNonce])

  const channelName = useMemo(() => new Map(channels.map((c) => [c.id, c.name])), [channels])
  /** Map → 查名函数，供徽章组件使用（缺失渠道显示「已删除」） */
  const nameOfChannel = (id: string) => channelName.get(id) ?? '(已删除)'
  const channelModels = useMemo(() => new Map(channels.map((c) => [c.id, c.models])), [channels])
  const allModels = useMemo(() => Array.from(new Set(channels.flatMap((c) => c.models))).sort(), [channels])

  const openCreate = () => { setForm(EMPTY_FORM); setPreviewData(null); setPreviewErr(''); setDialogOpen(true) }
  const openEdit = (r: ModelRoute) => {
    setForm({
      id: r.id,
      displayName: r.displayName,
      targetModel: r.targetModel,
      channelConfigs: r.channelConfigs.map((c) => ({ id: c.id, model: c.model || '', weight: c.weight ?? 1, quality: c.quality ?? 5 })),
      strategy: r.strategy,
      priceIn: r.priceIn == null ? '' : String(r.priceIn),
      priceOut: r.priceOut == null ? '' : String(r.priceOut),
      remark: r.remark || '',
      enabled: r.enabled,
    })
    setPreviewData(null)
    setPreviewErr('')
    setDialogOpen(true)
  }
  // 复制路由：预填内容，改显示名即可保存为新路由
  const openDuplicate = (r: ModelRoute) => {
    openEdit(r)
    setForm((f) => ({ ...f, id: undefined, displayName: `${f.displayName} 副本` }))
  }

  // 行内一键测试：走真实网关链路（管理测试模式，不消耗密钥配额），验证路由连通性
  const [testingId, setTestingId] = useState<string | null>(null)
  const testRoute = async (r: ModelRoute) => {
    setTestingId(r.id)
    const start = Date.now()
    try {
      const res = await api<{ choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } }>('/api/test-chat', {
        method: 'POST',
        body: JSON.stringify({ model: r.displayName, messages: [{ role: 'user', content: '回复「ok」两个字母即可' }], max_tokens: 20 }),
      })
      const ms = Date.now() - start
      const reply = res.choices?.[0]?.message?.content?.trim() || '（空回复）'
      toast.success(`「${r.displayName}」测试通过（${(ms / 1000).toFixed(1)}s${res.usage?.total_tokens ? ` · ${res.usage.total_tokens} tok` : ''}）`, { description: reply.slice(0, 80) })
    } catch (e) {
      toast.error(`「${r.displayName}」测试失败`, { description: e instanceof Error ? e.message.slice(0, 120) : '未知错误' })
    } finally {
      setTestingId(null)
    }
  }

  const toggleChannel = (id: string) => {
    setForm((f) => ({
      ...f,
      channelConfigs: f.channelConfigs.some((c) => c.id === id)
        ? f.channelConfigs.filter((c) => c.id !== id)
        : [...f.channelConfigs, { id, model: '', weight: 1, quality: 5 }],
    }))
  }
  const move = (index: number, dir: -1 | 1) => {
    setForm((f) => {
      const next = [...f.channelConfigs]
      const target = index + dir
      if (target < 0 || target >= next.length) return f
      ;[next[index], next[target]] = [next[target], next[index]]
      return { ...f, channelConfigs: next }
    })
  }
  const updateCfg = (id: string, patch: Partial<RouteChannelConfig>) => {
    setForm((f) => ({
      ...f,
      channelConfigs: f.channelConfigs.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }))
  }

  const save = useMutation({
    mutationFn: (f: RouteForm) => {
      const payload = {
        displayName: f.displayName,
        targetModel: f.targetModel,
        strategy: f.strategy,
        channelConfigs: f.channelConfigs.map((c) => ({
          id: c.id,
          ...(c.model?.trim() ? { model: c.model.trim() } : {}),
          weight: Math.max(0, Math.min(100, Math.round(Number(c.weight) || 0))),
          quality: Math.max(1, Math.min(10, Math.round(Number(c.quality) || 5))),
        })),
        remark: f.remark || null,
        priceIn: f.priceIn.trim() === '' ? null : Number(f.priceIn),
        priceOut: f.priceOut.trim() === '' ? null : Number(f.priceOut),
        enabled: f.enabled,
      }
      return f.id
        ? api(`/api/routes/${f.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : api('/api/routes', { method: 'POST', body: JSON.stringify(payload) })
    },
    onSuccess: () => {
      toast.success(form.id ? '路由已更新' : '路由已添加')
      setDialogOpen(false)
      qc.invalidateQueries({ queryKey: ['routes'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/routes/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('路由已删除'); setDeleteId(null); qc.invalidateQueries({ queryKey: ['routes'] }) },
    onError: (e) => toast.error(e.message),
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/routes/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routes'] }),
    onError: (e) => toast.error(e.message),
  })

  const submit = () => {
    if (!form.displayName.trim()) return toast.error('请填写模型显示名')
    if (!form.targetModel.trim()) return toast.error('请填写上游真实模型名')
    if (form.channelConfigs.length === 0) return toast.error('请至少选择一个渠道')
    if (form.strategy === 'weighted' && form.channelConfigs.every((c) => !Number(c.weight))) {
      return toast.error('权重模式下至少一个渠道权重需大于 0')
    }
    save.mutate(form)
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              <span className="hidden lg:inline">模型路由</span>
              <span className="lg:hidden">共 </span>
              <span className="tabular text-caption font-normal text-muted-foreground">{routes.length}</span>
              <span className="lg:hidden text-caption font-normal text-muted-foreground">条路由</span>
            </CardTitle>
            <Button size="sm" onClick={openCreate} className="shrink-0">
              <Plus className="h-4 w-4" />添加路由
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <SkeletonRows rows={4} />
          ) : routes.length === 0 ? (
            <EmptyState
              icon={Route}
              title="还没有配置模型路由"
              description="路由决定「客户端用一个模型名，网关内部选哪个渠道」。配置后客户端只需知道显示名，切换上游无需改动配置。"
              action={
                <Button size="sm" onClick={openCreate}>
                  <Plus className="h-4 w-4" />添加第一条路由
                </Button>
              }
            />
          ) : (
            <div className="max-h-[36rem] overflow-y-auto">
              <ResponsiveList
                keyOf={(r) => (r._raw as ModelRoute).id}
                className="space-y-1.5"
                columns={[
                  { key: 'displayName', header: '显示名（对外）' },
                  { key: 'targetModel', header: '实际模型（上游）' },
                  { key: 'usage', header: '调用', className: 'hidden md:table-cell' },
                  { key: 'channels', header: '渠道与策略', className: 'hidden lg:table-cell' },
                  { key: 'enabled', header: '启用', className: 'w-20' },
                  { key: 'actions', header: '操作', align: 'right', className: 'w-32' },
                ]}
                items={routes.map((r) => {
                  const s = r.stats
                  const rate = s && s.total > 0 ? Math.round((s.ok / s.total) * 100) : null
                  return {
                    title: <span className="mono-id font-medium text-foreground">{r.displayName}</span>,
                    subtitle: r.remark || STRATEGY_META[r.strategy].desc,
                    badge: <ChannelAvailBadge route={r} channels={channels} />,
                    metrics: [
                      {
                        label: '成功率',
                        value:
                          rate == null ? (
                            <span className="text-muted-foreground">未调用</span>
                          ) : (
                            <span className="tabular">{rate}%</span>
                          ),
                      },
                      { label: '调用次数', value: <span className="tabular">{(s?.total ?? 0).toLocaleString()}</span> },
                      {
                        label: '实际模型',
                        value: r.targetModel === '*' ? <span className="text-muted-foreground">透传</span> : <span className="mono-id">{r.targetModel}</span>,
                      },
                      {
                        label: '绑定渠道',
                        value: <span className="tabular">{r.channelConfigs.length}</span>,
                      },
                    ],
                    detail: (
                      <div className="flex flex-col gap-1.5">
                        <KeyValue label="实际模型" mono>
                          {r.targetModel === '*' ? '透传请求中的模型名' : r.targetModel}
                        </KeyValue>
                        <KeyValue label="策略">{STRATEGY_META[r.strategy].desc}</KeyValue>
                        <div>
                          <p className="mb-1 text-micro tracking-[0.04em] text-muted-foreground uppercase">渠道顺序</p>
                          <RouteChannelBadges route={r} channels={channels} nameOf={nameOfChannel} compact />
                        </div>
                        {s && s.total > 0 && (
                          <>
                            <KeyValue label="累计调用">
                              <span className="tabular">{s.total.toLocaleString()}</span> 次 · 成功{' '}
                              <span className="tabular">{s.ok.toLocaleString()}</span>
                            </KeyValue>
                            {s.tokens > 0 && <KeyValue label="消耗">{fmtTokens(s.tokens)}</KeyValue>}
                            {s.lastUsedAt && <KeyValue label="最近使用">{fmtTime(s.lastUsedAt)}</KeyValue>}
                          </>
                        )}
                        {(r.priceIn != null || r.priceOut != null) && (
                          <KeyValue label="计价">
                            入 {(r.priceIn ?? 0).toFixed(2)} · 出 {(r.priceOut ?? 0).toFixed(2)}
                          </KeyValue>
                        )}
                      </div>
                    ),
                    actions: (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-9"
                          disabled={testingId === r.id}
                          onClick={() => testRoute(r)}
                          title="一键测试（走真实网关链路发一条消息）"
                        >
                          {testingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
                          测试
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-9"
                          onClick={() => openDuplicate(r)}
                          title="复制此路由"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          复制
                        </Button>
                        <Button size="sm" variant="outline" className="min-h-9" onClick={() => openEdit(r)} title="编辑">
                          <Pencil className="h-3.5 w-3.5" />
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-9 text-status-danger"
                          onClick={() => setDeleteId(r.id)}
                          title="删除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </>
                    ),
                    _raw: r,
                  }
                })}
                renderCell={(item, key) => {
                  const r = item._raw as ModelRoute
                  switch (key) {
                    case 'displayName':
                      return (
                        <div className="min-w-0">
                          <p className="mono-id font-medium">{r.displayName}</p>
                          {r.remark && <p className="truncate text-micro text-muted-foreground">{r.remark}</p>}
                        </div>
                      )
                    case 'targetModel':
                      return (
                        <span className="text-caption text-muted-foreground">
                          {r.targetModel === '*' ? <span className="italic">透传请求模型名</span> : r.targetModel}
                        </span>
                      )
                    case 'usage':
                      return <RouteUsage route={r} />
                    case 'channels':
                      return <RouteChannelBadges route={r} channels={channels} nameOf={nameOfChannel} />
                    case 'enabled':
                      return (
                        <Switch
                          checked={r.enabled}
                          onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })}
                          aria-label={`${r.displayName} 启用开关`}
                        />
                      )
                    case 'actions':
                      return (
                        <div className="flex justify-end gap-0.5">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            title="一键测试"
                            disabled={testingId === r.id}
                            onClick={() => testRoute(r)}
                          >
                            {testingId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
                          </Button>
                          <Button size="icon" variant="ghost" className="h-8 w-8" title="复制此路由" onClick={() => openDuplicate(r)}>
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-8 w-8" title="编辑" onClick={() => openEdit(r)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-status-danger"
                            title="删除"
                            onClick={() => setDeleteId(r.id)}
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

      {/* 添加 / 编辑路由 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{form.id ? '编辑路由' : '添加路由'}</DialogTitle>
            <DialogDescription>
              客户端使用「显示名」调用网关。同一显示名可在不同渠道映射不同上游模型名，失败自动切换。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>模型显示名 *</Label>
                <Input placeholder="例如：ds-v3、gpt-* 或 *" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
                <p className="text-xs text-muted-foreground">支持通配：<code>gpt-*</code> 承接 gpt- 开头的任意模型名（最长前缀优先）；<code>*</code> 兜底承接其余所有未知模型</p>
              </div>
              <div className="space-y-1.5">
                <Label>默认上游模型名 *</Label>
                <Input list="upstream-models" placeholder="例如：deepseek-v3，填 * 透传" value={form.targetModel} onChange={(e) => setForm({ ...form, targetModel: e.target.value })} />
                <datalist id="upstream-models">{allModels.map((m) => <option key={m} value={m} />)}</datalist>
                <p className="text-xs text-muted-foreground">未单独配置模型名的渠道将使用此默认值；填 <code>*</code> 时原样透传客户端请求的模型名（配合通配路由）</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>负载均衡策略</Label>
              <Select value={form.strategy} onValueChange={(v) => setForm({ ...form, strategy: v as RouteStrategy })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="priority">优先级 —— 按顺序使用，失败切换下一个</SelectItem>
                  <SelectItem value="weighted">权重随机 —— 按权重分流，失败切换其他</SelectItem>
                  <SelectItem value="speed">⚡ 速度优先 —— 自动选延迟最低的渠道</SelectItem>
                  <SelectItem value="quality">🧠 智商优先 —— 优先用智商分高的模型</SelectItem>
                  <SelectItem value="stability">🛡️ 稳定优先 —— 按近期成功率排序</SelectItem>
                  <SelectItem value="cost">💰 成本优先 —— 按渠道标注价格升序</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{STRATEGY_META[form.strategy].desc}</p>
              {/* 尝试顺序预览：与网关转发共用同一排序实现 */}
              {form.channelConfigs.length > 0 && (
                <div className="rounded-md border border-dashed px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground">尝试顺序预览（真实转发按此顺序）</p>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setPreviewNonce((n) => n + 1)}>
                      <RefreshCw className="h-3 w-3" /> 重新模拟
                    </Button>
                  </div>
                  {previewLoading ? (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 计算中…</p>
                  ) : previewErr ? (
                    <p className="mt-1.5 text-xs text-amber-600">{previewErr}</p>
                  ) : previewData ? (
                    <div className="mt-1.5 space-y-1">
                      {previewData.ordered.length === 0 && <p className="text-xs text-amber-600">没有可用渠道（均已停用或熔断）</p>}
                      {previewData.ordered.map((c, i) => (
                        <p key={c.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{i + 1}</span>
                          <span className="font-medium">{c.name}</span>
                          {c.model && <code className="rounded bg-muted px-1 text-[10px]">{c.model}</code>}
                          <span className="text-muted-foreground">· {c.basis}</span>
                        </p>
                      ))}
                      {previewData.unavailable.map((c) => (
                        <p key={c.id} className="flex items-center gap-1.5 text-xs text-red-500">
                          <XCircle className="h-3 w-3" /> {c.name}（{c.reason}，转发自动跳过）
                        </p>
                      ))}
                      {form.strategy === 'weighted' && previewData.ordered.length > 1 && (
                        <p className="text-[11px] text-muted-foreground">权重随机：每次点击「重新模拟」顺序都可能变化</p>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>选择渠道（可多选）</Label>
              {channels.length === 0 ? (
                <p className="text-sm text-muted-foreground">还没有渠道，请先到「渠道管理」添加</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {channels.map((c) => {
                    const selected = form.channelConfigs.some((x) => x.id === c.id)
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleChannel(c.id)}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs transition-colors',
                          selected ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'
                        )}
                      >
                        {selected && <span className="mr-1 font-semibold">{form.channelConfigs.findIndex((x) => x.id === c.id) + 1}</span>}
                        {c.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {form.channelConfigs.length > 0 && (
              <div className="space-y-1.5">
                <Label>
                  渠道配置
                  {form.strategy === 'priority' && '（优先级顺序）'}
                  {form.strategy === 'weighted' && '（权重分流）'}
                  {form.strategy === 'quality' && '（标注智商分 1-10）'}
                </Label>
                <div className="space-y-1">
                  {form.channelConfigs.map((cfg, i) => (
                    <div key={cfg.id} className="rounded-md border px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm">
                          <span className="mr-2 font-semibold text-emerald-600">#{i + 1}</span>
                          {channelName.get(cfg.id) || '(已删除)'}
                        </span>
                        <div className="flex gap-1">
                          {form.strategy === 'priority' && (
                            <>
                              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-3 w-3" /></Button>
                              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => move(i, 1)} disabled={i === form.channelConfigs.length - 1}><ArrowDown className="h-3 w-3" /></Button>
                            </>
                          )}
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => toggleChannel(cfg.id)}><X className="h-3 w-3" /></Button>
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-[1fr_auto_auto] gap-2">
                        <div className="space-y-0.5">
                          <p className="text-xs text-muted-foreground">该渠道模型名（留空 = 默认 {form.targetModel || '…'}）</p>
                          <Input
                            className="h-8 text-xs"
                            placeholder={channelModels.get(cfg.id)?.[0] ? `如 ${channelModels.get(cfg.id)![0]}` : '留空使用默认模型名'}
                            value={cfg.model || ''}
                            onChange={(e) => updateCfg(cfg.id, { model: e.target.value })}
                          />
                        </div>
                        {form.strategy === 'weighted' && (
                          <div className="space-y-0.5 w-24">
                            <p className="text-xs text-muted-foreground">权重</p>
                            <Input
                              className="h-8 text-xs"
                              type="number" min={0} max={100} step={1}
                              value={cfg.weight ?? 1}
                              onChange={(e) => updateCfg(cfg.id, { weight: Number(e.target.value) })}
                            />
                          </div>
                        )}
                        {form.strategy === 'quality' && (
                          <div className="space-y-0.5 w-24">
                            <p className="text-xs text-muted-foreground">智商分</p>
                            <Input
                              className="h-8 text-xs"
                              type="number" min={1} max={10} step={1}
                              value={cfg.quality ?? 5}
                              onChange={(e) => updateCfg(cfg.id, { quality: Number(e.target.value) })}
                            />
                          </div>
                        )}
                      </div>
                      {form.strategy === 'speed' && (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          当前延迟：{channels.find((c) => c.id === cfg.id)?.latencyMs != null ? `${channels.find((c) => c.id === cfg.id)!.latencyMs} ms` : '暂无探测数据'}
                          {form.strategy === 'speed' && channels.find((c) => c.id === cfg.id)?.status !== 'online' && '（渠道当前离线）'}
                        </p>
                      )}
                      {form.strategy === 'stability' && (
                        <p className="mt-1.5 text-xs text-muted-foreground">排序依据近 7 天该渠道真实调用成功率（调用日志），无记录视为 50%</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>输入价格（$ / 百万 token）</Label>
                <Input type="number" min={0} step="any" placeholder="留空 = 未标注；0 = 免费" value={form.priceIn} onChange={(e) => setForm({ ...form, priceIn: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>输出价格（$ / 百万 token）</Label>
                <Input type="number" min={0} step="any" placeholder="留空 = 未标注；0 = 免费" value={form.priceOut} onChange={(e) => setForm({ ...form, priceOut: e.target.value })} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>备注（广场页会作为模型介绍展示）</Label>
              <Input placeholder="可选" value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">启用路由</p>
                <p className="text-xs text-muted-foreground">停用后该模型名不可被调用</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deleteId !== null} onOpenChange={(v) => !v && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该路由？</AlertDialogTitle>
            <AlertDialogDescription>删除后客户端将无法再用此模型名调用。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => deleteId && remove.mutate(deleteId)}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Alert>
        <AlertDescription className="block text-xs text-muted-foreground">
          显示名可以和上游模型名相同；也可以把长名字改成短名字（例如 <code className="rounded bg-muted px-1.5 py-0.5">deepseek-v3-0324</code> → <code className="rounded bg-muted px-1.5 py-0.5">ds-v3</code>），客户端无感知。
          <br />
          不同公益站对同一模型命名不同时，用「渠道模型名」分别映射即可聚合成一个显示名。
        </AlertDescription>
      </Alert>
    </div>
  )
}
