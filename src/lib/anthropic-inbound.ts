/**
 * 入站 Anthropic Messages 协议适配层（POST /v1/messages）。
 *
 * 与 lib/anthropic.ts（出站方向）互为镜像：
 * - 出站：客户端 OpenAI 格式 → 转发给 anthropic 渠道时转 Anthropic 格式
 * - 入站：客户端 Anthropic 格式（Claude Code / Anthropic SDK）→ 网关内部
 *   统一走 OpenAI 处理链（鉴权/白名单/配额/限速/路由/故障转移）→ 响应转回 Anthropic 格式
 *
 * 协议差异速查（转换要覆盖的点）：
 * - system：Anthropic 是顶层字段（string 或 text 块数组）；OpenAI 是 messages 里的 system 角色
 * - 工具：Anthropic tools 用 input_schema；OpenAI 用 function.parameters
 * - 工具调用：assistant 的 tool_use 块 ↔ OpenAI message.tool_calls；
 *   user 的 tool_result 块 ↔ OpenAI role:'tool' 消息（tool_call_id 关联）
 * - tool_choice：auto/any/none/tool ↔ auto/required/none/{type:'function'}
 * - 结束原因：end_turn/stop ↔ stop；max_tokens/length ↔ length；tool_use/tool_calls ↔ tool_calls
 * - 用量：input_tokens/output_tokens ↔ prompt_tokens/completion_tokens
 * - 流式事件：message_start → content_block_start → content_block_delta(text_delta |
 *   input_json_delta) → content_block_stop → message_delta → message_stop
 */

import type { OpenAIBody, OpenAIMessage } from '@/lib/anthropic'

// ---------- 类型（仅声明用到的字段，宽容解析未知字段） ----------

export interface AnthropicRequestBody {
  model?: string
  messages?: Array<{ role?: string; content?: unknown }>
  system?: unknown
  max_tokens?: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: Array<{ name?: string; description?: string; input_schema?: unknown }>
  tool_choice?: { type?: string; name?: string }
}

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
type AnthropicContentBlock = TextBlock | ToolUseBlock | { type: string } & Record<string, unknown>

/** 提取块数组中的全部文本块（拼接） */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
}

/** system 字段（string 或 text 块数组）→ 单个 system 消息 */
function systemToMessages(system: unknown): OpenAIMessage[] {
  if (typeof system === 'string' && system) return [{ role: 'system', content: system }]
  if (Array.isArray(system)) {
    // 多个 system 块是并列的独立规则，拼接时补换行分隔（无分隔会把两条规则黏成一句）
    const text = (system as Array<Record<string, unknown>>)
      .filter((b) => b?.type === 'text')
      .map((b) => String(b.text ?? ''))
      .filter(Boolean)
      .join('\n')
    if (text) return [{ role: 'system', content: text }]
  }
  return []
}

/** Anthropic messages → OpenAI messages（tool_use/tool_result 展开为对应结构） */
function messagesToOpenAI(messages: Array<{ role?: string; content?: unknown }>): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    if (typeof m.content === 'string') {
      out.push({ role, content: m.content })
      continue
    }
    if (!Array.isArray(m.content)) {
      out.push({ role, content: '' })
      continue
    }
    const blocks = m.content as AnthropicContentBlock[]
    const textParts = blocks.filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b?.type === 'text')
    const toolUses = blocks.filter((b): b is ToolUseBlock => b?.type === 'tool_use')
    const toolResults = blocks.filter((b) => b?.type === 'tool_result')
    // assistant：文本 + tool_calls 可共存于一条 OpenAI 消息
    if (toolUses.length > 0) {
      out.push({
        role,
        content: textParts.map((b) => b.text).join('') || null,
        tool_calls: toolUses.map((t) => ({
          id: t.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: { name: String(t.name ?? ''), arguments: JSON.stringify(t.input ?? {}) },
        })),
      })
    } else if (textParts.length > 0) {
      out.push({ role, content: textParts.map((b) => b.text).join('') })
    }
    // user 侧的 tool_result：每块一条 role:'tool' 消息（OpenAI 要求与 tool_call_id 一一对应）
    for (const r of toolResults) {
      const rc = r as { tool_use_id?: string; content?: unknown }
      out.push({
        role: 'tool',
        tool_call_id: rc.tool_use_id || '',
        content: blocksToText(rc.content),
      })
    }
  }
  return out
}

/** Anthropic tools/tool_choice → OpenAI 等价物 */
function toolsToOpenAI(tools: AnthropicRequestBody['tools']): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .filter((t) => typeof t?.name === 'string' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name as string,
        ...(typeof t.description === 'string' && t.description ? { description: t.description } : {}),
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }))
}

function toolChoiceToOpenAI(tc: AnthropicRequestBody['tool_choice']): unknown {
  if (!tc || typeof tc !== 'object') return undefined
  if (tc.type === 'auto') return 'auto'
  if (tc.type === 'any') return 'required'
  if (tc.type === 'none') return 'none'
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } }
  return undefined
}

/** Anthropic /v1/messages 请求体 → OpenAI chat/completions 请求体 */
export function anthropicToOpenAIBody(a: AnthropicRequestBody): OpenAIBody & Record<string, unknown> {
  const messages = [
    ...systemToMessages(a.system),
    ...messagesToOpenAI(a.messages ?? []),
  ]
  const body: OpenAIBody & Record<string, unknown> = {
    model: typeof a.model === 'string' ? a.model : undefined,
    messages,
    max_tokens: typeof a.max_tokens === 'number' ? a.max_tokens : 4096,
  }
  if (typeof a.temperature === 'number') body.temperature = a.temperature
  if (typeof a.top_p === 'number') body.top_p = a.top_p
  // top_k 无 OpenAI 对应字段，丢弃（上游按各自默认处理）
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length > 0) body.stop = a.stop_sequences
  if (a.stream) body.stream = true
  const tools = toolsToOpenAI(a.tools)
  if (tools) {
    body.tools = tools
    const choice = toolChoiceToOpenAI(a.tool_choice)
    if (choice !== undefined) body.tool_choice = choice
  }
  return body
}

// ---------- 响应方向：OpenAI → Anthropic ----------

interface OpenAIResponse {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    message?: { role?: string; content?: unknown; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** OpenAI finish_reason → Anthropic stop_reason */
function toStopReason(finish: string | null | undefined, hasToolCalls: boolean): string {
  if (finish === 'length') return 'max_tokens'
  if (finish === 'tool_calls' || hasToolCalls) return 'tool_use'
  return 'end_turn'
}

/** OpenAI chat.completion 响应 → Anthropic messages 响应 */
export interface AnthropicMessageResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: Array<Record<string, unknown>>
  stop_reason: string
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number }
}

export function openAIToAnthropicResponse(o: OpenAIResponse, requestedModel: string): AnthropicMessageResponse {
  const choice = o.choices?.[0]
  const msg = choice?.message ?? {}
  const content: Array<Record<string, unknown>> = []
  const text = typeof msg.content === 'string' ? msg.content : ''
  if (text) content.push({ type: 'text', text })
  for (const tc of msg.tool_calls ?? []) {
    let input: unknown = {}
    try {
      input = JSON.parse(tc.function?.arguments || '{}')
    } catch {
      input = { _raw: tc.function?.arguments ?? '' }
    }
    content.push({ type: 'tool_use', id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, name: tc.function?.name ?? '', input })
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: toStopReason(choice?.finish_reason, (msg.tool_calls?.length ?? 0) > 0),
    stop_sequence: null,
    usage: {
      input_tokens: o.usage?.prompt_tokens ?? 0,
      output_tokens: o.usage?.completion_tokens ?? 0,
    },
  }
}

// ---------- SSE：OpenAI chunk 流 → Anthropic 事件流 ----------

function sseEvent(event: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * OpenAI SSE 流 → Anthropic SSE 流 转换器。
 * 事件映射：首个 delta → message_start + content_block_start(text)；
 * content delta → content_block_delta(text_delta)；
 * tool_calls delta（按 index 分块）→ content_block_start(tool_use) + input_json_delta；
 * [DONE] → 逐个 content_block_stop + message_delta(stop_reason/usage) + message_stop。
 * usage 尽力而为：上游在末尾 chunk 带 usage 时回填（多数 OpenAI 兼容站默认不带）。
 */
export function openAISSEToAnthropic(requestedModel: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
  let started = false
  let textBlockOpen = false
  /** OpenAI tool_call index → Anthropic content block index */
  const toolBlockIndex = new Map<number, number>()
  let nextBlock = 0
  let stopReason = 'end_turn'
  let inputTokens = 0
  let outputTokens = 0
  let finished = false

  const ensureStart = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (started) return
    started = true
    controller.enqueue(sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: msgId, type: 'message', role: 'assistant', model: requestedModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    }))
  }

  const openTextBlock = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (textBlockOpen) return
    ensureStart(controller)
    textBlockOpen = true
    controller.enqueue(sseEvent('content_block_start', {
      type: 'content_block_start', index: nextBlock, content_block: { type: 'text', text: '' },
    }))
    nextBlock++
  }

  const finish = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    // 幂等：[DONE] 在 transform 里触发一次后，flush 还会再触发一次（此时已无剩余数据，
    // 但 started=true 走提前掐断分支），不守卫会重复发 message_delta/message_stop
    if (finished) return
    finished = true
    if (!started) {
      // 整个流没有任何有效事件（上游空流）：仍要给出合法的最小 Anthropic 事件序列
      openTextBlock(controller)
    }
    if (textBlockOpen) {
      controller.enqueue(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }))
      textBlockOpen = false
    }
    for (const idx of toolBlockIndex.values()) {
      controller.enqueue(sseEvent('content_block_stop', { type: 'content_block_stop', index: idx }))
    }
    toolBlockIndex.clear()
    controller.enqueue(sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }))
    controller.enqueue(sseEvent('message_stop', { type: 'message_stop' }))
  }

  const handleChunk = (json: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    let ev: {
      choices?: Array<{
        delta?: {
          role?: string
          content?: unknown
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
        }
        finish_reason?: string | null
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      ev = JSON.parse(json)
    } catch {
      return
    }
    if (ev.usage) {
      if (typeof ev.usage.prompt_tokens === 'number') inputTokens = ev.usage.prompt_tokens
      if (typeof ev.usage.completion_tokens === 'number') outputTokens = ev.usage.completion_tokens
    }
    const choice = ev.choices?.[0]
    if (!choice) return

    const text = typeof choice.delta?.content === 'string' ? choice.delta.content : ''
    if (text) {
      openTextBlock(controller)
      controller.enqueue(sseEvent('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
      }))
    }

    for (const tc of choice.delta?.tool_calls ?? []) {
      ensureStart(controller)
      const oi = typeof tc.index === 'number' ? tc.index : 0
      let bi = toolBlockIndex.get(oi)
      if (bi === undefined) {
        bi = nextBlock++
        toolBlockIndex.set(oi, bi)
        controller.enqueue(sseEvent('content_block_start', {
          type: 'content_block_start', index: bi,
          content_block: { type: 'tool_use', id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, name: tc.function?.name ?? '', input: {} },
        }))
      }
      const frag = tc.function?.arguments
      if (frag) {
        controller.enqueue(sseEvent('content_block_delta', {
          type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: frag },
        }))
      }
    }

    if (choice.finish_reason) {
      stopReason = toStopReason(choice.finish_reason, toolBlockIndex.size > 0)
    }
  }

  let buffer = ''
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const json = trimmed.slice(5).trim()
        if (!json) continue
        if (json === '[DONE]') {
          finish(controller)
          continue
        }
        handleChunk(json, controller)
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data:')) {
        const json = trimmed.slice(5).trim()
        if (json === '[DONE]') finish(controller)
        else if (json) {
          handleChunk(json, controller)
          finish(controller)
        }
      } else if (started) {
        // 流被上游提前掐断（没有 [DONE]）：补齐收尾事件，让客户端事件循环正常退出
        finish(controller)
      }
    },
  })
}

// ---------- 错误响应转换 ----------

/**
 * OpenAI 风格错误 JSON → Anthropic 错误响应。
 * 网关内部错误统一是 {"error":{message,type}}；Anthropic SDK 期望
 * {"type":"error","error":{type,message}}，否则报「无法解析错误」而非展示原因。
 */
export function toAnthropicErrorResponse(openaiErrorJson: unknown, status: number, requestId?: string | null): Response {
  const e = (openaiErrorJson as { error?: { message?: string; type?: string } })?.error
  const typeMap: Record<string, string> = {
    insufficient_quota: 'rate_limit_error', // Anthropic 无该类型，归入限流
  }
  const errType = e?.type || 'api_error'
  const body = {
    type: 'error',
    error: { type: typeMap[errType] ?? errType, message: e?.message || `网关错误 HTTP ${status}` },
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (requestId) headers['X-Request-Id'] = requestId
  return new Response(JSON.stringify(body), { status, headers })
}
