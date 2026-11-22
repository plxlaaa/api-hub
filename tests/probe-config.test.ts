/**
 * 探测配置化单元测试（零外部依赖，直接测纯函数模块）
 * 覆盖：渠道级 probeMode=off 过滤、探测间隔环境变量 clamp
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { selectProbeTargets, resolveProbeIntervalMs } = await import('../src/lib/probe-config.ts')

test('selectProbeTargets：probeMode=off 渠道被跳过', () => {
  const chans = [
    { id: 'a', metadata: { probeMode: 'off' } },
    { id: 'b', metadata: { probeMode: 'on' } },
    { id: 'c', metadata: null },
    { id: 'd', metadata: {} },
    { id: 'e', metadata: { other: 'x' } },
  ]
  const ids = selectProbeTargets(chans).map((c) => c.id)
  assert.deepEqual(ids, ['b', 'c', 'd', 'e'], '仅显式 off 被跳过')
})

test('selectProbeTargets：metadata 非对象（字符串/数字/undefined）不炸', () => {
  const chans = [
    { id: 'a', metadata: 'garbage' },
    { id: 'b', metadata: 42 },
    { id: 'c', metadata: undefined },
  ]
  const ids = selectProbeTargets(chans as never).map((c) => c.id)
  assert.deepEqual(ids, ['a', 'b', 'c'], '畸形 metadata 视为正常探测')
})

test('selectProbeTargets：probeMode 非严格小写 off 不误判', () => {
  const chans = [
    { id: 'a', metadata: { probeMode: 0 } },
    { id: 'b', metadata: { probeMode: false } },
    { id: 'c', metadata: { probeMode: 'OFF' } },
  ]
  const ids = selectProbeTargets(chans).map((c) => c.id)
  assert.deepEqual(ids, ['a', 'b', 'c'], '仅严格小写 off 跳过')
})

test('探测间隔 clamp：非法回退 60s，上下限 10s~1h', () => {
  const cases: Array<[string | undefined, number]> = [
    [undefined, 60_000],
    ['abc', 60_000],
    ['-5', 60_000],
    ['0', 60_000],
    ['30000', 30_000],
    ['5000', 10_000],
    ['999999999', 3_600_000],
  ]
  for (const [raw, expected] of cases) {
    assert.equal(resolveProbeIntervalMs(raw), expected, `GW_PROBE_INTERVAL_MS=${String(raw)}`)
  }
})
