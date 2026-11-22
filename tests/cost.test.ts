/**
 * 费用估算单元测试（one-api billing 思想落地：请求级费用入日志）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { estimateCostUsd } = await import('../src/lib/cost.ts')

test('estimateCostUsd：标准计算（美元/百万 token）', () => {
  // priceIn=1, priceOut=3 → 1000 prompt + 2000 completion = 1/1M*1000 + 3/1M*2000 = 0.001+0.006
  const cost = estimateCostUsd({ priceIn: 1, priceOut: 3 }, { promptTokens: 1000, completionTokens: 2000 })
  assert.ok(cost !== null)
  assert.ok(Math.abs(cost - 0.007) < 1e-12)
})

test('estimateCostUsd：缺价格 → null（费用未知≠免费）', () => {
  assert.equal(estimateCostUsd({}, { promptTokens: 10, completionTokens: 20 }), null)
  assert.equal(estimateCostUsd(null, { promptTokens: 10, completionTokens: 20 }), null)
  assert.equal(estimateCostUsd({ priceIn: 1 }, { promptTokens: 10, completionTokens: 20 }), null)
  assert.equal(estimateCostUsd({ priceIn: -1, priceOut: 3 }, { promptTokens: 10, completionTokens: 20 }), null, '负价格视为未标注')
})

test('estimateCostUsd：缺 token → null', () => {
  assert.equal(estimateCostUsd({ priceIn: 1, priceOut: 3 }, { promptTokens: null, completionTokens: 20 }), null)
  assert.equal(estimateCostUsd({ priceIn: 1, priceOut: 3 }, { promptTokens: 10, completionTokens: null }), null)
})

test('estimateCostUsd：0 价格渠道合法（免费渠道成本=0）', () => {
  const cost = estimateCostUsd({ priceIn: 0, priceOut: 0 }, { promptTokens: 500, completionTokens: 500 })
  assert.equal(cost, 0)
})
