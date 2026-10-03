// 裸路径假上游（无 /v1 前缀）——验证 baseUrl 自动补全的「反向自愈」
const http = require('node:http')
let up = true
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/toggle') { up = !up; res.end('up=' + up); return }
  if (!up) { res.writeHead(503); res.end('down'); return }
  if (url.pathname === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'bare-model', object: 'model' }] }))
    return
  }
  if (url.pathname === '/chat/completions' || url.pathname === '/v1/chat/completions' || url.pathname === '/messages' || url.pathname === '/v1/messages') {
    const isAnthropic = /messages$/.test(url.pathname)
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const j = JSON.parse(body || '{}')
      const stream = Boolean(j.stream)
      res.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' })
      if (isAnthropic) {
        // Anthropic Messages 格式（非流式给完整 content/usage；流式给 message_delta 序列）
        if (stream) {
          res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'msg_a1', usage: { input_tokens: 3 } } }) + '\n\n')
          res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '裸路径A流回复' } }) + '\n\n')
          res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }) + '\n\n')
          res.end()
        } else {
          res.end(JSON.stringify({ id: 'msg_a1', type: 'message', role: 'assistant', content: [{ type: 'text', text: '裸路径A回复' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 9 } }))
        }
        return
      }
      if (stream) {
        res.write('data: ' + JSON.stringify({ id: 'bare-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '裸路径流式回复' } }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ id: 'bare-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 12 } }) + '\n\n')
        res.write('data: [DONE]\n\n')
      } else {
        res.end(JSON.stringify({ id: 'bare-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '裸路径非流式回复' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } }))
      }
    })
    return
  }
  // Google Gemini generateContent（流式 ?alt=sse）——验证 gemini 适配器双向转换
  const gemMatch = url.pathname.match(/^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/)
  if (gemMatch) {
    const isStreamGemini = gemMatch[2] === 'streamGenerateContent'
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': isStreamGemini ? 'text/event-stream' : 'application/json' })
      if (isStreamGemini) {
        res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini流回复' }], role: 'model' } }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8, totalTokenCount: 12 } }) + '\n\n')
        res.end()
      } else {
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini回复' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8, totalTokenCount: 12 } }))
      }
    })
    return
  }
  res.writeHead(404)
  res.end('not found')
}).listen(9754, () => console.log('bare fake upstream on 9754'))
