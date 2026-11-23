/**
 * 滑动窗口成功率熔断单元测试（纯函数直连，零依赖）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { consumeAndCheck, WINDOW_SIZE, TRIP_RATE } = await import('../src/lib/window-breaker.ts')

test('窗口未满不触发（样本太少防误判）', () => {
  const st = { results: [] }
  // 前 WINDOW_SIZE-1 次全失败：窗口未满不触发
  for (let i = 0; i < WINDOW_SIZE - 1; i++) {
    const r = consumeAndCheck(st, false)
    assert.equal(r.tripped, false, `第 ${i + 1} 次失败未触发（未满窗）`)
  }
})

test('窗口满且成功率低于阈值 → 触发并清零窗口', () => {
  const st = { results: [] }
  // 19 失败 + 1 成功 = 5% 成功率，第 20 次触发
  for (let i = 0; i < WINDOW_SIZE - 1; i++) consumeAndCheck(st, false)
  const r = consumeAndCheck(st, false) // 第 20 次失败 → 满窗 0 成功
  assert.equal(r.tripped, true, '满窗全失败触发')
  assert.equal(st.results.length, 0, '触发后窗口清零')
})

test('抖动渠道（成功-失败交替）连败抓不到但滑窗抓得到', () => {
  const st = { results: [] }
  // 交替：10 成功 10 失败 = 50%——不低于 50% 阈值，不触发（恰好在线上）
  for (let i = 0; i < 10; i++) {
    consumeAndCheck(st, true)
    consumeAndCheck(st, false)
  }
  assert.equal(st.results.length, WINDOW_SIZE, '窗口已满')
  const r = consumeAndCheck(st, true) // 再成功一次，滑动移出最老失败 → 11 成功 9 失败 55%
  assert.equal(r.tripped, false, '55% 不触发')
  const r2 = consumeAndCheck(st, false) // 再失败 → 10/20 = 50% 边界不触发
  assert.equal(r2.tripped, false, '恰 50% 不触发（< 阈值才触发）')
  const r3 = consumeAndCheck(st, false) // 再失败 → 9/20 = 45% 触发
  assert.equal(r3.tripped, true, '45% 触发——抖动渠道被抓住')
})

test('健康渠道永不触发', () => {
  const st = { results: [] }
  // 90% 成功率跑三倍窗口
  for (let i = 0; i < WINDOW_SIZE * 3; i++) {
    const r = consumeAndCheck(st, i % 10 !== 0)
    assert.equal(r.tripped, false)
  }
})
