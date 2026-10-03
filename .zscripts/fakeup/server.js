let up = true
let lastReq = null // 最近一次 chat/messages 请求体（E2E 验证参数透传）
require('http').createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/toggle') { up = !up; res.end('up=' + up); return }
  if (url.pathname === '/last') { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(lastReq)); return }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch {}
    if (url.pathname === '/v1/models') {
      if (up) { res.writeHead(200, {'Content-Type': 'application/json'}); res.end('{"data":[{"id":"fake-model"}]}') }
      else { res.writeHead(503); res.end('down') }
      return
    }
    if (url.pathname === '/v1/chat/completions') {
      if (!up) { res.writeHead(503); res.end('down'); return }
      lastReq = { path: url.pathname, body }
      const text = body.stream ? '流式回复 OK，逐字输出验证。' : '假上游回复 OK'
      if (body.stream) {
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'})
        const parts = ['流式', '回复 ', 'OK，', '逐字', '输出', '验证。']
        let i = 0
        const timer = setInterval(() => {
          if (i < parts.length) {
            res.write('data: ' + JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: body.model || 'fake-model', choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }] }) + '\n\n')
            i++
          } else {
            res.write('data: ' + JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: body.model || 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
            res.write('data: [DONE]\n\n')
            clearInterval(timer)
            res.end()
          }
        }, 120)
        return
      }
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion', model: body.model || 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }))
      return
    }
    // Anthropic 原生格式：/v1/messages（校验 x-api-key 与 anthropic-version）
    if (url.pathname === '/v1/messages') {
      if (!up) { res.writeHead(503); res.end('down'); return }
      if (!body.model) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'model required' } })); return }
      const sys = typeof body.system === 'string' ? body.system : ''
      const userText = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('|')
      const reply = `[Claude原生] 收到system="${sys}" user="${userText}" max_tokens=${body.max_tokens || '缺省'}`
      if (body.stream) {
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'})
        const events = [
          { type: 'message_start', message: { id: 'msg_fake', usage: { input_tokens: 7, output_tokens: 0 } } },
          ...['Claude', '流式', '转换', '成功。'].map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 11 } },
          { type: 'message_stop' },
        ]
        let i = 0
        const timer = setInterval(() => {
          if (i < events.length) {
            res.write('event: ' + events[i].type + '\ndata: ' + JSON.stringify(events[i]) + '\n\n')
            i++
          } else { clearInterval(timer); res.end() }
        }, 100)
        return
      }
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 11 } }))
      return
    }
    res.writeHead(404); res.end()
  })
}).listen(9753, () => console.log('fake upstream :9753 v4 (openai+anthropic)'))
