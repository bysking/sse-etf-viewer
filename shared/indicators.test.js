import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atr, ema, pctChange, rsi, rollingMax, rollingMin, sma, stddev, zscore } from './indicators.js'

test('sma 处理窗口与空值', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
  // 空值离开窗口后，后续窗口可以恢复
  assert.deepEqual(sma([1, null, 3, 4, 5], 3), [null, null, null, null, 4])
  assert.deepEqual(sma([], 3), [])
})

test('ema 种子与递推', () => {
  const out = ema([1, 2, 3, 4, 5], 3)
  assert.equal(out[0], null)
  assert.equal(out[1], null)
  assert.equal(out[2], 2) // 种子 = (1+2+3)/3
  // k=0.5，下一根 = 4*0.5 + 2*0.5 = 3
  assert.equal(out[3], 3)
  assert.equal(out[4], 4)
})

test('atr 使用 Wilder 平滑', () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10 },
    { high: 12, low: 10, close: 11 },
    { high: 14, low: 11, close: 13 },
  ]
  const out = atr(bars, 2)
  assert.equal(out[0], null)
  assert.equal(out[1], 2) // 前两根 TR: 2, 2
  // 第三根 TR=2，ATR=(2*1+2)/2=2
  assert.equal(out[2], 2)
  // 第四根 TR=max(3, |14-11|=3, |11-11|=0)=3，ATR=(2+3)/2=2.5
  assert.equal(out[3], 2.5)
})

test('stddev / zscore', () => {
  const sd = stddev([1, 2, 3, 4, 5], 5)
  assert.equal(sd[4], Math.sqrt(2))
  const z = zscore([1, 2, 3, 4, 5], 5)
  assert.equal(z[4], 2 / Math.sqrt(2))
  assert.equal(z[0], null)
  // 方差为 0 时返回 0，避免 NaN
  assert.equal(zscore([2, 2, 2], 3)[2], 0)
})

test('rolling max/min 与 pctChange', () => {
  assert.deepEqual(rollingMax([1, 3, 2, 5], 2), [null, 3, 3, 5])
  assert.deepEqual(rollingMin([1, 3, 2, 0], 2), [null, 1, 2, 0])
  const pc = pctChange([100, 110, 99], 1)
  assert.equal(pc[0], null)
  assert.ok(Math.abs(pc[1] - 0.1) < 1e-12)
  assert.ok(Math.abs(pc[2] + 0.1) < 1e-12)
})

test('rsi 边界：持续上涨为 100', () => {
  const out = rsi([1, 2, 3, 4, 5, 6], 3)
  assert.equal(out[2], 100)
  assert.equal(out[5], 100)
})
