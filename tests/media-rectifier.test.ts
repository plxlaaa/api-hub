/**
 * 图片降级整流器单元测试（零外部依赖，Node 内置 test runner）
 * 运行：npm test
 *
 * 覆盖：图片检测（image_url 对象/字符串、input_image）、降级替换（占位/保留文本/不可变）、
 *       特征判定（错误码门槛 + 中英特征词、不误伤无关 4xx 与渠道侧 5xx）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { bodyHasImages, stripImages, isImageRejection } = await import('../src/lib/media-rectifier.ts')

// ---------- bodyHasImages ----------

test('bodyHasImages：image_url 对象格式命中', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }] }] }
  assert.equal(bodyHasImages(body), true)
})

test('bodyHasImages：input_image（Responses 风格）命中', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'input_image', url: 'https://x/y.png' }] }] }
  assert.equal(bodyHasImages(body), true)
})

test('bodyHasImages：纯文本/content 为字符串 → false', () => {
  assert.equal(bodyHasImages({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), false)
  assert.equal(bodyHasImages({ messages: [{ role: 'user', content: 'hi' }] }), false)
  assert.equal(bodyHasImages({}), false)
})

// ---------- stripImages ----------

test('stripImages：图片替换为占位、同消息文本保留', () => {
  const body = {
    model: 'claude',
    messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }] }],
  }
  const out = stripImages(body) as { messages: Array<{ content: string }>; model: string }
  assert.match(out.messages[0].content, /这是什么/)
  assert.match(out.messages[0].content, /图片已省略/)
  assert.equal(typeof out.messages[0].content, 'string', 'content 退化为纯文本字符串')
  assert.equal(out.model, 'claude', '其余字段原样保留')
})

test('stripImages：不改原对象（不可变）', () => {
  const msg = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }
  const body = { messages: [msg] }
  stripImages(body)
  assert.ok(Array.isArray(msg.content), '原消息 content 未被替换')
})

test('stripImages：无图片的消息原样保留', () => {
  const body = { messages: [{ role: 'user', content: '纯文本' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }
  const out = stripImages(body)
  assert.deepEqual(out.messages, body.messages)
})

// ---------- isImageRejection ----------

test('isImageRejection：400/422/415 + 特征词命中', () => {
  assert.equal(isImageRejection(400, 'this model does not support image input'), true)
  assert.equal(isImageRejection(422, '当前模型不支持多模态输入'), true)
  assert.equal(isImageRejection(415, 'unsupported media type: vision content'), true)
})

test('isImageRejection：无关 4xx 不误伤', () => {
  assert.equal(isImageRejection(400, 'invalid request body: missing field messages'), false)
  assert.equal(isImageRejection(422, 'model not found'), false)
})

test('isImageRejection：渠道侧错误码（401/429/500）一律不触发', () => {
  assert.equal(isImageRejection(401, 'does not support image'), false)
  assert.equal(isImageRejection(429, 'vision not supported'), false)
  assert.equal(isImageRejection(500, 'image_url rejected'), false)
})
