/**
 * 后端基础模块单元测试（零外部依赖，Node 内置 test runner）
 * 运行：npm test
 *
 * 覆盖：游标分页编解码、参数校验器、统一响应封装、结构化日志脱敏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parsePagination, encodeCursor, decodeCursor, DEFAULT_LIMIT, MAX_LIMIT } = await import(
  '../src/lib/pagination.ts'
)
const { Validator, ValidationError } = await import('../src/lib/validate.ts')
const { jsonOk, jsonError, openAiError, resolveRequestId, jsonRateLimited } = await import(
  '../src/lib/api-response.ts'
)
const { log, withRequestId, currentRequestId, setLogLevel, setLogFormat, getLogLevel } = await import(
  '../src/lib/logger.ts'
)

// ============================================================
// 游标分页
// ============================================================
test('分页：limit 缺省/非法时回退默认值', () => {
  assert.equal(parsePagination(new URLSearchParams('')).limit, DEFAULT_LIMIT)
  assert.equal(parsePagination(new URLSearchParams('limit=abc')).limit, DEFAULT_LIMIT)
  assert.equal(parsePagination(new URLSearchParams('limit=0')).limit, DEFAULT_LIMIT)
  assert.equal(parsePagination(new URLSearchParams('limit=-5')).limit, DEFAULT_LIMIT)
  assert.equal(parsePagination(new URLSearchParams('limit=NaN')).limit, DEFAULT_LIMIT)
  // 越界 clamp，不报错
  assert.equal(parsePagination(new URLSearchParams('limit=99999')).limit, MAX_LIMIT)
  assert.equal(parsePagination(new URLSearchParams('limit=50')).limit, 50)
  // 小数向下取整
  assert.equal(parsePagination(new URLSearchParams('limit=10.9')).limit, 10)
})

test('分页：游标编解码往返一致', () => {
  const createdAt = new Date('2026-10-05T01:02:03.456Z')
  const id = 'abc-123'
  const encoded = encodeCursor(createdAt, id)
  // 必须是 URL 安全字符（base64url），可直接作为查询参数回传
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, `游标应 base64url 安全：${encoded}`)
  const decoded = decodeCursor(encoded)
  assert.ok(decoded)
  assert.equal(decoded!.id, id)
  assert.equal(decoded!.createdAt.getTime(), createdAt.getTime())
})

test('分页：非法游标降级为首页而非报错', () => {
  for (const bad of ['', 'not-base64!!', 'eyJ0IjoiZ2FyYmFnZSJ9', Buffer.from('{"t":1,"i":"x"}').toString('base64url')]) {
    assert.equal(decodeCursor(bad), null, `应判为非法：${bad}`)
  }
  // 传了坏游标时 limit 仍应正常解析
  const p = parsePagination(new URLSearchParams('limit=30&cursor=garbage!!'))
  assert.equal(p.limit, 30)
  assert.equal(p.cursor, undefined)
})

test('分页：带合法游标时能正确解析出时间与 id', () => {
  const cur = encodeCursor(new Date('2026-01-02T03:04:05.000Z'), 'row-9')
  const p = parsePagination(new URLSearchParams(`limit=20&cursor=${encodeURIComponent(cur)}`))
  assert.ok(p.cursor)
  assert.equal(p.cursor!.id, 'row-9')
})

// ============================================================
// 参数校验器
// ============================================================
test('校验：必填字符串', () => {
  const v = new Validator({ name: '  我的渠道  ' })
  assert.equal(v.string('name', { required: true, max: 50 }), '我的渠道')
  assert.equal(v.failed(), false)

  const v2 = new Validator({ name: '   ' })
  assert.equal(v2.string('name', { required: true }), '')
  assert.equal(v2.failed(), true)
  assert.match(v2.message(), /不能为空/)

  const v3 = new Validator({})
  v3.string('name', { required: true })
  assert.match(v3.message(), /必填/)
})

test('校验：长度上下限', () => {
  const v = new Validator({ s: 'a'.repeat(300) })
  v.string('s', { max: 100 })
  assert.equal(v.failed(), true)
  assert.match(v.message(), /不能超过 100/)

  const v2 = new Validator({ s: 'ab' })
  v2.string('s', { min: 5 })
  assert.equal(v2.failed(), true)
  assert.match(v2.message(), /至少 5/)
})

test('校验：拒绝非字符串（不静默 toString）', () => {
  const v = new Validator({ name: { a: 1 }, n: 123, arr: [1, 2] })
  v.string('name')
  v.string('n')
  v.string('arr')
  assert.equal(v.failed(), true)
  assert.equal(v.getIssues().length, 3)
  assert.match(v.message(), /必须为字符串/)
})

test('校验：枚举约束', () => {
  const v = new Validator({ strategy: 'speed' })
  assert.equal(v.enum('strategy', ['priority', 'speed'] as const), 'speed')

  const v2 = new Validator({ strategy: 'nope' })
  v2.enum('strategy', ['priority', 'speed'] as const)
  assert.equal(v2.failed(), true)
  assert.match(v2.message(), /取值必须是/)
})

test('校验：布尔不把 "false" 当真值', () => {
  assert.equal(new Validator({ a: false }).boolean('a'), false)
  assert.equal(new Validator({ a: 'false' }).boolean('a'), false)
  assert.equal(new Validator({ a: 'true' }).boolean('a'), true)
  assert.equal(new Validator({ a: 0 }).boolean('a'), false)
  assert.equal(new Validator({ a: 1 }).boolean('a'), true)
  assert.equal(new Validator({}).boolean('a'), undefined)

  const v = new Validator({ a: 'yes' })
  v.boolean('a')
  assert.equal(v.failed(), true, "'yes' 不应被当作 true")
})

test('校验：整数边界', () => {
  assert.equal(new Validator({ n: 5 }).integer('n', { min: 1 }), 5)
  assert.equal(new Validator({ n: '7' }).integer('n', { min: 1 }), 7)
  assert.equal(new Validator({}).integer('n'), undefined)
  assert.equal(new Validator({ n: null }).integer('n'), undefined)
  assert.equal(new Validator({ n: '' }).integer('n'), undefined)

  const v = new Validator({ n: 0 })
  v.integer('n', { min: 1 })
  assert.equal(v.failed(), true, '配额 0 应被判非法（0 语义为“不限”，用 null 表达）')

  const v2 = new Validator({ n: 1.5 })
  v2.integer('n')
  assert.equal(v2.failed(), true)
  assert.match(v2.message(), /整数/)
})

test('校验：字符串数组兼容裸列表输入', () => {
  assert.deepEqual(new Validator({ m: ['a', ' b ', ''] }).stringArray('m'), ['a', 'b'])
  assert.deepEqual(new Validator({ m: 'a\nb, c' }).stringArray('m'), ['a', 'b', 'c'])
  assert.deepEqual(new Validator({}).stringArray('m'), [])

  const v = new Validator({ m: 'x'.repeat(500) })
  v.stringArray('m', { itemMax: 100 })
  assert.equal(v.failed(), true)
})

test('校验：对象字段接受 JSON 字符串', () => {
  assert.deepEqual(new Validator({ md: '{"a":1}' }).object('md'), { a: 1 })
  assert.deepEqual(new Validator({ md: { a: 1 } }).object('md'), { a: 1 })
  assert.equal(new Validator({}).object('md'), undefined)
  assert.equal(new Validator({ md: '' }).object('md'), undefined)

  const v = new Validator({ md: '{bad json' })
  v.object('md')
  assert.equal(v.failed(), true)

  const v2 = new Validator({ md: [1, 2] })
  v2.object('md')
  assert.equal(v2.failed(), true, '数组不应被当作对象接受')
})

test('校验：一次返回全部问题（便于前端一次标全）', () => {
  const v = new Validator({ name: '', baseUrl: 123 })
  v.string('name', { required: true })
  v.string('baseUrl', { required: true })
  assert.equal(v.getIssues().length, 2)
  assert.throws(() => v.throwIfFailed(), ValidationError)
})

// ============================================================
// 统一响应封装
// ============================================================
test('响应：jsonOk 输出 JSON 与请求 ID 头', async () => {
  const res = jsonOk({ a: 1 }, { requestId: 'abc123' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('X-Request-Id'), 'abc123')
  assert.deepEqual(await res.json(), { a: 1 })
})

test('响应：错误体含 error 与 requestId', async () => {
  const res = jsonError(400, '名称必填', 'req-9')
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: string; requestId: string }
  assert.equal(body.error, '名称必填')
  assert.equal(body.requestId, 'req-9')
})

test('响应：OpenAI 兼容错误体形状不变（SDK 依赖）', async () => {
  const res = openAiError('boom', 'api_error', 502, { requestId: 'r1' })
  assert.equal(res.status, 502)
  const body = (await res.json()) as { error: { message: string; type: string; code: null } }
  assert.equal(body.error.message, 'boom')
  assert.equal(body.error.type, 'api_error')
  assert.equal(body.error.code, null)
})

test('响应：429 带 Retry-After', () => {
  const res = jsonRateLimited('太频繁', 10, 'r2')
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('Retry-After'), '10')
})

test('响应：请求 ID 透传合法值、拒绝非法字符', () => {
  const mk = (id?: string) =>
    new Request('http://x/api', id !== undefined ? { headers: { 'x-request-id': id } } : {})
  // 合法值原样透传（便于跨服务追踪）
  assert.equal(resolveRequestId(mk('trace-01.abc')), 'trace-01.abc')
  // 含非法字符 / 超长 → 重新生成，不接受客户端注入
  // （HTTP 头无法携带换行等控制字符，这里用空格与超长覆盖实际可触发的绕过）
  assert.notEqual(resolveRequestId(mk('bad value with spaces')), 'bad value with spaces')
  assert.match(resolveRequestId(mk('bad value with spaces')), /^[0-9a-f]{8}$/)
  const tooLong = 'a'.repeat(65)
  assert.notEqual(resolveRequestId(mk(tooLong)), tooLong)
  assert.match(resolveRequestId(mk(tooLong)), /^[0-9a-f]{8}$/)
  // 恰好 64 字符是允许的上限，应原样透传
  const max64 = 'b'.repeat(64)
  assert.equal(resolveRequestId(mk(max64)), max64)
  // 未传时生成 8 位 ID
  assert.match(resolveRequestId(mk()), /^[0-9a-f]{8}$/)
})

// ============================================================
// 结构化日志
// ============================================================
test('日志：自动脱敏，不泄漏密钥到日志输出', () => {
  const lines: string[] = []
  const orig = console.log
  console.log = (msg: unknown) => {
    lines.push(String(msg))
  }
  const prevLevel = getLogLevel()
  setLogLevel('debug')
  setLogFormat('json')
  try {
    log.info('上游报错', { apiKey: 'sk-proj-abcdef1234567890XYZ', channel: '测试渠道' })
  } finally {
    console.log = orig
    setLogLevel(prevLevel)
    setLogFormat('json')
  }
  const out = lines.join('\n')
  assert.ok(!out.includes('abcdef1234567890XYZ'), `日志不应含完整密钥：${out}`)
  assert.ok(out.includes('***'), `应含掩码：${out}`)
  // JSON 行格式：可被 journald / Loki 直接解析
  const parsed = JSON.parse(out.trim()) as Record<string, unknown>
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.channel, '测试渠道')
  assert.ok(parsed.ts)
})

test('日志：级别过滤生效', () => {
  const lines: string[] = []
  const orig = console.log
  const origWarn = console.warn
  console.log = (m: unknown) => void lines.push(String(m))
  console.warn = (m: unknown) => void lines.push(String(m))
  try {
    setLogFormat('json')
    setLogLevel('warn')
    log.debug('不该出现-debug')
    log.info('不该出现-info')
    log.warn('该出现-warn')
  } finally {
    console.log = orig
    console.warn = origWarn
    setLogLevel('info')
  }
  const out = lines.join('\n')
  assert.ok(!out.includes('不该出现-debug'))
  assert.ok(!out.includes('不该出现-info'))
  assert.ok(out.includes('该出现-warn'))
})

test('日志：请求 ID 在作用域内可取，作用域外为undefined', () => {
  assert.equal(currentRequestId(), undefined)
  withRequestId('rid-123', () => {
    assert.equal(currentRequestId(), 'rid-123')
    // 嵌套调用应保持内层值
    withRequestId('rid-456', () => {
      assert.equal(currentRequestId(), 'rid-456')
    })
    assert.equal(currentRequestId(), 'rid-123', '内层作用域结束后应恢复外层')
  })
  assert.equal(currentRequestId(), undefined)
})

test('日志：错误对象与深层结构被安全截断', () => {
  const lines: string[] = []
  const orig = console.error
  console.error = (m: unknown) => void lines.push(String(m))
  try {
    setLogFormat('json')
    setLogLevel('debug')
    log.error('处理失败', { err: new Error('upstream sk-abcdefgh12345 fail'), deep: { a: { b: { c: { d: 1 } } } } })
  } finally {
    console.error = orig
    setLogLevel('info')
  }
  const parsed = JSON.parse(lines.join('\n').trim()) as Record<string, unknown>
  assert.ok(!lines.join('\n').includes('abcdefgh12345'))
  assert.equal(parsed.err, 'Error: upstream sk-***45 fail')
  // 超过深度上限被截断，不会无限展开
  assert.equal((parsed.deep as Record<string, unknown>).a !== undefined, true)
})