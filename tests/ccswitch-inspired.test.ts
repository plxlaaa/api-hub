/**
 * cc-switch 优点落地三件套的单元测试（零外部依赖，Node 内置 test runner）
 * 运行：npm test
 *
 * 覆盖：
 *  - P0 模型名归一化：[1m]/[200K] 上下文尾标剥离 + 档位别名（sonnet → claude-sonnet-*）
 *  - P1 smart 性价比策略：价格+延迟合成评分、指标齐全优先、未知垫底、汇率旋钮
 *  - P1 半开熔断资格判定：冷却期、试探占位、超时自愈
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { normalizeRequestedModel, resolveRoute, tierAliasOf } = await import('../src/lib/route-resolver.ts')
const { orderCandidates } = await import('../src/lib/route-order.ts')
type Candidate = Awaited<ReturnType<typeof orderCandidates>>['ordered'][number]
const { halfOpenEligible, markProbing, clearProbing, resetProbing } = await import('../src/lib/half-open.ts')

// ---------- P0：模型名归一化 ----------

test('normalizeRequestedModel：剥离 [1m] 小写尾标', () => {
  const r = normalizeRequestedModel('claude-sonnet-4-5[1m]')
  assert.equal(r.model, 'claude-sonnet-4-5')
  assert.equal(r.contextTag, '1m')
})

test('normalizeRequestedModel：剥离 [200K] 大写尾标并归一小写', () => {
  const r = normalizeRequestedModel('claude-opus-4-8 [200K]')
  assert.equal(r.model, 'claude-opus-4-8')
  assert.equal(r.contextTag, '200k')
})

test('normalizeRequestedModel：无尾标原样返回且 contextTag 为 null', () => {
  const r = normalizeRequestedModel('gpt-4o')
  assert.equal(r.model, 'gpt-4o')
  assert.equal(r.contextTag, null)
})

test('normalizeRequestedModel：非数字尾标（如 [beta]）不剥离', () => {
  const r = normalizeRequestedModel('model-x[beta]')
  assert.equal(r.model, 'model-x[beta]')
  assert.equal(r.contextTag, null)
})

test('tierAliasOf：识别五档别名，大小写不敏感', () => {
  assert.equal(tierAliasOf('sonnet'), 'sonnet')
  assert.equal(tierAliasOf('Haiku'), 'haiku')
  assert.equal(tierAliasOf('OPUS'), 'opus')
  assert.equal(tierAliasOf('fable'), 'fable')
  assert.equal(tierAliasOf('subagent'), 'subagent')
  assert.equal(tierAliasOf('gpt-4o'), null)
  assert.equal(tierAliasOf('sonnet-4-5'), null) // 带版本号不是纯档位词
})

// ---------- P0：路由命中（尾标剥离 + 档位别名） ----------

interface FakeRoute {
  displayName: string
  targetModel?: string
  metadata?: unknown
  createdAt?: Date
}

function route(displayName: string, targetModel?: string, metadata?: Record<string, unknown>): FakeRoute {
  return { displayName, targetModel, metadata, createdAt: new Date('2026-01-01T00:00:00Z') }
}

test('resolveRoute：带 [1m] 尾标的请求命中同名精确路由', () => {
  const r = resolveRoute([route('claude-sonnet-4-5', 'claude-sonnet-4-5')], 'claude-sonnet-4-5[1m]')
  assert.equal(r.kind, 'matched')
  assert.equal(r.kind === 'matched' && r.reason, '精确匹配')
})

test('resolveRoute：纯档位词 sonnet 命中 targetModel 含 sonnet 的路由', () => {
  const r = resolveRoute([route('克劳德', 'claude-sonnet-4-6')], 'sonnet')
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') {
    assert.equal(r.route.displayName, '克劳德')
    assert.ok(r.reason.includes('档位别名'))
  }
})

test('resolveRoute：档位别名不抢前缀通配（特异性低于前缀）', () => {
  const routes = [route('sonnet-*'), route('克劳德', 'claude-sonnet-4-6')]
  const r = resolveRoute(routes, 'sonnet')
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') assert.equal(r.route.displayName, 'sonnet-*')
})

test('resolveRoute：兜底路由不参与档位别名（仍按兜底语义）', () => {
  const r = resolveRoute([route('*', 'whatever')], 'sonnet')
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') assert.equal(r.reason, '兜底路由')
})

test('resolveRoute：档位词有精确匹配时优先精确', () => {
  const routes = [route('克劳德', 'claude-sonnet-4-6'), route('opus', 'gpt-x')]
  const r = resolveRoute(routes, 'opus')
  assert.equal(r.kind, 'matched')
  if (r.kind === 'matched') assert.equal(r.route.displayName, 'opus')
})

// ---------- P1：smart 性价比策略 ----------

interface FakeCh {
  id: string
  metadata?: unknown
  latencyMs?: number | null
}

function cand(id: string, priceIn: number | null, priceOut: number | null, latencyMs: number | null) {
  const meta: Record<string, unknown> = {}
  if (priceIn != null) meta.priceIn = priceIn
  if (priceOut != null) meta.priceOut = priceOut
  return { cfg: { id }, ch: { id, metadata: meta, latencyMs } } as unknown as Candidate
}

test('smart：指标齐全者胜出，双缺垫底', async () => {
  // 便宜且快 vs 贵且慢 vs 什么都不知道
  const good = cand('good', 1, 2, 500)
  const bad = cand('bad', 10, 20, 5000)
  const none = cand('none', null, null, null)
  const { ordered } = await orderCandidates([none, bad, good], 'smart', {})
  assert.deepEqual(ordered.map((x) => x.ch.id), ['good', 'bad', 'none'])
})

test('smart：汇率旋钮 smartWaitSeconds 控制价格↔延迟取舍', async () => {
  // 便宜慢（¥1，5s） vs 贵快（¥2，0.1s）
  const cheap = cand('cheap', 1, 1, 5000)
  const fast = cand('fast', 2, 2, 100)
  // 默认 waitSeconds=10：cheap 得分 1 + 0.05 = 1.05 < fast 的 2.01 → cheap 胜
  const a = await orderCandidates([fast, cheap], 'smart', {})
  assert.equal(a.ordered[0].ch.id, 'cheap')
  // 汇率拧到极偏速度（waitSeconds=0.1）：cheap 得分 1 + 5 = 6 > fast 的 2.1 → fast 胜
  const b = await orderCandidates([fast, cheap], 'smart', { routeMeta: { smartWaitSeconds: 0.1 } })
  assert.equal(b.ordered[0].ch.id, 'fast')
})

test('smart：只标价格缺延迟的排在双全之后、双缺之前', async () => {
  const partial = cand('partial', 1, 1, null) // known=2
  const none = cand('none', null, null, null) // known=0
  const { ordered } = await orderCandidates([none, partial], 'smart', {})
  assert.equal(ordered[0].ch.id, 'partial')
})

// ---------- P1：半开熔断资格 ----------

test('halfOpenEligible：冷却未满不放行，期满放行', () => {
  process.env.GW_HALF_OPEN_COOLDOWN_MS = '1000'
  try {
    resetProbing()
    const now = Date.now()
    assert.equal(halfOpenEligible({ id: 'c1', autoDisabledAt: new Date(now - 500) }, now), false)
    assert.equal(halfOpenEligible({ id: 'c1', autoDisabledAt: new Date(now - 1500) }, now), true)
  } finally {
    delete process.env.GW_HALF_OPEN_COOLDOWN_MS
    resetProbing()
  }
})

test('halfOpenEligible：试探占位中不放行，释放后可再试探', () => {
  process.env.GW_HALF_OPEN_COOLDOWN_MS = '1000'
  try {
    resetProbing()
    const now = Date.now()
    const ch = { id: 'c2', autoDisabledAt: new Date(now - 2000) }
    assert.equal(halfOpenEligible(ch, now), true)
    markProbing('c2', now)
    assert.equal(halfOpenEligible(ch, now + 100), false) // 试探进行中
    clearProbing('c2')
    assert.equal(halfOpenEligible(ch, now + 200), true) // 释放后
  } finally {
    delete process.env.GW_HALF_OPEN_COOLDOWN_MS
    resetProbing()
  }
})

test('halfOpenEligible：占位超时自愈（漏释放不永久卡死）', () => {
  process.env.GW_HALF_OPEN_COOLDOWN_MS = '1000'
  try {
    resetProbing()
    const now = Date.now()
    const ch = { id: 'c3', autoDisabledAt: new Date(now - 2000) }
    markProbing('c3', now)
    assert.equal(halfOpenEligible(ch, now + 5000), true) // 占位超过冷却期 → 自愈
  } finally {
    delete process.env.GW_HALF_OPEN_COOLDOWN_MS
    resetProbing()
  }
})

test('halfOpenEligible：autoDisabledAt 为空视为可试探（防御旧数据）', () => {
  assert.equal(halfOpenEligible({ id: 'c4', autoDisabledAt: null }), true)
})
