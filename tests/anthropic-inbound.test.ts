/**
 * 入站 Anthropic Messages 协议适配层单元测试（纯函数，零 IO）。
 * 覆盖：请求转换（system/工具/工具结果/tool_choice/采样参数）、
 * 响应转换（文本/工具调用/stop_reason/用量）、SSE 流转换（文本流/工具流/空流/无DONE截断）、
 * 错误响应格式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  anthropicToOpenAIBody,
  openAIToAnthropicResponse,
  openAISSEToAnthropic,
  toAnthropicErrorResponse,
} = await import('../src/lib/anthropic-inbound.ts')

// ---------- 请求方向 ----------

test('基础消息：system 顶层字段 → system 消息，max_tokens 透传', () => {
  const b = anthropicToOpenAIBody({
    model: 'claude-x',
    system: '你是网关',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在' },
      { role: 'user', content: [{ type: 'text', text: '块形式' }] },
    ],
    max_tokens: 512,
    temperature: 0.5,
    top_p: 0.9,
    top_k: 40,
    stop_sequences: ['\n\n用户'],
  })
  assert.equal(b.model, 'claude-x')
  assert.equal(b.max_tokens, 512)
  assert.equal(b.temperature, 0.5)
  assert.equal(b.top_p, 0.9)
  assert.deepEqual(b.stop, ['\n\n用户'])
  assert.ok(b.messages)
  const msgs = b.messages!
  assert.equal(msgs.length, 4)
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[0].content, '你是网关')
  assert.equal(msgs[1].content, '你好')
  assert.equal(msgs[3].content, '块形式')
})

test('system 块数组形式合并为单条 system 消息', () => {
  const b = anthropicToOpenAIBody({
    model: 'm',
    system: [{ type: 'text', text: '规则一' }, { type: 'text', text: '规则二' }],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(b.messages![0].role, 'system')
  assert.equal(b.messages![0].content, '规则一\n规则二')
})

test('工具定义：input_schema → function.parameters', () => {
  const b = anthropicToOpenAIBody({
    model: 'm',
    messages: [{ role: 'user', content: '天气' }],
    tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
  })
  const tools = b.tools as Array<{ type: string; function: { name: string; parameters: unknown } }>
  assert.equal(tools.length, 1)
  assert.equal(tools[0].type, 'function')
  assert.equal(tools[0].function.name, 'get_weather')
  const params = tools[0].function.parameters as { properties: { city: unknown } }
  assert.ok(params.properties.city)
})

test('tool_choice 四种形式映射', () => {
  // OpenAI 要求 tool_choice 必须与 tools 同现（lib 的守卫行为一致），故 base 里带一个工具
  const tools = [{ name: 'noop', input_schema: { type: 'object', properties: {} } }]
  const base = { model: 'm', messages: [{ role: 'user', content: 'x' }], tools }
  assert.equal(anthropicToOpenAIBody({ ...base, tool_choice: { type: 'auto' } }).tool_choice, 'auto')
  assert.equal(anthropicToOpenAIBody({ ...base, tool_choice: { type: 'any' } }).tool_choice, 'required')
  assert.equal(anthropicToOpenAIBody({ ...base, tool_choice: { type: 'none' } }).tool_choice, 'none')
  const named = anthropicToOpenAIBody({ ...base, tool_choice: { type: 'tool', name: 'get_weather' } }).tool_choice as {
    type: string
    function: { name: string }
  }
  assert.equal(named.type, 'function')
  assert.equal(named.function.name, 'get_weather')
})

test('历史中的工具往返：assistant tool_use → tool_calls；user tool_result → role:tool', () => {
  const b = anthropicToOpenAIBody({
    model: 'm',
    messages: [
      { role: 'user', content: '查北京天气' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: '北京' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '晴，22度' }],
      },
    ],
  })
  const msgs = b.messages!
  const assistant = msgs.find((m) => m.role === 'assistant') as unknown as {
    tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>
  }
  assert.equal(assistant.tool_calls[0].id, 'tu_1')
  assert.equal(assistant.tool_calls[0].function.name, 'get_weather')
  assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).city, '北京')
  const toolMsg = msgs.find((m) => m.role === 'tool') as unknown as { tool_call_id: string; content: string }
  assert.equal(toolMsg.tool_call_id, 'tu_1')
  assert.equal(toolMsg.content, '晴，22度')
})

// ---------- 响应方向 ----------

test('文本响应：content 块 + end_turn + 用量映射', () => {
  const r = openAIToAnthropicResponse(
    {
      id: 'chatcmpl-1',
      choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    'claude-x',
  )
  assert.equal(r.type, 'message')
  assert.equal(r.role, 'assistant')
  assert.equal(r.model, 'claude-x')
  assert.equal(r.content[0].type, 'text')
  assert.equal(r.content[0].text, '你好')
  assert.equal(r.stop_reason, 'end_turn')
  assert.equal(r.usage.input_tokens, 10)
  assert.equal(r.usage.output_tokens, 5)
})

test('工具调用响应：tool_calls → tool_use 块 + stop_reason tool_use', () => {
  const r = openAIToAnthropicResponse(
    {
      id: 'chatcmpl-2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'claude-x',
  )
  const tu = r.content.find((c) => c.type === 'tool_use') as { name: string; input: { city: string } }
  assert.equal(tu.name, 'get_weather')
  assert.equal(tu.input.city, '上海')
  assert.equal(r.stop_reason, 'tool_use')
})

test('finish_reason length → max_tokens', () => {
  const r = openAIToAnthropicResponse(
    { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: '长文本…' }, finish_reason: 'length' }] },
    'm',
  )
  assert.equal(r.stop_reason, 'max_tokens')
})

// ---------- SSE 流方向 ----------

/** 收集 TransformStream 的全部输出 */
async function collect(stream: TransformStream<Uint8Array, Uint8Array>, inputs: string[]): Promise<string> {
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const dec = new TextDecoder()
  let out = ''
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value, { stream: true })
    }
  })()
  for (const s of inputs) await writer.write(new TextEncoder().encode(s))
  await writer.close()
  await pump
  return out
}

/** 提取 SSE 里的全部事件名（按出现顺序） */
function events(sse: string): string[] {
  return [...sse.matchAll(/^event: (\w+)$/gm)].map((m) => m[1])
}

test('SSE：文本流完整事件序列 + 文本汇聚', async () => {
  const sse = await collect(openAISSEToAnthropic('claude-x'), [
    'data: {"choices":[{"delta":{"role":"assistant","content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ])
  assert.deepEqual(events(sse), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ])
  const start = JSON.parse(sse.match(/data: ({"type":"message_start".*})/m)![1])
  assert.equal(start.message.model, 'claude-x')
  // input_tokens 在 message_start 时上游尚未上报（usage 随最后一帧到达），固定为 0；
  // Anthropic 客户端以 message_delta 的最终 usage 为准
  assert.equal(start.message.usage.input_tokens, 0)
  const texts = [...sse.matchAll(/data: ({"type":"content_block_delta".*"text_delta".*})/g)].map((m) => JSON.parse(m[1]).delta.text)
  assert.equal(texts.join(''), '你好')
  const delta = JSON.parse(sse.match(/data: ({"type":"message_delta".*})/m)![1])
  assert.equal(delta.delta.stop_reason, 'end_turn')
  assert.equal(delta.usage.output_tokens, 2)
})

test('SSE：工具调用流（input_json_delta 分片 + stop_reason tool_use）', async () => {
  const sse = await collect(openAISSEToAnthropic('m'), [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"北京\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ])
  assert.match(sse, /"type":"tool_use"/)
  assert.match(sse, /"name":"get_weather"/)
  const delta = JSON.parse(sse.match(/data: ({"type":"message_delta".*})/m)![1])
  assert.equal(delta.delta.stop_reason, 'tool_use')
  // 分片 JSON 拼回完整入参：{"city":"北京"}
  const jsonFrags = [...sse.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`))
  assert.equal(JSON.parse(jsonFrags.join('')).city, '北京')
})

test('SSE：无任何有效事件（空流）仍输出合法最小事件序列', async () => {
  const sse = await collect(openAISSEToAnthropic('m'), ['data: [DONE]\n\n'])
  assert.deepEqual(events(sse), [
    'message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop',
  ])
})

test('SSE：上游提前掐断（无 [DONE]）补齐收尾', async () => {
  const sse = await collect(openAISSEToAnthropic('m'), [
    'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n',
  ])
  assert.match(sse, /"text":"部分"/)
  assert.match(sse, /message_stop/)
})

test('SSE：chunk 跨 TCP 分片拼接（半行 JSON）', async () => {
  const raw = 'data: {"choices":[{"delta":{"content":"跨片"}}]}\n\ndata: [DONE]\n\n'
  const sse = await collect(openAISSEToAnthropic('m'), [raw.slice(0, 30), raw.slice(30)])
  assert.match(sse, /"text":"跨片"/)
  assert.match(sse, /message_stop/)
})

// ---------- 错误转换 ----------

test('错误响应转 Anthropic 格式（保留状态码与类型映射）', async () => {
  const r = toAnthropicErrorResponse(
    { error: { message: '模型 x 不存在', type: 'invalid_request_error' } },
    404,
    'req-1',
  )
  assert.equal(r.status, 404)
  assert.equal(r.headers.get('x-request-id'), 'req-1')
  const j = await r.json()
  assert.equal(j.type, 'error')
  assert.equal(j.error.type, 'invalid_request_error')
  assert.equal(j.error.message, '模型 x 不存在')
})

test('insufficient_quota 映射为 rate_limit_error', async () => {
  const r = toAnthropicErrorResponse({ error: { message: 'quota', type: 'insufficient_quota' } }, 429)
  const j = await r.json()
  assert.equal(j.error.type, 'rate_limit_error')
})

test('空错误体兜底为 HTTP 状态描述', async () => {
  const r = toAnthropicErrorResponse(null, 502)
  const j = await r.json()
  assert.equal(j.error.message, '网关错误 HTTP 502')
  assert.equal(j.error.type, 'api_error')
})
