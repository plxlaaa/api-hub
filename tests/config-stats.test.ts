/**
 * 配置导入 + 统计聚合 + SSRF 的单元测试（零外部依赖，Node 内置 test runner）
 * 运行：npm test
 *
 * 覆盖：导入归一化（planImport / resolveChannelRefs）、日志时序分桶
 * （bucketByDay / bucketByHour / aggregateByChannel / topModels）、IP 拦截判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { planImport, extractImportPayload, resolveChannelRefs, buildImportResult } = await import(
  '../src/lib/config-import.ts'
)
const { startOfDay, bucketByDay, bucketByHour, aggregateByChannel, topModels } = await import(
  '../src/lib/log-stats.ts'
)
const { isBlockedIp, checkUpstreamUrl, allowsInternalUrl } = await import('../src/lib/url-safety.ts')

// ============================================================
// 配置导入：请求形状兼容
// ============================================================

test('导入：识别裸配置体（仪表盘调用方式）', () => {
  const p = planImport({ kind: 'api-hub-config', version: 1, channels: [{ name: 'a', baseUrl: 'https://x.dev' }] })
  assert.ok(p)
  assert.equal(p.mode, 'merge')
  assert.equal(p.config.channels.length, 1)
})

test('导入：识别 { mode, data } 包装体（渠道页/CLI 调用方式）', () => {
  const data = { channels: [{ name: 'a', baseUrl: 'https://x.dev' }], routes: [] }
  const p = planImport({ mode: 'replace', data })
  assert.ok(p)
  assert.equal(p.mode, 'replace')
  assert.equal(p.config.channels[0].name, 'a')
})

test('导入：data 在前 mode 在后也能识别', () => {
  const p = planImport({ data: { routes: [{ displayName: 'gpt-*' }] }, mode: 'replace' })
  assert.ok(p)
  assert.equal(p.mode, 'replace')
})

test('导入：非法 mode 退化为 merge（不猜replace，避免误删数据）', () => {
  const p = planImport({ mode: 'wipe', data: { channels: [{ name: 'a', baseUrl: 'https://x.dev' }] } })
  assert.equal(p?.mode, 'merge')
})

test('导入：无法识别的结构返回 null', () => {
  assert.equal(planImport(null), null)
  assert.equal(planImport({ hello: 'world' }), null)
  assert.equal(planImport('字符串'), null)
  assert.equal(extractImportPayload({}), null)
})

// ============================================================
// 配置导入：归一化与安全边界
// ============================================================

test('导入：渠道必填项缺失时跳过并给出告警', () => {
  const p = planImport({
    channels: [
      { baseUrl: 'https://a.dev' }, // 缺 name
      { name: 'ok', baseUrl: 'https://b.dev' },
    ],
  })
  assert.ok(p)
  assert.equal(p.config.channels.length, 1)
  assert.equal(p.config.channels[0].name, 'ok')
  assert.ok(p.warnings.some((w) => w.includes('name')))
})

test('导入：同名渠道在文件内重复时只保留首个（结果不依赖数组顺序）', () => {
  const p = planImport({
    channels: [
      { name: 'dup', baseUrl: 'https://first.dev' },
      { name: 'dup', baseUrl: 'https://second.dev' },
    ],
  })
  assert.equal(p?.config.channels.length, 1)
  assert.equal(p?.config.channels[0].baseUrl, 'https://first.dev')
})

test('导入：未知 apiFormat 回落 openai，不写脏值进库', () => {
  const p = planImport({ channels: [{ name: 'c', baseUrl: 'https://a.dev', apiFormat: 'weird' }] })
  assert.equal(p?.config.channels[0].apiFormat, 'openai')
})

test('导入：gemini 协议往返保持不变', () => {
  const p = planImport({ channels: [{ name: 'c', baseUrl: 'https://a.dev', apiFormat: 'gemini' }] })
  assert.equal(p?.config.channels[0].apiFormat, 'gemini')
})

test('导入：非法策略名回退 priority 并告警', () => {
  const p = planImport({ routes: [{ displayName: 'gpt-*', targetModel: 'x', strategy: 'chaos' }] })
  assert.equal(p?.config.routes[0].strategy, 'priority')
  assert.ok(p?.warnings.some((w) => w.includes('chaos')))
})

test('导入：保留 percent 与 activeHours（导出往返不丢字段）', () => {
  const p = planImport({
    routes: [
      {
        displayName: 'gpt-*',
        targetModel: 'gpt-4',
        channelConfigs: [{ name: 'c1', percent: 20, activeHours: '22:00-06:00' }],
      },
    ],
  })
  const ref = p?.config.routes[0].channels[0]
  assert.equal(ref?.percent, 20)
  assert.equal(ref?.activeHours, '22:00-06:00')
})

test('导入：非法时段窗口被丢弃而非写入非法配置', () => {
  const p = planImport({
    routes: [{ displayName: 'gpt-*', targetModel: 'x', channelConfigs: [{ name: 'c1', activeHours: '99:99-99:99' }] }],
  })
  assert.equal(p?.config.routes[0].channels[0].activeHours, undefined)
})

test('导入：channelConfigs 为空时回退 channelIds（兼容老导出文件）', () => {
  const p = planImport({ routes: [{ displayName: 'gpt-*', targetModel: 'x', channelIds: '["id-a","id-b"]' }] })
  assert.equal(p?.config.routes[0].channels.length, 2)
  assert.equal(p?.config.routes[0].channels[0].name, 'id-a')
})

test('导入：channelConfigs 为 JSON 字符串时可解析', () => {
  const p = planImport({
    routes: [{ displayName: 'gpt-*', targetModel: 'x', channelConfigs: '[{"name":"c1","weight":3}]' }],
  })
  assert.equal(p?.config.routes[0].channels[0].weight, 3)
})

test('导入：models 同时兼容数组与 JSON 字符串', () => {
  const p = planImport({
    channels: [
      { name: 'a', baseUrl: 'https://a.dev', models: ['gpt-4', 'gpt-5'] },
      { name: 'b', baseUrl: 'https://b.dev', models: '["claude"]' },
    ],
  })
  assert.deepEqual(p?.config.channels[0].models, ['gpt-4', 'gpt-5'])
  assert.deepEqual(p?.config.channels[1].models, ['claude'])
})

test('导入：嵌套对象的 metadata 被剔除（保持扁平约束）', () => {
  const p = planImport({
    channels: [{ name: 'a', baseUrl: 'https://a.dev', metadata: { group: '公益', nested: { x: 1 }, ok: true, num: 3 } }],
  })
  assert.deepEqual(p?.config.channels[0].metadata, { group: '公益', ok: true, num: 3 })
})

test('导入：高版本文件给出提示但不阻断', () => {
  const p = planImport({ version: 99, channels: [{ name: 'a', baseUrl: 'https://a.dev' }] })
  assert.ok(p)
  assert.ok(p.warnings.some((w) => w.includes('v99')))
})

test('导入：超过规模上限时截断并告警（防超大文件打爆内存）', () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ name: `c${i}`, baseUrl: 'https://a.dev' }))
  const p = planImport({ channels: many })
  assert.equal(p?.config.channels.length, 500)
  assert.ok(p?.warnings.some((w) => w.includes('上限')))
})

// ============================================================
// 配置导入：渠道引用反查
// ============================================================

test('引用反查：按名字映射回本地 id', () => {
  const { resolved, missing } = resolveChannelRefs([{ name: 'a' }, { name: 'b' }], new Map([['a', 'id-1']]))
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].id, 'id-1')
  assert.deepEqual(missing, ['b'])
})

test('引用反查：匹配不到时剔除而非写入悬空引用', () => {
  const { resolved, missing } = resolveChannelRefs([{ name: 'ghost' }], new Map())
  assert.equal(resolved.length, 0)
  assert.deepEqual(missing, ['ghost'])
})

test('引用反查：保留 weight/percent 等策略字段', () => {
  const { resolved } = resolveChannelRefs([{ name: 'a', weight: 5, percent: 30, activeHours: '01:00-02:00' }], new Map([['a', 'id-1']]))
  assert.equal(resolved[0].weight, 5)
  assert.equal(resolved[0].percent, 30)
  assert.equal(resolved[0].activeHours, '01:00-02:00')
})

// ------------------------------------------------------------
// 回归：路由的渠道引用来源回退链
// 曾经的缺陷——归一化只读 channelConfigs / channelIds，
// 漏了 channels，导致按「渠道名」引用的配置（用户手写、早期导出）
// 导入后路由的 channelIds 为空，路由形同虚设（调用直接 502）。
// ------------------------------------------------------------

test('路由引用来源：channelConfigs 优先', () => {
  const p = planImport({
    channels: [{ name: 'A', baseUrl: 'https://a.example.com/v1', apiKey: 'k' }],
    routes: [
      {
        displayName: 'm',
        channels: [{ name: 'A', weight: 1 }],
        channelConfigs: [{ id: 'from-cfg', weight: 9 }],
      },
    ],
  })
  assert.equal(p?.config.routes[0].channels[0].name, 'from-cfg')
})

test('路由引用来源：无 channelConfigs 时回退 channels（按名引用）', () => {
  const p = planImport({
    channels: [{ name: 'A', baseUrl: 'https://a.example.com/v1', apiKey: 'k' }],
    routes: [{ displayName: 'm', channels: [{ name: 'A', weight: 70 }] }],
  })
  const refs = p?.config.routes[0].channels
  assert.equal(refs?.length, 1)
  assert.equal(refs?.[0].name, 'A')
  assert.equal(refs?.[0].weight, 70)
})

test('路由引用来源：无 channels 时回退老格式 channelIds', () => {
  const p = planImport({
    channels: [{ name: 'A', baseUrl: 'https://a.example.com/v1', apiKey: 'k' }],
    routes: [{ displayName: 'm', channelIds: ['id-legacy'] }],
  })
  assert.equal(p?.config.routes[0].channels[0].name, 'id-legacy')
})

test('路由引用来源：三种写法都缺失时得到空引用而非抛错', () => {
  const p = planImport({
    channels: [{ name: 'A', baseUrl: 'https://a.example.com/v1', apiKey: 'k' }],
    routes: [{ displayName: 'm' }],
  })
  assert.deepEqual(p?.config.routes[0].channels, [])
})

test('路由引用来源：导出的 channelConfigs 往返后权重不丢', () => {
  // 模拟 export → import 往返：导出结构里是 channelConfigs
  const p = planImport({
    channels: [{ name: 'A', baseUrl: 'https://a.example.com/v1', apiKey: 'k' }],
    routes: [
      {
        displayName: 'gpt-4o',
        targetModel: 'gpt-4o',
        strategy: 'weighted',
        channelConfigs: [{ name: 'A', weight: 70, percent: 100, activeHours: '09:00-18:00' }],
      },
    ],
  })
  const ref = p?.config.routes[0].channels[0]
  assert.equal(ref?.name, 'A')
  assert.equal(ref?.weight, 70)
  assert.equal(ref?.percent, 100)
  assert.equal(ref?.activeHours, '09:00-18:00')
})

test('路由引用来源：非法 activeHours 被丢弃而非写入脏配置', () => {
  // parseActiveHours 只接受 HH:MM-HH:MM；非法值丢弃（宁多试不错杀）
  const p = planImport({
    channels: [{ name: 'A', baseUrl: 'https://a.example.com/v1', apiKey: 'k' }],
    routes: [{ displayName: 'm', channels: [{ name: 'A', activeHours: '9-18' }] }],
  })
  assert.equal(p?.config.routes[0].channels[0].activeHours, undefined)
})

test('导入结果：三组调用方所需字段的并集', () => {
  const r = buildImportResult({
    channelsAdded: 2,
    channelsSkipped: 1,
    routesAdded: 3,
    routesSkipped: 0,
    channelsMissingKey: 1,
    refsDropped: 2,
    warnings: [],
  })
  assert.equal(r.ok, true)
  // 仪表盘字段
  assert.equal(r.channelsAdded, 2)
  assert.equal(r.routesSkipped, 0)
  assert.equal(r.channelsMissingKey, 1)
  // 渠道页/CLI 字段
  assert.equal(r.importedChannels, 2)
  assert.equal(r.importedRoutes, 3)
})

// ============================================================
// 日志统计：分桶
// ============================================================

const NOW = new Date('2026-10-07T12:30:00')

test('统计：startOfDay 归零到本地 0点', () => {
  const d = startOfDay(new Date('2026-10-07T23:59:59'))
  assert.equal(d.getHours(), 0)
  assert.equal(d.getMinutes(), 0)
  assert.equal(d.getDate(), 7)
})

test('统计：按天分桶返回 7 个桶且末位是今天', () => {
  const buckets = bucketByDay([], NOW, 7)
  assert.equal(buckets.length, 7)
  assert.equal(buckets[6].date, '10/7')
  assert.equal(buckets[0].date, '10/1')
  assert.equal(buckets[6].start.getHours(), 0)
})

test('统计：样本归入正确的天桶，失败与 token 分别累计', () => {
  const today9am = new Date('2026-10-07T09:00:00')
  const today10am = new Date('2026-10-07T10:00:00')
  const yest = new Date('2026-10-06T10:00:00')
  const buckets = bucketByDay(
    [
      { ok: true, createdAt: today9am, totalTokens: 100 },
      { ok: false, createdAt: today10am, totalTokens: 50 },
      { ok: true, createdAt: yest, totalTokens: 7 },
    ],
    NOW,
    7
  )
  const today = buckets[6]
  assert.equal(today.calls, 2)
  assert.equal(today.fails, 1)
  assert.equal(today.tokens, 150)
  assert.equal(buckets[5].calls, 1)
  assert.equal(buckets[5].tokens, 7)
})

test('统计：窗口外的样本被忽略', () => {
  const old = new Date('2026-09-01T10:00:00')
  const buckets = bucketByDay([{ ok: true, createdAt: old, totalTokens: 1 }], NOW, 7)
  assert.equal(buckets.reduce((s, b) => s + b.calls, 0), 0)
})

test('统计：按小时分桶固定 24 个且末位是当前小时', () => {
  const buckets = bucketByHour([], NOW, 24)
  assert.equal(buckets.length, 24)
  assert.equal(buckets[23].hour, '12:00')
  assert.equal(buckets[0].hour, '13:00') // 23 小时前
})

test('统计：小时分桶正确累计成功与失败', () => {
  const buckets = bucketByHour(
    [
      { ok: true, createdAt: new Date('2026-10-07T11:00:00'), totalTokens: null },
      { ok: false, createdAt: new Date('2026-10-07T11:30:00'), totalTokens: null },
    ],
    NOW,
    24
  )
  const b = buckets.find((x) => x.hour === '11:00')
  assert.equal(b?.calls, 2)
  assert.equal(b?.fails, 1)
})

test('统计：渠道用量按延迟样本数算均值，而非各组均值再平均', () => {
  const usage = aggregateByChannel([
    { ok: true, channelName: 'A', latencyMs: 100 },
    { ok: true, channelName: 'A', latencyMs: 300 },
    { ok: true, channelName: 'B', latencyMs: 1000 },
  ])
  assert.equal(usage.A.avgLatencyMs, 200)
  assert.equal(usage.B.avgLatencyMs, 1000)
  assert.equal(usage.A.calls, 2)
})

test('统计：失败请求不计入延迟均值（延迟无参考意义）', () => {
  const usage = aggregateByChannel([
    { ok: true, channelName: 'A', latencyMs: 100 },
    { ok: false, channelName: 'A', latencyMs: 9999 },
  ])
  assert.equal(usage.A.fails, 1)
  assert.equal(usage.A.avgLatencyMs, 100)
})

test('统计：空渠道名归入「（未知）」而非丢数据', () => {
  const usage = aggregateByChannel([{ ok: true, channelName: null, latencyMs: 50 }])
  assert.equal(usage['（未知）'].calls, 1)
})

test('统计：模型 TopN 并列时按名字排序保证输出稳定', () => {
  const samples = [
    { model: 'b' }, { model: 'a' }, { model: 'c' },
    { model: 'a' }, { model: 'c' },
  ]
  const top = topModels(samples, 2)
  assert.deepEqual(top, [
    { model: 'a', calls: 2 },
    { model: 'c', calls: 2 },
  ])
})

// ============================================================
// SSRF：IP 拦截判定
// ============================================================

test('SSRF：拦截 IPv4 回环/私有/链路本地', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0']) {
    assert.equal(isBlockedIp(ip), true, `${ip} 应被拦截`)
  }
})

test('SSRF：放行正常公网 IPv4', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.1.1', '223.5.5.5']) {
    assert.equal(isBlockedIp(ip), false, `${ip} 应放行`)
  }
})

test('SSRF：拦截 IPv6 回环与唯一本地地址', () => {
  assert.equal(isBlockedIp('::1'), true)
  assert.equal(isBlockedIp('::'), true)
  assert.equal(isBlockedIp('fe80::1'), true)
  assert.equal(isBlockedIp('fd00::1'), true)
  assert.equal(isBlockedIp('fc00::1'), true)
  assert.equal(isBlockedIp('2001:4860:4860::8888'), false)
})

test('SSRF：拦截 IPv4-mapped IPv6 写法（::ffff:127.0.0.1）', () => {
  // 这是绕过 IPv4 校验的经典写法：直接按 IPv6 判会漏过
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true)
  assert.equal(isBlockedIp('::ffff:10.0.0.1'), true)
  assert.equal(isBlockedIp('::ffff:1.1.1.1'), false)
})

test('SSRF：带方括号的 IPv6 字面量也能识别', () => {
  assert.equal(isBlockedIp('[::1]'), true)
})

test('SSRF：非法 IP 串不被误判为内网（交给上层处理）', () => {
  assert.equal(isBlockedIp('not-an-ip'), false)
  assert.equal(isBlockedIp('999.1.1.1'), false)
})

test('SSRF：字面量校验仍拦内网主机名与危险协议', () => {
  assert.equal(checkUpstreamUrl('http://127.0.0.1:3000').ok, false)
  assert.equal(checkUpstreamUrl('http://localhost').ok, false)
  assert.equal(checkUpstreamUrl('http://169.254.169.254').ok, false)
  assert.equal(checkUpstreamUrl('http://10.1.2.3').ok, false)
  assert.equal(checkUpstreamUrl('file:///etc/passwd').ok, false)
  assert.equal(checkUpstreamUrl('https://api.example.com').ok, true)
  // allowInternal 显式放行内网自建渠道
  assert.equal(checkUpstreamUrl('http://192.168.1.10:3000', true).ok, true)
})

test('SSRF：allowInternal 开关解析兼容多种写法', () => {
  assert.equal(allowsInternalUrl({ allowInternal: true }), true)
  assert.equal(allowsInternalUrl({ allowInternal: 'true' }), true)
  assert.equal(allowsInternalUrl({ allowInternal: 1 }), true)
  assert.equal(allowsInternalUrl({ allowInternal: false }), false)
  assert.equal(allowsInternalUrl({}), false)
  assert.equal(allowsInternalUrl(null), false)
})