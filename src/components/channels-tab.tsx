'use client'

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudDownload, ClipboardPaste, FileDown, Loader2, MessageSquare, Pencil, Plus, Trash2, Upload, ZapOff } from 'lucide-react'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, fmtTokens } from '@/lib/api-client'
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

  // 批量粘贴导入（一行一个渠道，竖线分隔）
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchText, setBatchText] = useState('')
  const [batchResult, setBatchResult] = useState<{ created: string[]; skipped: Array<{ line: number; name: string; reason: string }>; failed: Array<{ line: number; error: string }> } | null>(null)
  const [batching, setBatching] = useState(false)
  const batchImport = async () => {
    setBatching(true)
    setBatchResult(null)
    try {
      const r = await api<{ created: string[]; skipped: Array<{ line: number; name: string; reason: string }>; failed: Array<{ line: number; error: string }> }>(
        '/api/channels/batch',
        { method: 'POST', body: JSON.stringify({ text: batchText }) },
      )
      setBatchResult(r)
      if (r.created.length > 0) {
        qc.invalidateQueries({ queryKey: ['channels'] })
        toast.success(`导入成功 ${r.created.length} 个渠道`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导入失败')
    } finally {
      setBatching(false)
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
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">渠道管理（{channels.length}）</CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={exportConfig} title="导出全部配置（含 Key）">
              <FileDown className="h-4 w-4" /> 导出
            </Button>
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" /> 导入
            </Button>
            <Button size="sm" variant="outline" onClick={() => setBatchOpen(true)} title="粘贴多行文本批量建渠道">
              <ClipboardPaste className="h-4 w-4" /> 批量粘贴
            </Button>
            <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4" />添加渠道</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 熔断器设置条 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-dashed px-3 py-2.5">
            <div className="flex items-center gap-2">
              <ZapOff className={'h-4 w-4 ' + (breaker?.circuitBreaker ? 'text-amber-500' : 'text-muted-foreground')} />
              <span className="text-sm font-medium">自动熔断</span>
              <Switch
                checked={breaker?.circuitBreaker ?? true}
                onCheckedChange={(v) => saveBreaker.mutate({ circuitBreaker: v })}
              />
            </div>
            <div className={'flex items-center gap-2 text-xs text-muted-foreground ' + (breaker?.circuitBreaker ? '' : 'opacity-40')}>
              <span>连续失败</span>
              <Input
                type="number"
                min={1}
                defaultValue={breaker?.cbThreshold ?? 3}
                key={breaker?.cbThreshold}
                className="h-7 w-16 text-center text-xs"
                disabled={!breaker?.circuitBreaker}
                onBlur={(e) => {
                  const n = Math.max(1, Math.floor(Number(e.target.value) || 3))
                  e.target.value = String(n)
                  if (n !== breaker?.cbThreshold) saveBreaker.mutate({ cbThreshold: n })
                }}
              />
              <span>次 → 自动摘除渠道，恢复后自动加回</span>
            </div>
            {channels.some((c) => c.autoDisabled) && (
              <span className="ml-auto rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                {channels.filter((c) => c.autoDisabled).length} 个渠道熔断中
              </span>
            )}
          </div>
          <div className="max-h-[32rem] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead className="hidden md:table-cell">Base URL</TableHead>
                  <TableHead>模型数</TableHead>
                  <TableHead className="hidden lg:table-cell">用量横评</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="h-16 text-center"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></TableCell></TableRow>
                ) : channels.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="h-16 text-center text-muted-foreground">暂无渠道，点击右上角「添加渠道」接入你的第一个公益站</TableCell></TableRow>
                ) : (
                  channels.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium">{c.name}</p>
                          {c.apiFormat === 'anthropic' && (
                            <Badge variant="outline" className="border-orange-300 text-[10px] font-normal text-orange-600 dark:border-orange-700 dark:text-orange-400" title="Anthropic / Claude 原生格式渠道，网关自动双向转换">
                              Claude 格式
                            </Badge>
                          )}
                        </div>
                        {c.remark && <p className="text-xs text-muted-foreground">{c.remark}</p>}
                      </TableCell>
                      <TableCell className="hidden max-w-56 truncate text-xs text-muted-foreground md:table-cell">{c.baseUrl}</TableCell>
                      <TableCell className="text-sm">{c.models.length}</TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {(() => {
                          const s = c.stats
                          if (!s || s.calls === 0) return <span className="text-xs text-muted-foreground">未调用</span>
                          const rate = Math.round((s.ok / s.calls) * 100)
                          return (
                            <div className="text-xs leading-tight" title={`累计 ${s.calls} 次调用 · 成功 ${s.ok} 次${s.tokens ? ` · 消耗 ${s.tokens.toLocaleString()} tokens` : ''}${c.uptime24h != null ? ` · 近24h探测可用率 ${c.uptime24h}%` : ''}`}>
                              <p className={cn('tabular-nums', rate < 80 ? 'text-amber-600' : 'text-emerald-600')}>
                                {s.calls} 次 · {rate}%
                              </p>
                              <p className="text-muted-foreground">
                                {s.avgLatencyMs != null ? `均值 ${(s.avgLatencyMs / 1000).toFixed(1)}s` : '延迟 —'}
                                {s.tokens > 0 ? ` · ${fmtTokens(s.tokens)}` : ''}
                                {c.uptime24h != null ? ` · 探测 ${c.uptime24h}%` : ''}
                              </p>
                            </div>
                          )
                        })()}
                      </TableCell>
                      <TableCell>
                        {c.autoDisabled ? (
                          <span
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400"
                            title={`连续失败 ${c.failStreak} 次，已自动摘除；探测恢复后自动加回`}
                          >
                            <ZapOff className="h-3.5 w-3.5" /> 熔断中
                          </span>
                        ) : (
                          <span className={
                            'inline-flex items-center gap-1.5 text-xs ' +
                            (c.status === 'online' ? 'text-emerald-600' : c.status === 'offline' ? 'text-red-500' : 'text-amber-500')
                          }>
                            <span className={
                              'h-1.5 w-1.5 rounded-full ' +
                              (!c.enabled ? 'bg-zinc-400' : c.status === 'online' ? 'bg-emerald-500' : c.status === 'offline' ? 'bg-red-500' : 'bg-amber-500')
                            } />
                            {c.enabled ? (c.status === 'online' ? '在线' : c.status === 'offline' ? '离线' : '未知') : '停用'}
                            {!c.enabled && c.failStreak > 0 ? '' : c.enabled && c.status === 'offline' && c.failStreak > 1 ? `（${c.failStreak} 连败）` : ''}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch checked={c.enabled} onCheckedChange={(v) => toggle.mutate({ id: c.id, enabled: v })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" title="对话测试（发送一条真实消息，消耗少量额度）" onClick={() => runChatTest(c)}>
                            <MessageSquare className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => openEdit(c)} title="编辑">
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={() => setDeleteId(c.id)} title="删除">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
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

      {/* 批量粘贴导入 */}
      <Dialog open={batchOpen} onOpenChange={(o) => { setBatchOpen(o); if (!o) { setBatchResult(null); setBatchText('') } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>批量粘贴导入渠道</DialogTitle>
            <DialogDescription>
              一行一个渠道，竖线 <code className="rounded bg-muted px-1">|</code> 分隔：
              <code className="mt-1 block rounded bg-muted px-2 py-1 text-[11px] leading-relaxed">
                名称 | baseUrl | apiKey | 模型列表(逗号分隔,可选) | anthropic(可选)
              </code>
              模型可后续用「拉取模型」补全；同名渠道自动跳过。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              rows={7}
              placeholder={'克劳德2 | https://api.example.com/v1 | sk-xxx | claude-sonnet-4, claude-opus-4 | anthropic\nDeepSeek | https://api.deepseek.com | sk-yyy | deepseek-chat'}
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
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchOpen(false)}>关闭</Button>
            <Button onClick={batchImport} disabled={batching || !batchText.trim()}>
              {batching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardPaste className="h-4 w-4" />}
              导入
            </Button>
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
