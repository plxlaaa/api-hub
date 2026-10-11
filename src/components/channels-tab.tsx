'use client'

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudDownload, ClipboardPaste, FileDown, Loader2, MessageSquare, Pencil, Plus, Route, Store, Trash2, Upload, ZapOff } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState, SkeletonRows } from '@/components/feedback'
import { KeyValue, LatencyReadout, StatusDot, Truncate, fmtLatency } from '@/components/metrics'
import { ResponsiveList, Toolbar } from '@/components/responsive-list'
import { channelStatus, formatLabel, successKind } from '@/lib/channel-ui'
import { api, fmtTime, fmtTokens } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import type { Channel, ChatTestResult, ExportedConfig } from '@/types'

interface ChannelForm {
  id?: string
  name: string
  baseUrl: string
  apiKey: string
  apiFormat: 'openai' | 'anthropic' | 'gemini'
  modelsText: string
  remark: string
  enabled: boolean
}

const EMPTY_FORM: ChannelForm = { name: '', baseUrl: '', apiKey: '', apiFormat: 'openai', modelsText: '', remark: '', enabled: true }

export function ChannelsTab() {
  const qc = useQueryClient()
  const { data: channels = [], isLoading } = useQuery<Channel[]>({
    queryKey: ['channels'],
    queryFn: () => api('/api/channels'),
    refetchInterval: 8000,
  })
  // 熔断器设置
  const { data: breaker } = useQuery<{ circuitBreaker: boolean; cbThreshold: number }>({
    queryKey: ['settings'],
    queryFn: () => api('/api/settings'),
  })
  const saveBreaker = useMutation({
    mutationFn: (patch: { circuitBreaker?: boolean; cbThreshold?: number }) =>
      api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
    onError: (e) => toast.error(e.message),
  })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<ChannelForm>(EMPTY_FORM)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [chatTest, setChatTest] = useState<{ name: string; loading: boolean; result: ChatTestResult | null } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const fileRef = useRef<HTMLInputElement>(null)

  const openCreate = () => { setForm(EMPTY_FORM); setDialogOpen(true) }
  const openEdit = (c: Channel) => {
    setForm({
      id: c.id, name: c.name, baseUrl: c.baseUrl, apiKey: '', // 安全起见不回显，留空则不修改
      apiFormat: c.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
      modelsText: c.models.join('\n'), remark: c.remark || '', enabled: c.enabled,
    })
    setDialogOpen(true)
  }

  const save = useMutation({
    mutationFn: (f: ChannelForm) => {
      const payload = {
        name: f.name, baseUrl: f.baseUrl, apiKey: f.apiKey || undefined,
        apiFormat: f.apiFormat,
        models: f.modelsText, remark: f.remark || null, enabled: f.enabled,
      }
      return f.id
        ? api(`/api/channels/${f.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : api('/api/channels', { method: 'POST', body: JSON.stringify(payload) })
    },
    onSuccess: () => {
      toast.success(form.id ? '渠道已更新' : '渠道已添加')
      setDialogOpen(false)
      qc.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('渠道已删除')
      setDeleteId(null)
      qc.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/channels/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
    onError: (e) => toast.error(e.message),
  })

  // 聚合批量导入：粘贴 → 建渠道+并发拉模型 → 聚合报告 → 一键建路由
  interface BatchReportItem { id: string; name: string; alive: boolean; models: string[]; error: string | null }
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchText, setBatchText] = useState('')
  const [batchResult, setBatchResult] = useState<{ created: string[]; skipped: Array<{ line: number; name: string; reason: string }>; failed: Array<{ line: number; error: string }>; report?: BatchReportItem[] } | null>(null)
  const [batching, setBatching] = useState(false)
  const [buildingRoutes, setBuildingRoutes] = useState(false)
  const batchImport = async () => {
    setBatching(true)
    setBatchResult(null)
    try {
      const r = await api<{ created: string[]; skipped: Array<{ line: number; name: string; reason: string }>; failed: Array<{ line: number; error: string }>; report?: BatchReportItem[] }>(
        '/api/channels/batch',
        { method: 'POST', body: JSON.stringify({ text: batchText }) },
      )
      setBatchResult(r)
      if (r.created.length > 0) {
        qc.invalidateQueries({ queryKey: ['channels'] })
        const alive = r.report?.filter((x) => x.alive).length ?? 0
        toast.success(`导入 ${r.created.length} 个渠道，${alive} 个站探测存活`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导入失败')
    } finally {
      setBatching(false)
    }
  }

  /** 聚合报告 → 一键自动建路由（多站同模型合并进同一路由） */
  const buildAutoRoutes = async () => {
    const alive = batchResult?.report?.filter((x) => x.alive) ?? []
    if (alive.length === 0) return toast.error('无存活渠道可建路由')
    setBuildingRoutes(true)
    try {
      const r = await api<{ created: string[]; merged: Array<{ route: string; added: string[] }>; limited: string[]; limit: number }>(
        '/api/routes/auto',
        { method: 'POST', body: JSON.stringify({ channelIds: alive.map((x) => x.id) }) },
      )
      qc.invalidateQueries({ queryKey: ['routes'] })
      const parts = [
        r.created.length > 0 ? `新建 ${r.created.length} 条` : null,
        r.merged.length > 0 ? `合并 ${r.merged.length} 条` : null,
        r.limited.length > 0 ? `超上限跳过 ${r.limited.length} 个` : null,
      ].filter(Boolean)
      toast.success(parts.length ? `路由聚合完成：${parts.join('，')}` : '所选渠道的模型均已有路由')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '建路由失败')
    } finally {
      setBuildingRoutes(false)
    }
  }

  const fetchModels = async () => {
    if (!form.baseUrl) return toast.error('请先填写 Base URL')
    if (!form.apiKey && !form.id) return toast.error('请先填写 API Key')
    setFetchingModels(true)
    try {
      const res = await api<{ models: string[] }>('/api/channels/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: form.baseUrl, apiKey: form.apiKey || undefined, channelId: form.id, apiFormat: form.apiFormat }),
      })
      setForm((f) => ({ ...f, modelsText: res.models.join('\n') }))
      toast.success(`已拉取 ${res.models.length} 个模型`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '拉取失败')
    } finally {
      setFetchingModels(false)
    }
  }

  const submit = () => {
    if (!form.name.trim()) return toast.error('请填写渠道名称')
    if (!form.baseUrl.trim()) return toast.error('请填写 Base URL')
    if (!form.id && !form.apiKey.trim()) return toast.error('请填写 API Key')
    save.mutate(form)
  }

  // 真实对话测试（会消耗少量上游额度）
  const runChatTest = async (c: Channel) => {
    setChatTest({ name: c.name, loading: true, result: null })
    try {
      const result = await api<ChatTestResult>(`/api/channels/${c.id}/test-chat`, { method: 'POST', body: JSON.stringify({}) })
      setChatTest({ name: c.name, loading: false, result })
    } catch (e) {
      setChatTest({ name: c.name, loading: false, result: { ok: false, model: null, latencyMs: null, reply: null, totalTokens: null, error: e instanceof Error ? e.message : '测试失败' } })
    }
  }

  // 导出配置（下载 JSON）
  const exportConfig = async () => {
    try {
      const res = await fetch('/api/config/export')
      if (!res.ok) throw new Error(`导出失败（${res.status}）`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `api-hub-config-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('配置已导出（含上游 Key，请妥善保管）')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    }
  }

  // 导入配置
  const importConfig = useMutation({
    mutationFn: () => {
      let data: ExportedConfig
      try {
        data = JSON.parse(importText)
      } catch {
        throw new Error('JSON 格式不合法')
      }
      return api<{ importedChannels: number; importedRoutes: number }>('/api/config/import', {
        method: 'POST',
        body: JSON.stringify({ mode: importMode, data }),
      })
    },
    onSuccess: (r) => {
      toast.success(`导入完成：${r.importedChannels} 个渠道、${r.importedRoutes} 条路由`)
      setImportOpen(false)
      setImportText('')
      qc.invalidateQueries({ queryKey: ['channels'] })
      qc.invalidateQueries({ queryKey: ['routes'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const onPickFile = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImportText(String(reader.result || ''))
    reader.readAsText(file)
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              <span className="hidden lg:inline">渠道管理</span>
              <span className="lg:hidden">共 </span>
              <span className="tabular text-caption font-normal text-muted-foreground">{channels.length}</span>
              <span className="lg:hidden text-caption font-normal text-muted-foreground">个渠道</span>
            </CardTitle>
            <span className="text-caption text-muted-foreground">
              在线 <span className="tabular text-status-ok">{channels.filter((c) => c.status === 'online' && c.enabled).length}</span>
              <span className="mx-1 text-muted-foreground/50">/</span>
              <span className="tabular">{channels.filter((c) => c.enabled).length}</span>
            </span>
          </div>
          <Toolbar>
            <Button size="sm" onClick={openCreate} className="shrink-0">
              <Plus className="h-4 w-4" />添加渠道
            </Button>
            <Button size="sm" variant="outline" onClick={() => setBatchOpen(true)} title="粘贴多行文本批量建渠道" className="shrink-0">
              <ClipboardPaste className="h-4 w-4" />
              <span className="hidden sm:inline">批量粘贴</span>
            </Button>
            <Button size="sm" variant="outline" onClick={exportConfig} title="导出全部配置（含 Key）" className="shrink-0">
              <FileDown className="h-4 w-4" />
              <span className="hidden sm:inline">导出</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)} className="shrink-0">
              <Upload className="h-4 w-4" />
              <span className="hidden sm:inline">导入</span>
            </Button>
          </Toolbar>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 熔断器设置条 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-dashed px-3 py-2.5">
            <div className="flex items-center gap-2">
              <ZapOff className={cn('h-4 w-4', breaker?.circuitBreaker ? 'text-status-warn' : 'text-muted-foreground')} />
              <span className="text-sm font-medium">自动熔断</span>
              <Switch
                checked={breaker?.circuitBreaker ?? true}
                onCheckedChange={(v) => saveBreaker.mutate({ circuitBreaker: v })}
              />
            </div>
            <div className={cn('flex min-w-0 flex-1 items-center gap-2 text-caption text-muted-foreground sm:flex-none', !breaker?.circuitBreaker && 'opacity-40')}>
              <span className="shrink-0 whitespace-nowrap">连续失败</span>
              <Input
                type="number"
                min={1}
                defaultValue={breaker?.cbThreshold ?? 3}
                key={breaker?.cbThreshold}
                className="h-8 w-14 shrink-0 text-center text-xs"
                disabled={!breaker?.circuitBreaker}
                onBlur={(e) => {
                  const n = Math.max(1, Math.floor(Number(e.target.value) || 3))
                  e.target.value = String(n)
                  if (n !== breaker?.cbThreshold) saveBreaker.mutate({ cbThreshold: n })
                }}
              />
              <span className="hidden sm:inline">次 → 自动摘除渠道，恢复后自动加回</span>
            </div>
            {channels.some((c) => c.autoDisabled) && (
              <span className="ml-auto rounded-full bg-status-danger-soft px-2.5 py-0.5 text-xs font-medium text-status-danger">
                {channels.filter((c) => c.autoDisabled).length} 个渠道熔断中
              </span>
            )}
          </div>

          {/* 渠道列表：桌面表格 / 窄屏卡片 */}
          {isLoading ? (
            <SkeletonRows rows={4} />
          ) : channels.length === 0 ? (
            <EmptyState
              icon={Store}
              title="还没有接入任何渠道"
              description="渠道是网关的「上游」。填入公益站的 Base URL 与 API Key，网关就能聚合它们、统一成一个地址。"
              action={
                <Button size="sm" onClick={openCreate}>
                  <Plus className="h-4 w-4" />添加第一个渠道
                </Button>
              }
            />
          ) : (
            <div className="max-h-[36rem] overflow-y-auto">
              <ResponsiveList
                keyOf={(c) => (c._raw as Channel).id}
                className="space-y-1.5"
                columns={[
                  { key: 'name', header: '名称' },
                  { key: 'baseUrl', header: 'Base URL', className: 'max-w-56' },
                  { key: 'models', header: '模型', align: 'right', className: 'w-16' },
                  { key: 'usage', header: '用量横评', className: 'hidden lg:table-cell' },
                  { key: 'status', header: '状态' },
                  { key: 'enabled', header: '启用', className: 'w-20' },
                  { key: 'actions', header: '操作', align: 'right', className: 'w-32' },
                ]}
                items={channels.map((c) => {
                  const st = channelStatus(c)
                  const s = c.stats
                  const rate = s && s.calls > 0 ? Math.round((s.ok / s.calls) * 100) : null
                  return {
                    title: (
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{c.name}</span>
                        {c.apiFormat !== 'openai' && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'shrink-0 text-micro font-normal',
                              c.apiFormat === 'anthropic' && 'border-orange-300 text-orange-600 dark:border-orange-700 dark:text-orange-400'
                            )}
                            title={`${formatLabel(c.apiFormat)}格式渠道，网关自动双向转换`}
                          >
                            {formatLabel(c.apiFormat)}
                          </Badge>
                        )}
                      </span>
                    ),
                    subtitle: c.remark || undefined,
                    badge: (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 text-caption font-medium',
                          st.kind === 'ok' && 'text-status-ok',
                          st.kind === 'danger' && 'text-status-danger',
                          st.kind === 'warn' && 'text-status-warn',
                          st.kind === 'idle' && 'text-status-idle'
                        )}
                        title={st.hint}
                      >
                        <StatusDot kind={st.kind} live={st.live} />
                        {st.label}
                      </span>
                    ),
                    metrics: [
                      { label: '模型数', value: <span className="tabular">{c.models.length}</span> },
                      {
                        label: '成功率',
                        value:
                          rate == null ? (
                            <span className="text-muted-foreground">未调用</span>
                          ) : (
                            <span className="tabular">{rate}%</span>
                          ),
                      },
                      { label: '延迟', value: <LatencyReadout ms={c.latencyMs} /> },
                      {
                        label: '近24h',
                        value:
                          c.uptime24h == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span className="tabular">{c.uptime24h}%</span>
                          ),
                      },
                    ],
                    detail: (
                      <div className="flex flex-col gap-1.5">
                        <KeyValue label="Base URL" mono>
                          {c.baseUrl}
                        </KeyValue>
                        <KeyValue label="接口格式">{formatLabel(c.apiFormat)}</KeyValue>
                        {s && s.calls > 0 && (
                          <>
                            <KeyValue label="累计调用">
                              <span className="tabular">{s.calls.toLocaleString()}</span> 次 · 成功{' '}
                              <span className="tabular">{s.ok.toLocaleString()}</span>
                            </KeyValue>
                            {s.tokens > 0 && <KeyValue label="消耗">{fmtTokens(s.tokens)}</KeyValue>}
                          </>
                        )}
                        {s && s.calls > 0 && <KeyValue label="平均延迟">{fmtLatency(s.avgLatencyMs)}</KeyValue>}
                        {c.models.length > 0 && (
                          <KeyValue label="模型">
                            <span className="mono-id">{c.models.slice(0, 6).join(' · ')}</span>
                            {c.models.length > 6 && <span className="text-muted-foreground"> +{c.models.length - 6}</span>}
                          </KeyValue>
                        )}
                        {c.lastError && <KeyValue label="最近错误">{c.lastError}</KeyValue>}
                        {c.lastCheckAt && <KeyValue label="最近探测">{fmtTime(c.lastCheckAt)}</KeyValue>}
                      </div>
                    ),
                    actions: (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-9"
                          onClick={() => runChatTest(c)}
                          title="对话测试（发送一条真实消息，消耗少量额度）"
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          测试
                        </Button>
                        <Button size="sm" variant="outline" className="min-h-9" onClick={() => openEdit(c)} title="编辑">
                          <Pencil className="h-3.5 w-3.5" />
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-9 text-status-danger"
                          onClick={() => setDeleteId(c.id)}
                          title="删除该渠道"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </>
                    ),
                    _raw: c,
                  }
                })}
                renderCell={(item, key) => {
                  const c = item._raw as Channel
                  const st = channelStatus(c)
                  const s = c.stats
                  const rate = s && s.calls > 0 ? Math.round((s.ok / s.calls) * 100) : null
                  switch (key) {
                    case 'name':
                      return (
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate font-medium">{c.name}</p>
                            {c.apiFormat !== 'openai' && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  'shrink-0 text-micro font-normal',
                                  c.apiFormat === 'anthropic' && 'border-orange-300 text-orange-600 dark:border-orange-700 dark:text-orange-400'
                                )}
                                title={`${formatLabel(c.apiFormat)}格式渠道，网关自动双向转换`}
                              >
                                {formatLabel(c.apiFormat)}
                              </Badge>
                            )}
                          </div>
                          {c.remark && <p className="truncate text-micro text-muted-foreground">{c.remark}</p>}
                        </div>
                      )
                    case 'baseUrl':
                      return <Truncate className="mono-id text-muted-foreground">{c.baseUrl}</Truncate>
                    case 'models':
                      return <span className="tabular">{c.models.length}</span>
                    case 'usage':
                      if (!s || s.calls === 0) return <span className="text-caption text-muted-foreground">未调用</span>
                      return (
                        <div className="text-caption leading-tight">
                          <p className={cn('tabular', successKind(rate ?? 0) === 'danger' ? 'text-status-warn' : 'text-status-ok')}>
                            {s.calls.toLocaleString()} 次 · {rate}%
                          </p>
                          <p className="text-micro text-muted-foreground">
                            均值 {fmtLatency(s.avgLatencyMs)}
                            {s.tokens > 0 ? ` · ${fmtTokens(s.tokens)}` : ''}
                            {c.uptime24h != null ? ` · 探测 ${c.uptime24h}%` : ''}
                          </p>
                        </div>
                      )
                    case 'status':
                      return (
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 text-caption font-medium',
                            st.kind === 'ok' && 'text-status-ok',
                            st.kind === 'danger' && 'text-status-danger',
                            st.kind === 'warn' && 'text-status-warn',
                            st.kind === 'idle' && 'text-status-idle'
                          )}
                          title={st.hint}
                        >
                          <StatusDot kind={st.kind} live={st.live} />
                          {st.label}
                        </span>
                      )
                    case 'enabled':
                      return (
                        <Switch
                          checked={c.enabled}
                          onCheckedChange={(v) => toggle.mutate({ id: c.id, enabled: v })}
                          aria-label={`${c.name} 启用开关`}
                        />
                      )
                    case 'actions':
                      return (
                        <div className="flex justify-end gap-0.5">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            title="对话测试（发送一条真实消息，消耗少量额度）"
                            onClick={() => runChatTest(c)}
                          >
                            <MessageSquare className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(c)} title="编辑">
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-status-danger"
                            onClick={() => setDeleteId(c.id)}
                            title="删除"
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

      {/* 新增 / 编辑渠道 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? '编辑渠道' : '添加渠道'}</DialogTitle>
            <DialogDescription>
              接入任意 OpenAI 兼容接口。Base URL 填到域名即可（如 <code className="text-xs">https://api.example.com</code>），会自动补全 /v1。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>渠道名称 *</Label>
              <Input placeholder="例如：XX 公益站" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Base URL *</Label>
              <Input placeholder="https://api.example.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>接口格式 *</Label>
              <Select value={form.apiFormat} onValueChange={(v) => setForm({ ...form, apiFormat: v as 'openai' | 'anthropic' | 'gemini' })}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI 兼容（/v1/chat/completions）</SelectItem>
                  <SelectItem value="anthropic">Anthropic / Claude 原生（/v1/messages）</SelectItem>
                  <SelectItem value="gemini">Google Gemini（generateContent）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.apiFormat === 'anthropic'
                  ? 'Claude 原生格式：网关自动完成 OpenAI ↔ Anthropic 双向转换（含流式），认证用 x-api-key 头'
                  : form.apiFormat === 'gemini'
                    ? 'Google Gemini 原生格式：网关自动完成 OpenAI ↔ Gemini 双向转换（含流式），认证用 x-goog-api-key 头（未经真实 Key 实测，接入后请先一键测试）'
                    : '大多数中转站选这个；调用方始终用 OpenAI 格式访问网关'}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>API Key *{form.id && <span className="ml-2 text-xs text-muted-foreground">（留空表示不修改）</span>}</Label>
              <Input type="password" placeholder="sk-..." value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>支持模型（每行一个，可留空）</Label>
                <Button size="sm" variant="outline" className="h-7" onClick={fetchModels} disabled={fetchingModels}>
                  {fetchingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <CloudDownload className="h-3 w-3" />}
                  从上游拉取
                </Button>
              </div>
              <Textarea rows={5} placeholder={'gpt-4o-mini\ndeepseek-chat\nclaude-3-5-sonnet...'} value={form.modelsText} onChange={(e) => setForm({ ...form, modelsText: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>备注</Label>
              <Input placeholder="可选" value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">启用渠道</p>
                <p className="text-xs text-muted-foreground">停用后不参与探测与转发</p>
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
            <AlertDialogTitle>确认删除该渠道？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后使用该渠道的路由将无法转发（请同步检查「模型路由」配置）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => deleteId && remove.mutate(deleteId)}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Alert>
        <AlertDescription className="text-xs text-muted-foreground">
          提示：添加渠道后建议点「仪表盘 → 全部检测」验证连通性；探测使用 GET /models，不消耗对话额度。图标 💬 的「对话测试」会发送一条真实消息（消耗少量额度）。
        </AlertDescription>
      </Alert>

      {/* 对话测试结果 */}
      <Dialog open={chatTest !== null} onOpenChange={(v) => !v && setChatTest(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>对话测试 · {chatTest?.name}</DialogTitle>
            <DialogDescription>向上游发送一条真实消息（消耗少量额度），验证模型真的能对话。</DialogDescription>
          </DialogHeader>
          {chatTest?.loading ? (
            <div className="flex h-24 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              正在请求上游（最长 30 秒）…
            </div>
          ) : chatTest?.result ? (
            <div className="space-y-3">
              <div className={'rounded-md border p-3 text-sm ' + (chatTest.result.ok ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30' : 'border-red-300 bg-red-50 dark:bg-red-950/30')}>
                <p className="font-medium">{chatTest.result.ok ? '✅ 对话成功' : '❌ 对话失败'}</p>
                {chatTest.result.model && <p className="text-xs text-muted-foreground">模型：{chatTest.result.model}</p>}
                {chatTest.result.latencyMs != null && <p className="text-xs text-muted-foreground">延迟：{chatTest.result.latencyMs} ms</p>}
                {chatTest.result.totalTokens != null && <p className="text-xs text-muted-foreground">消耗：{chatTest.result.totalTokens} tokens</p>}
              </div>
              {chatTest.result.reply && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">上游回复</p>
                  <p className="rounded-md bg-muted p-3 text-sm">{chatTest.result.reply}</p>
                </div>
              )}
              {chatTest.result.error && (
                <p className="break-all text-xs text-destructive">{chatTest.result.error}</p>
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setChatTest(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 聚合批量导入 */}
      <Dialog open={batchOpen} onOpenChange={(o) => { setBatchOpen(o); if (!o) { setBatchResult(null); setBatchText('') } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>聚合批量导入</DialogTitle>
            <DialogDescription>
              一行一个公益站，导入后自动探测并拉取各站模型列表：
              <code className="mt-1 block rounded bg-muted px-2 py-1 text-[11px] leading-relaxed">
                名称 | baseUrl | apiKey | 模型(可选) | anthropic(可选)
              </code>
              <code className="mt-1 block rounded bg-muted px-2 py-1 text-[11px]">https://api.example.com/v1,sk-xxx</code>
              速记格式自动用域名命名；同名渠道自动跳过；确认后可一键聚合建路由。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              rows={7}
              placeholder={'克劳德2 | https://api.example.com/v1 | sk-xxx | claude-sonnet-4, claude-opus-4 | anthropic\nhttps://api.deepseek.com,sk-yyy'}
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              className="font-mono text-xs"
            />
            {batchResult && (
              <div className="space-y-1.5 rounded-md border p-3 text-xs">
                <p className="font-medium">
                  <span className="text-emerald-600">新建 {batchResult.created.length}</span>
                  <span className="mx-1.5 text-muted-foreground">·</span>
                  <span className="text-amber-600">跳过 {batchResult.skipped.length}</span>
                  <span className="mx-1.5 text-muted-foreground">·</span>
                  <span className="text-red-500">失败 {batchResult.failed.length}</span>
                </p>
                {batchResult.skipped.map((s) => (
                  <p key={s.line} className="text-amber-600">第 {s.line} 行「{s.name}」：{s.reason}</p>
                ))}
                {batchResult.failed.map((f) => (
                  <p key={f.line} className="text-red-500">第 {f.line} 行：{f.error}</p>
                ))}
                {batchResult.report && batchResult.report.length > 0 && (
                  <div className="mt-2 space-y-2 border-t pt-2">
                    <p className="font-medium text-muted-foreground">聚合报告（存活 {batchResult.report.filter((x) => x.alive).length}/{batchResult.report.length}）</p>
                    {batchResult.report.map((r) => (
                      <div key={r.id} className="flex items-start gap-1.5">
                        <span className={r.alive ? 'text-emerald-600' : 'text-red-500'}>{r.alive ? '●' : '○'}</span>
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{r.name}</span>
                          {r.models.length > 0 ? (
                            <span className="ml-1.5 text-muted-foreground">{r.models.length} 个模型：{r.models.slice(0, 6).join(', ')}{r.models.length > 6 ? ' …' : ''}</span>
                          ) : (
                            <span className="ml-1.5 text-red-400">{r.error ?? '无模型列表'}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="flex gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={buildAutoRoutes}
              disabled={buildingRoutes || !batchResult?.report?.some((x) => x.alive)}
              title="为存活渠道的模型自动建路由；多站同模型合并进同一路由（负载均衡+故障转移）"
            >
              {buildingRoutes ? <Loader2 className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}
              一键建路由
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setBatchOpen(false)}>关闭</Button>
              <Button onClick={batchImport} disabled={batching || !batchText.trim()}>
                {batching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardPaste className="h-4 w-4" />}
                导入
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 导入配置 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>导入配置</DialogTitle>
            <DialogDescription>
              选择或粘贴之前导出的 JSON 配置文件（含渠道与路由）。
              <b className="text-destructive">「覆盖」模式会先清空现有全部渠道与路由</b>，请谨慎选择。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>导入模式</Label>
              <Select value={importMode} onValueChange={(v) => setImportMode(v as 'merge' | 'replace')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="merge">合并（同名/同 ID 更新，其余保留）</SelectItem>
                  <SelectItem value="replace">覆盖（清空后导入）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>配置 JSON</Label>
                <Button size="sm" variant="outline" className="h-7" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-3 w-3" /> 选择文件
                </Button>
                <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0])} />
              </div>
              <Textarea rows={7} placeholder='{"version":1,"channels":[...],"routes":[...]}' value={importText} onChange={(e) => setImportText(e.target.value)} className="font-mono text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button>
            <Button onClick={() => importConfig.mutate()} disabled={importConfig.isPending || !importText.trim()}>
              {importConfig.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
