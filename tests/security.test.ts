/**
 * 安全模块单元测试（零依赖，Node 内置 test runner）
 * 运行：node --test tests/
 *   或node --experimental-strip-types --test tests/security.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---- 被测模块（从 .ts 源直接加载，走 Node 22 的类型擦除） ----
const { checkUpstreamUrl, allowsInternalUrl } = await import('../src/lib/url-safety.ts')
const { redactSecrets } = await import('../src/lib/redact.ts')
const { hitRateLimit, checkRateLimit, resetRateLimit } = await import('../src/lib/rate-limit.ts')

// ============================================================
// SSRF 防护
// ============================================================
test('SSRF：拒绝私有网段与本地地址', () => {
  const blocked = [
    'http://127.0.0.1:8080',
    'http://localhost:3000',
    'https://10.1.2.3',
    'http://192.168.0.1',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://169.254.169.254/latest/meta-data', // 云元数据
    'http://0.0.0.0',
    'http://[::1]:9000',
    'http://foo.localhost',
    'http://svc.internal',
    'http://redis.local',
    'http://metadata.google.internal',
  ]
  for (const url of blocked) {
    const r = checkUpstreamUrl(url)
    assert.equal(r.ok, false, `应拒绝：${url}`)
  }
})

test('SSRF：拒绝危险协议（含补 https 前缀的绕过手法）', () => {
  const blocked = [
    'file:///etc/passwd',       // 经典绕过：补前缀后 hostname 竟变成 "file"
    'FILE:///etc/passwd',
    '  file:///etc/passwd',     // 前导空白
    'file:\\\\evil',
    'gopher://127.0.0.1:6379/_SET',
    'data:text/plain;base64,QQ==',
    'ftp://internal/data',
    'dict://127.0.0.1:11211/stat',
    'ldap://127.0.0.1',
    'jar:file:///tmp/a.jar!/',
    'netdoc:///etc/passwd',
    'blob:https://evil.com/x',
  ]
  for (const url of blocked) {
    const r = checkUpstreamUrl(url)
    assert.equal(r.ok, false, `应拒绝：${url}`)
    if (!r.ok) assert.match(r.reason, /协议|不合法/, `原因应提到协议问题：${url} → ${r.reason}`)
  }
})

test('SSRF：拒绝畸形与空输入', () => {
  for (const url of ['', '   ', 'http://', '://x', 'ht tp://x', 'https://[bad']) {
    assert.equal(checkUpstreamUrl(url).ok, false, `应拒绝：${url}`)
  }
})

test('SSRF：放行正常公网地址并补全协议', () => {
  const cases: Array<[string, string]> = [
    ['api.openai.com', 'https://api.openai.com'],
    ['https://api.anthropic.com', 'https://api.anthropic.com'],
    ['http://example.com/v1', 'http://example.com/v1'],
    ['example.com/', 'https://example.com'],
  ]
  for (const [input, expected] of cases) {
    const r = checkUpstreamUrl(input)
    assert.equal(r.ok, true, `应放行：${input}`)
    if (r.ok) assert.equal(r.url, expected)
  }
})

test('SSRF：172.32 属于公网段，不应误杀', () => {
  // 172.16.0.0/12 是私网，172.32.x.x 已在公网范围
  assert.equal(checkUpstreamUrl('http://172.32.0.1').ok, true)
  assert.equal(checkUpstreamUrl('http://172.15.0.1').ok, true)
  assert.equal(checkUpstreamUrl('http://11.0.0.1').ok, true)
})

test('SSRF：allowInternal 显式放行内网', () => {
  assert.equal(checkUpstreamUrl('http://10.0.0.5:8000', true).ok, true)
  assert.equal(checkUpstreamUrl('http://127.0.0.1:11434', true).ok, true)
  // 但放行内网不代表放行危险协议
  assert.equal(checkUpstreamUrl('file:///etc/passwd', true).ok, false)
})

test('allowInternal 解析：接受布尔/字符串/数字', () => {
  assert.equal(allowsInternalUrl({ allowInternal: true }), true)
  assert.equal(allowsInternalUrl({ allowInternal: 'true' }), true)
  assert.equal(allowsInternalUrl({ allowInternal: 1 }), true)
  assert.equal(allowsInternalUrl({ allowInternal: false }), false)
  assert.equal(allowsInternalUrl({}), false)
  assert.equal(allowsInternalUrl(null), false)
  assert.equal(allowsInternalUrl(undefined), false)
})

// ============================================================
// 密钥脱敏
// ============================================================
test('脱敏：掩码各类密钥形态且不误伤普通文本', () => {
  const cases: Array<[string, string]> = [
    ['Invalid API key: sk-proj-abc123def456ghi789jkl', 'sk-***kl'],
    ['Authorization: Bearer abcdef1234567890XYZ', 'Bearer abc***YZ'],
    ['{"api_key":"AIzaSyA1234567890abcdefghijk"}', 'AIz***jk'],
    ['password=supersecret123 wrong', 'sup***23'],
  ]
  for (const [input, expectFragment] of cases) {
    const out = redactSecrets(input)
    assert.ok(out.includes(expectFragment), `应包含掩码片段 ${expectFragment}，实际：${out}`)
    // 原始密钥主体不应完整出现
    assert.ok(!out.includes('abc123def456ghi789jkl'), `不应泄漏完整密钥：${out}`)
  }
})

test('脱敏：抹掉内网地址', () => {
  const cases = [
    'connect ECONNREFUSED http://127.0.0.1:11434/v1',
    'upstream http://192.168.1.10:8080 refused',
    'metadata http://169.254.169.254/latest failed',
    'http://[::1]:3000 and http://10.1.2.3:80',
  ]
  for (const input of cases) {
    const out = redactSecrets(input)
    assert.ok(out.includes('<内网地址>'), `应替换内网地址：${out}`)
  }
})

test('脱敏：普通文本原样保留（不误伤）', () => {
  const safe = [
    'plain harmless error message',
    'HTTP 429 rate limit exceeded',
    'model gpt-4 not found',
    'short error',
    '',
  ]
  for (const input of safe) {
    assert.equal(redactSecrets(input), input, `不应改动：${input}`)
  }
})

test('脱敏：截断超长内容并处理 null/undefined', () => {
  const long = 'x'.repeat(500)
  assert.ok(redactSecrets(long).length <= 301, '应被截断')
  assert.equal(redactSecrets(null), '')
  assert.equal(redactSecrets(undefined), '')
  assert.equal(redactSecrets(123), '123')
})

// ============================================================
// 限流
// ============================================================
test('限流：滑动窗口按max 拦截', () => {
  const key = 'test:basic'
  resetRateLimit(key)
  const opts = { windowMs: 60_000, max: 3 }
  assert.equal(hitRateLimit(key, opts).ok, true, '第1次应放行')
  assert.equal(hitRateLimit(key, opts).ok, true, '第2次应放行')
  assert.equal(hitRateLimit(key, opts).ok, true, '第3次应放行')
  const fourth = hitRateLimit(key, opts)
  assert.equal(fourth.ok, false, '第4次应被限流')
  assert.equal(fourth.remaining, 0)
  assert.ok(fourth.retryAfterMs > 0, '应给出重试等待时间')
})

test('限流：checkRateLimit 只查询不消耗额度', () => {
  const key = 'test:check'
  resetRateLimit(key)
  const opts = { windowMs: 60_000, max: 2 }
  hitRateLimit(key, opts)
  assert.equal(checkRateLimit(key, opts).ok, true)
  assert.equal(checkRateLimit(key, opts).ok, true, '查询不应消耗额度')
  hitRateLimit(key, opts)
  assert.equal(checkRateLimit(key, opts).ok, false, '此时才应超限')
})

test('限流：resetRateLimit 清空计数', () => {
  const key = 'test:reset'
  const opts = { windowMs: 60_000, max: 1 }
  resetRateLimit(key)
  assert.equal(hitRateLimit(key, opts).ok, true)
  assert.equal(hitRateLimit(key, opts).ok, false)
  resetRateLimit(key)
  assert.equal(hitRateLimit(key, opts).ok, true, 'reset 后应恢复')
})

test('限流：不同 key 相互独立', () => {
  const opts = { windowMs: 60_000, max: 1 }
  resetRateLimit('test:a')
  resetRateLimit('test:b')
  assert.equal(hitRateLimit('test:a', opts).ok, true)
  assert.equal(hitRateLimit('test:a', opts).ok, false)
  assert.equal(hitRateLimit('test:b', opts).ok, true, 'key b 不应受 key a 影响')
})

test('限流：过期窗口自动放行', async () => {
  const key = 'test:expire'
  const opts = { windowMs: 50, max: 1 }
  resetRateLimit(key)
  assert.equal(hitRateLimit(key, opts).ok, true)
  assert.equal(hitRateLimit(key, opts).ok, false)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(hitRateLimit(key, opts).ok, true, '窗口过期后应重新放行')
})