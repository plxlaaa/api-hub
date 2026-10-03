'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Eraser, Loader2, MessageSquarePlus, RefreshCw, Send, Settings2, Square, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import type { Channel, ModelRoute } from '@/types'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  channel?: string // 落到的渠道名（测试时很有用）
  latencyMs?: number
  error?: boolean
}

/** 会话：独立的历史 + 独立的系统提示词/参数 */
interface ChatSession {
  id: string
  title: string
  systemPrompt: string
  temperature: number | null // null = 不传（用上游默认）
  maxTokens: number | null
  messages: ChatMsg[]
}

const SESSIONS_KEY = 'api-hub-chat-sessions'
const ACTIVE_KEY = 'api-hub-chat-active'
const LEGACY_KEY = 'api-hub-chat-history'
const MAX_SESSIONS = 30
const MAX_MSGS = 200

function newSession(): ChatSession {
  return {
    id: `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    title: '新对话',
    systemPrompt: '',
    temperature: null,
    maxTokens: null,
    messages: [],
  }
}

function loadSessions(): { sessions: ChatSession[]; activeId: string } {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    const arr = raw ? (JSON.parse(raw) as ChatSession[]) : []
    if (Array.isArray(arr) && arr.length > 0) {
      const activeId = localStorage.getItem(ACTIVE_KEY) || arr[0].id
      return { sessions: arr.slice(-MAX_SESSIONS), activeId: arr.some((s) => s.id === activeId) ? activeId : arr[0].id }
    }
    // 迁移旧版单历史
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy) {
      const msgs = JSON.parse(legacy) as ChatMsg[]
      if (Array.isArray(msgs) && msgs.length > 0) {
        const s = { ...newSession(), title: msgs[0]?.content?.slice(0, 12) || '历史对话', messages: msgs.slice(-MAX_MSGS) }
        return { sessions: [s], activeId: s.id }
      }
    }
  } catch {
    /* 损坏数据忽略 */
  }
  const s = newSession()
  return { sessions: [s], activeId: s.id }
}

export function ChatTab() {
  const { data: routes = [] } = useQuery<ModelRoute[]>({
    queryKey: ['routes'],
    queryFn: () => api('/api/routes'),
  })
  const { data: channels = [] } = useQuery<Channel[]>({
    queryKey: ['channels'],
    queryFn: () => api('/api/channels'),
    refetchInterval: 8000,
  })
  const enabledRoutes = routes.filter((r) => r.enabled)
  const activeChannels = channels.filter((c) => c.enabled)
  const [target, setTarget] = useState('')
  useEffect(() => {
    if (target) return
    if (enabledRoutes.length > 0) setTarget(`route:${enabledRoutes[0].displayName}`)
    else if (activeChannels.length > 0) setTarget(`channel:${activeChannels[0].id}`)
  }, [enabledRoutes, activeChannels, target])

  // 多会话状态（持久化）
  const initial = useRef(loadSessions())
  const [sessions, setSessions] = useState<ChatSession[]>(initial.current.sessions)
  const [activeId, setActiveId] = useState(initial.current.activeId)
  const session = sessions.find((s) => s.id === activeId) ?? sessions[0]
  const messages = session?.messages ?? []
  useEffect(() => {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(-MAX_SESSIONS)))
      localStorage.setItem(ACTIVE_KEY, activeId)
    } catch {
      /* 存储满等异常不阻塞对话 */
    }
  }, [sessions, activeId])

  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState<number | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  /** 更新当前会话（不可变） */
  const patchSession = (fn: (s: ChatSession) => ChatSession) => {
    setSessions((ss) => ss.map((s) => (s.id === activeId ? fn(s) : s)))
  }
  const setMessages = (updater: (ms: ChatMsg[]) => ChatMsg[]) => {
    patchSession((s) => ({ ...s, messages: updater(s.messages).slice(-MAX_MSGS) }))
  }

  /** 核心发送：把历史发给测试端点（路由或渠道直连），流式渲染 */
  const run = async (history: ChatMsg[]) => {
    if (!target) return toast.error('请先选择测试对象（模型路由或渠道）')
    const byChannel = target.startsWith('channel:')
    const channelId = byChannel ? target.slice(8) : ''
    const routeName = byChannel ? '' : target.slice(6)

    setMessages(() => [...history, { role: 'assistant', content: '' }])
    setStreaming(true)
    const controller = new AbortController()
    abortRef.current = controller
    const start = Date.now()

    try {
      // 系统提示词注入为 system 首消息（anthropic 渠道后端会抽成顶层 system 字段）
      const apiMessages: Array<{ role: string; content: string }> = [
        ...(session.systemPrompt.trim() ? [{ role: 'system', content: session.systemPrompt.trim() }] : []),
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ]
      const res = await fetch(byChannel ? `/api/channels/${channelId}/test-chat` : '/api/test-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(byChannel ? {} : { model: routeName }),
          messages: apiMessages,
          stream: true,
          ...(session.temperature != null ? { temperature: session.temperature } : {}),
          ...(session.maxTokens != null ? { max_tokens: session.maxTokens } : {}),
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null
        const errMsg = typeof j?.error === 'string' ? j.error : j?.error?.message
        throw new Error(errMsg || `请求失败（${res.status}）`)
      }
      const channel = decodeURIComponent(res.headers.get('X-Gateway-Channel') || res.headers.get('X-Test-Channel') || '')
      const contentType = res.headers.get('content-type') || ''

      if (contentType.includes('text/event-stream')) {
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let acc = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith('data:')) continue
            const payload = t.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
              const delta = j.choices?.[0]?.delta?.content
              if (delta) {
                acc += delta
                setMessages((ms) => {
                  const next = [...ms]
                  next[next.length - 1] = { role: 'assistant', content: acc, channel }
                  return next
                })
              }
            } catch {
              /* 非 JSON 行忽略 */
            }
          }
        }
        setMessages((ms) => {
          const next = [...ms]
          const last = next[next.length - 1]
          next[next.length - 1] = { ...last, content: last.content || '(空回复)', channel, latencyMs: Date.now() - start }
          return next
        })
      } else {
        const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const content = j.choices?.[0]?.message?.content ?? '(空回复)'
        setMessages((ms) => {
          const next = [...ms]
          next[next.length - 1] = { role: 'assistant', content, channel, latencyMs: Date.now() - start }
          return next
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('abort')) {
        setMessages((ms) => {
          const next = [...ms]
          const last = next[next.length - 1]
          if (!last.content) next[next.length - 1] = { ...last, content: '(已中断)' }
          return next
        })
      } else {
        setMessages((ms) => {
          const next = [...ms]
          next[next.length - 1] = { role: 'assistant', content: msg, error: true }
          return next
        })
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  const send = () => {
    const text = input.trim()
    if (!text || streaming || !session) return
    // 首条消息 → 用它当会话标题
    if (session.messages.length === 0) {
      patchSession((s) => ({ ...s, title: text.slice(0, 16) }))
    }
    const history = [...session.messages, { role: 'user' as const, content: text }]
    setInput('')
    void run(history)
  }

  /** 重新生成：截掉最后的 assistant 回复，用同样历史重发 */
  const regenerate = () => {
    if (streaming || !session || session.messages.length < 2) return
    const ms = [...session.messages]
    if (ms[ms.length - 1].role === 'assistant') ms.pop()
    void run(ms)
  }

  const stop = () => abortRef.current?.abort()

  const copyMsg = (i: number) => {
    const m = messages[i]
    if (!m?.content) return
    navigator.clipboard.writeText(m.content).then(() => {
      setCopied(i)
      setTimeout(() => setCopied(null), 1500)
    }).catch(() => toast.error('复制失败'))
  }

  const createSession = () => {
    if (streaming) return toast.error('请先停止当前生成')
    const s = newSession()
    setSessions((ss) => [...ss, s].slice(-MAX_SESSIONS))
    setActiveId(s.id)
  }
  const deleteSession = (id: string) => {
    if (streaming) return toast.error('请先停止当前生成')
    setSessions((ss) => {
      const next = ss.filter((s) => s.id !== id)
      if (next.length === 0) next.push(newSession())
      if (id === activeId) setActiveId(next[next.length - 1].id)
      return next
    })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  if (!session) return null

  return (
    <Card className="flex h-[calc(100vh-11rem)] flex-col">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base">对话测试</CardTitle>
        <div className="flex items-center gap-2">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="h-8 w-56 text-xs" title="选择测试对象：模型路由（走网关链路）或渠道直连">
              <SelectValue placeholder="选择测试对象" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel className="text-xs text-muted-foreground">模型路由（走网关链路）</SelectLabel>
                {enabledRoutes.length === 0 ? (
                  <div className="px-2 py-1 text-xs text-muted-foreground">暂无启用路由，可到「模型路由」添加</div>
                ) : (
                  enabledRoutes.map((r) => (
                    <SelectItem key={r.id} value={`route:${r.displayName}`}>
                      {r.displayName}
                    </SelectItem>
                  ))
                )}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel className="text-xs text-muted-foreground">渠道直连（绕过路由）</SelectLabel>
                {activeChannels.length === 0 ? (
                  <div className="px-2 py-1 text-xs text-muted-foreground">暂无启用渠道</div>
                ) : (
                  activeChannels.map((c) => (
                    <SelectItem key={c.id} value={`channel:${c.id}`}>
                      {c.name}
                    </SelectItem>
                  ))
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
          {/* 系统提示词 + 参数 */}
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" title="系统提示词与采样参数">
                <Settings2 className="h-4 w-4" />
                {(session.systemPrompt.trim() || session.temperature != null || session.maxTokens != null) && (
                  <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96 space-y-4">
              <div className="space-y-1.5">
                <p className="text-xs font-medium">系统提示词（System Prompt）</p>
                <Textarea
                  value={session.systemPrompt}
                  onChange={(e) => patchSession((s) => ({ ...s, systemPrompt: e.target.value }))}
                  placeholder="例如：你是一个简洁的助手，用中文回答，控制在100字内"
                  className="min-h-[72px] text-xs"
                />
                <p className="text-[10px] text-muted-foreground">随本会话保存；anthropic 渠道自动转顶层 system 字段</p>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">温度（Temperature）</p>
                  <span className="text-xs text-muted-foreground">
                    {session.temperature == null ? '默认' : session.temperature.toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[session.temperature ?? 0.7]}
                  min={0}
                  max={2}
                  step={0.05}
                  onValueChange={([v]) => patchSession((s) => ({ ...s, temperature: v }))}
                />
                <div className="flex items-center justify-between">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => patchSession((s) => ({ ...s, temperature: null }))}>
                    用上游默认
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => patchSession((s) => ({ ...s, temperature: 0.7 }))}>
                    0.7（常用）
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium">最大回复 Tokens（max_tokens）</p>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={32768}
                    value={session.maxTokens ?? ''}
                    placeholder="默认（不传）"
                    onChange={(e) => {
                      const v = e.target.value
                      patchSession((s) => ({ ...s, maxTokens: v ? Math.max(1, Math.min(32768, Number(v) || 1)) : null }))
                    }}
                    className="h-8 w-32 rounded-md border bg-transparent px-2 text-xs"
                  />
                  {session.maxTokens != null && (
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => patchSession((s) => ({ ...s, maxTokens: null }))}>
                      清除
                    </Button>
                  )}
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Button size="sm" variant="outline" onClick={() => setMessages(() => [])} disabled={messages.length === 0}>
            <Eraser className="h-4 w-4" /> 清空
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 gap-3">
        {/* 会话列表 */}
        <div className="hidden w-48 shrink-0 flex-col gap-1 md:flex">
          <Button size="sm" variant="outline" className="justify-start" onClick={createSession}>
            <MessageSquarePlus className="h-4 w-4" /> 新对话
          </Button>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {[...sessions].reverse().map((s) => (
              <div
                key={s.id}
                className={cn(
                  'group flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1.5 text-xs transition-colors',
                  s.id === activeId ? 'border-primary/50 bg-accent' : 'hover:bg-accent/50',
                )}
                onClick={() => !streaming && setActiveId(s.id)}
              >
                <span className="min-w-0 flex-1 truncate">{s.title || '新对话'}</span>
                <button
                  className="hidden shrink-0 text-muted-foreground hover:text-destructive group-hover:block"
                  title="删除会话"
                  onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
        {/* 主区 */}
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-md border bg-muted/30 p-3">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-muted-foreground">
                <p className="text-sm">发送一条消息测试网关全链路</p>
                <p className="text-xs">请求走真实路由与渠道（负载均衡 / 熔断 / 故障转移），不消耗密钥配额</p>
                <p className="text-xs">⚙ 可设置系统提示词与采样参数（随会话保存）</p>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={cn('group flex items-start gap-1.5', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  {m.role === 'assistant' && !m.error && m.content && (
                    <button
                      className="mt-1 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      title="复制"
                      onClick={() => copyMsg(i)}
                    >
                      {copied === i ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  )}
                  <div
                    className={cn(
                      'max-w-[85%] whitespace-pre-wrap break-words px-3.5 py-2 text-sm leading-relaxed shadow-sm',
                      m.role === 'user'
                        ? 'rounded-2xl rounded-br-md bg-primary text-primary-foreground'
                        : m.error
                          ? 'rounded-2xl rounded-bl-md border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
                          : 'rounded-2xl rounded-bl-md border bg-card',
                    )}
                  >
                    {m.content || (streaming && i === messages.length - 1 ? <Loader2 className="h-4 w-4 animate-spin" /> : '')}
                    {m.role === 'assistant' && !m.error && (m.channel || m.latencyMs) && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {m.channel ? `via ${m.channel}` : ''}{m.channel && m.latencyMs ? ' · ' : ''}{m.latencyMs ? `${(m.latencyMs / 1000).toFixed(1)}s` : ''}
                      </p>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
              className="min-h-[52px] max-h-32 resize-none"
              disabled={streaming}
            />
            {streaming ? (
              <Button variant="destructive" onClick={stop} className="h-[52px] px-4">
                <Square className="h-4 w-4" /> 停止
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  className="h-[52px] px-3"
                  title="重新生成最后一条回复"
                  disabled={messages.length < 2}
                  onClick={regenerate}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button onClick={send} disabled={!input.trim()} className="h-[52px] px-4">
                  <Send className="h-4 w-4" /> 发送
                </Button>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
