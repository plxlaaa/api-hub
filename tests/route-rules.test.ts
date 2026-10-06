/**
 * 路由规则引擎单元测试（零外部依赖，Node 内置 test runner）
 * 运行：npm test
 *
 * 覆盖：匹配引擎（精确/正则/前缀/兜底/优先级/密钥准入）、
 *       新策略（sticky 粘性 / percent 分流）、时段窗口、智能熔断判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { resolveRoute } = await import('../src/lib/route-resolver.ts')
const { parseActiveHours, inActiveHours, normalizeChannelConfigs } = await import(
  '../src/lib/route-config.ts'
)
const { fnv1a, orderCandidates } = await import('../src/lib/route-order.ts')
const { shouldTripBreaker } = await import('../src/lib/route-resolver.ts')

// ---------- 测试工具 ----------

interface FakeRoute {
  displayName: string
  metadata?: unknown
  createdAt?: Date
}

function route(displayName: string, metadata?: Record<string, unknown>): FakeRoute {
  return { displayName, metadata, createdAt: new Date('2026-01-01T00:00:00Z') }
}

// ---------- 匹配引擎 ----------

test('匹配：精确命中优先于一切', () => {
  const routes = [route('gpt-*'), route('gpt-4o'), route('*')]
  const r = resolveRoute(routes, 'gpt-4o', {})
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') {
    assert.equal(r.route.displayName, 'gpt-4o')
    assert.equal(r.reason, '精确匹配')
  }
})

test('匹配：最长前缀优先（gpt-4o* 胜过 gpt-*）', () => {
  const routes = [route('gpt-*'), route('gpt-4o*'), route('*')]
  const r = resolveRoute(routes, 'gpt-4o-mini', {})
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') assert.equal(r.route.displayName, 'gpt-4o*')
})

test('匹配：正则路由 re:pattern', () => {
  const routes = [route('re:claude-.*-sonnet'), route('*')]
  const r = resolveRoute(routes, 'claude-3-7-sonnet', {})
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') {
    assert.equal(r.route.displayName, 're:claude-.*-sonnet')
    assert.match(r.reason, /正则/)
  }
})

test('匹配：正则与精确并列时精确胜出；非法正则被忽略不炸', () => {
  const routes = [route('re:([bad'), route('gpt-4o'), route('*')]
  // 非法正则路由参与解析不能抛异常
  const r1 = resolveRoute(routes, '完全不认识', {})
  assert.equal(r1.kind, 'matched') // 落到兜底
  const r2 = resolveRoute(routes, 'gpt-4o', {})
  assert.equal(r2.kind, 'matched')
  if (r2.kind === 'matched') assert.equal(r2.route.displayName, 'gpt-4o')
})

test('匹配：兜底路由 * 接住一切未知模型', () => {
  const routes = [route('claude-*'), route('*')]
  const r = resolveRoute(routes, 'llama-3-70b', {})
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') assert.equal(r.route.displayName, '*')
})

test('匹配：无兜底时 none（404 语义）', () => {
  const r = resolveRoute([route('claude-*')], 'llama-3', {})
  assert.equal(r.kind, 'none')
})

test('匹配：metadata.priority 高者胜（同特异性）', () => {
  const a = route('gpt-*', { priority: 1 })
  const b = route('gpt-*', { priority: 9 })
  const r = resolveRoute([a, b], 'gpt-4o', {})
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') assert.equal(r.route, b)
})

test('准入：allowTokens 白名单拦截并降级到兜底', () => {
  const routes = [route('gpt-*', { allowTokens: ['vip'] }), route('*', { allowTokens: [] })]
  // 非 vip 密钥请求 gpt-4o：gpt-* 被拒 → 降级到兜底
  const r = resolveRoute(routes, 'gpt-4o', { tokenName: '普通用户' })
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') assert.equal(r.route.displayName, '*')
})

test('准入：全部命中路由都被拒 → denied（403 语义）', () => {
  const routes = [route('gpt-4o', { allowTokens: ['vip'] })]
  const r = resolveRoute(routes, 'gpt-4o', { tokenName: '路人' })
  assert.equal(r.kind, 'denied')
})

test('准入：denyTokens 黑名单', () => {
  const routes = [route('*', { denyTokens: ['滥用者'] })]
  const denied = resolveRoute(routes, 'anything', { tokenName: '滥用者' })
  assert.equal(denied.kind, 'denied')
  const ok = resolveRoute(routes, 'anything', { tokenName: '好人' })
  assert.equal(ok.kind, 'matched')
})

// ---------- 时段窗口 ----------

test('activeHours：解析与越界校验', () => {
  assert.deepEqual(parseActiveHours('09:00-18:00'), [540, 1080])
  assert.deepEqual(parseActiveHours('22:00-06:00'), [1320, 360])
  assert.equal(parseActiveHours('25:00-06:00'), null)
  assert.equal(parseActiveHours('abc'), null)
  assert.deepEqual(parseActiveHours('9:0-18:0'), [540, 1080]) // 宽松个位数
})

test('activeHours：窗口内/外/跨午夜判定', () => {
  const at = (h: number, m: number) => new Date(2026, 0, 1, h, m)
  assert.equal(inActiveHours('09:00-18:00', at(10, 0)), true)
  assert.equal(inActiveHours('09:00-18:00', at(19, 0)), false)
  // 跨午夜：22:00-06:00，23 点与凌晨 5 点都在窗口内，中午不在
  assert.equal(inActiveHours('22:00-06:00', at(23, 30)), true)
  assert.equal(inActiveHours('22:00-06:00', at(5, 59)), true)
  assert.equal(inActiveHours('22:00-06:00', at(12, 0)), false)
  // 非法配置不拦截（宁多试不错杀）
  assert.equal(inActiveHours('bad', at(12, 0)), true)
})

// ---------- sticky / percent 策略 ----------

function cand(id: string, cfgExtra: Record<string, unknown> = {}): { cfg: never; ch: never } {
  return {
    cfg: { id, ...cfgExtra } as never,
    ch: { id, name: `渠道-${id}`, latencyMs: 100 } as never,
  }
}

test('sticky：同一 (tokenKey, model) 稳定粘住同一渠道', async () => {
  const candidates = [cand('a'), cand('b'), cand('c')]
  const ctx = { tokenKey: 'tok-123', model: 'gpt-4o' }
  // 多次排序结果一致
  const results = new Set<string>()
  for (let i = 0; i < 10; i++) {
    const { ordered } = await orderCandidates(candidates, 'sticky', ctx)
    results.add(ordered[0].ch.id)
  }
  assert.equal(results.size, 1)
  // 不同 token 大概率分到不同渠道（哈希均匀性抽查）
  const seen = new Set<string>()
  for (let t = 0; t < 50; t++) {
    const { ordered } = await orderCandidates(candidates, 'sticky', { tokenKey: `tok-${t}`, model: 'gpt-4o' })
    seen.add(ordered[0].ch.id)
  }
  assert.ok(seen.size > 1, '50 个不同 token 应该分布到多个渠道')
})

test('percent：0% 渠道永不做主只当后备', async () => {
  const candidates = [cand('stable', { percent: 100 }), cand('canary', { percent: 0 })]
  for (let i = 0; i < 30; i++) {
    const { ordered } = await orderCandidates(candidates, 'percent', { rand: i / 30 })
    assert.equal(ordered[0].ch.id, 'stable', 'percent=0 的渠道不能做主')
  }
})

test('percent：按占比分流（rand=0 时选第一个正占比渠道）', async () => {
  const candidates = [cand('a', { percent: 10 }), cand('b', { percent: 90 })]
  const { ordered } = await orderCandidates(candidates, 'percent', { rand: 0 })
  assert.equal(ordered[0].ch.id, 'a')
  const { ordered: o2 } = await orderCandidates(candidates, 'percent', { rand: 0.5 })
  assert.equal(o2[0].ch.id, 'b')
})

// ---------- 时段窗口参与排序 ----------

test('activeHours 窗口外渠道退为后备（不摘除）', async () => {
  // 构造一个几乎全天关闭的窗口（当前时刻必在窗外）
  const nowH = new Date().getHours()
  const outside = `${String((nowH + 1) % 24).padStart(2, '0')}:00-${String((nowH + 2) % 24).padStart(2, '0')}:00`
  const candidates = [cand('outside', { activeHours: outside }), cand('always')]
  const { ordered, basis } = await orderCandidates(candidates, 'priority')
  assert.equal(ordered[0].ch.id, 'always')
  assert.equal(ordered[1].ch.id, 'outside')
  assert.match(basis.get('outside') ?? '', /后备/)
})

// ---------- 智能熔断 ----------

test('shouldTripBreaker：渠道侧错误才累计 failStreak', () => {
  for (const s of [500, 502, 503, 401, 403, 408]) assert.equal(shouldTripBreaker(s), true, `${s} 应计熔断`)
  for (const s of [400, 404, 422, 429]) assert.equal(shouldTripBreaker(s), false, `${s} 不应计熔断`)
})

// ---------- 渠道配置新字段解析 ----------

test('normalizeChannelConfigs：percent/activeHours 解析与清洗', () => {
  const cfgs = normalizeChannelConfigs([
    { id: 'a', percent: 80, activeHours: '22:00-06:00' },
    { id: 'b', percent: 150 }, // 越界 → 丢弃该字段
    { id: 'c', activeHours: '非法' }, // 非法 → 丢弃该字段
  ])
  assert.ok(cfgs)
  assert.deepEqual(cfgs[0], { id: 'a', percent: 80, activeHours: '22:00-06:00' })
  assert.equal(cfgs[1].percent, undefined)
  assert.equal(cfgs[2].activeHours, undefined)
})
