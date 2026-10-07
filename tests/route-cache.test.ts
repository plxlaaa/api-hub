/**
 * 路由缓存与限流容量保护单元测试（零外部依赖，Node 内置 test runner）
 * 运行：npm test
 *
 * 覆盖：路由表缓存的TTL 过期与主动失效、并发击穿合并、
 *       限流桶容量淘汰不会「刚写入就被挤掉」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  getEnabledRoutes,
  invalidateRouteCache,
  __setRouteLoaderForTest,
  __setRouteCacheTtlForTest,
} = await import('../src/lib/route-cache.ts')

const { hitRateLimit, resetRateLimit } = await import('../src/lib/rate-limit.ts')

// ============================================================
// 路由表缓存
// ============================================================

/** 构造最小可用的 ModelRoute 形状（只需缓存逻辑读到的字段） */
function fakeRoute(displayName: string): any {
  return {
    id: `id-${displayName}`,
    displayName,
    targetModel: displayName,
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

test('路由缓存：TTL 内重复读取只查库一次', async () => {
  let calls = 0
  __setRouteCacheTtlForTest(60_000)
  __setRouteLoaderForTest(async () => {
    calls++
    return [fakeRoute('gpt-4o')]
  })
  invalidateRouteCache()

  const a = await getEnabledRoutes()
  const b = await getEnabledRoutes()
  assert.equal(calls, 1, 'TTL 内应命中缓存，不重复查库')
  assert.equal(a, b, '应返回同一个数组引用')
  assert.equal(a[0].displayName, 'gpt-4o')

  __setRouteLoaderForTest(null)
})

test('路由缓存：主动失效后立即重新查库', async () => {
  let calls = 0
  let data = [fakeRoute('gpt-4o')]
  __setRouteCacheTtlForTest(60_000) // TTL 足够长，只靠主动失效观察行为
  __setRouteLoaderForTest(async () => {
    calls++
    return data
  })
  invalidateRouteCache()

  await getEnabledRoutes()
  assert.equal(calls, 1)

  // 模拟管理端新建路由
  data = [fakeRoute('gpt-4o'), fakeRoute('claude-opus')]
  invalidateRouteCache()
  const after = await getEnabledRoutes()
  assert.equal(calls, 2, '失效后应重新查库')
  assert.equal(after.length, 2, '新路由应立刻可见')
  assert.equal(after[1].displayName, 'claude-opus')

  __setRouteLoaderForTest(null)
})

test('路由缓存：TTL 过期后自动重新查库', async () => {
  let calls = 0
  __setRouteCacheTtlForTest(0) // 0 = 每次都过期，等价于无缓存
  __setRouteLoaderForTest(async () => {
    calls++
    return [fakeRoute('gpt-4o')]
  })
  invalidateRouteCache()

  await getEnabledRoutes()
  await getEnabledRoutes()
  assert.equal(calls, 2, 'TTL=0 时不应缓存')

  __setRouteLoaderForTest(null)
  __setRouteCacheTtlForTest(5_000)
})

test('路由缓存：并发请求合并为一次查库（防缓存击穿）', async () => {
  let calls = 0
  __setRouteCacheTtlForTest(60_000)
  __setRouteLoaderForTest(async () => {
    calls++
    // 模拟真实 DB 的异步延迟
    await new Promise((r) => setTimeout(r, 20))
    return [fakeRoute('gpt-4o')]
  })
  invalidateRouteCache()

  // 20 个并发请求同时到达缓存为空的那一刻
  const results = await Promise.all(Array.from({ length: 20 }, () => getEnabledRoutes()))
  assert.equal(calls, 1, `并发时应合并为 1 次查库，实际 ${calls} 次`)
  for (const r of results) assert.equal(r[0].displayName, 'gpt-4o')

  __setRouteLoaderForTest(null)
})

test('路由缓存：查库失败时抛错而非回退陈旧数据', async () => {
  __setRouteCacheTtlForTest(60_000)
  __setRouteLoaderForTest(async () => {
    throw new Error('db down')
  })
  invalidateRouteCache()

  await assert.rejects(() => getEnabledRoutes(), /db down/)

  __setRouteLoaderForTest(null)
})

test('路由缓存：失败后能恢复（不缓存失败结果）', async () => {
  let shouldFail = true
  __setRouteCacheTtlForTest(60_000)
  __setRouteLoaderForTest(async () => {
    if (shouldFail) throw new Error('temporary')
    return [fakeRoute('gpt-4o')]
  })
  invalidateRouteCache()

  await assert.rejects(() => getEnabledRoutes())
  shouldFail = false
  const ok = await getEnabledRoutes()
  assert.equal(ok[0].displayName, 'gpt-4o', 'DB 恢复后应能正常读到数据')

  __setRouteLoaderForTest(null)
})

// ============================================================
// 限流容量保护
// ============================================================

test('限流：桶满时新 key 仍能正常计数（不被立即淘汰）', () => {
  // 反复灌入远超容量的不同 key，再验证最后一个 key 的限流确实生效。
  // 旧实现每次只删 1 个桶，高基数下新桶刚写入就被挤掉 → 限流失效。
  const total = 12_000
  for (let i = 0; i < total; i++) {
    hitRateLimit(`flood:${i}`, { windowMs: 60_000, max: 3 })
  }
  // 最后写入的 key 连续命中 3 次后，第 4 次必须被限流
  const key = 'flood:final-probe'
  for (let i = 0; i < 3; i++) {
    const r = hitRateLimit(key, { windowMs: 60_000, max: 3 })
    assert.equal(r.ok, true, `第 ${i + 1} 次应放行`)
  }
  const blocked = hitRateLimit(key, { windowMs: 60_000, max: 3 })
  assert.equal(blocked.ok, false, '超过 max 后必须被限流（说明计数没被提前淘汰）')
  assert.equal(blocked.remaining, 0)
  resetRateLimit(key)
})

test('限流：resetRateLimit 后计数清空', () => {
  const key = 'reset:probe'
  hitRateLimit(key, { windowMs: 60_000, max: 2 })
  hitRateLimit(key, { windowMs: 60_000, max: 2 })
  assert.equal(hitRateLimit(key, { windowMs: 60_000, max: 2 }).ok, false)
  resetRateLimit(key)
  assert.equal(hitRateLimit(key, { windowMs: 60_000, max: 2 }).ok, true, '重置后应重新放行')
  resetRateLimit(key)
})