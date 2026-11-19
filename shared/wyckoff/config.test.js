import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeConfig, DEFAULT_CONFIG, validateConfig } from './config.js'

test('mergeConfig：显式 undefined 不覆盖默认值', () => {
  const c = mergeConfig({ context: undefined, shareFlow: undefined, swing: { atrMult: 1.5 } })
  assert.equal(c.shareFlow.enabled, DEFAULT_CONFIG.shareFlow.enabled)
  assert.equal(c.context.weekly.maPeriod, DEFAULT_CONFIG.context.weekly.maPeriod)
  assert.equal(c.swing.atrMult, 1.5)
  assert.equal(c.swing.atrPeriod, DEFAULT_CONFIG.swing.atrPeriod)
})

test('mergeConfig：嵌套覆盖保留兄弟默认值', () => {
  const c = mergeConfig({ context: { weekly: { maPeriod: 10 } } })
  assert.equal(c.context.weekly.maPeriod, 10)
  assert.equal(c.context.weekly.rangeWeeks, DEFAULT_CONFIG.context.weekly.rangeWeeks)
})

test('validateConfig 捕获非法阈值', () => {
  assert.deepEqual(validateConfig({ swing: { atrMult: 0.5 } }), [])
  assert.ok(validateConfig({ swing: { atrMult: -1 } }).some((e) => /atrMult/.test(e)))
  assert.ok(validateConfig({ sc: { closePos: 2 } }).some((e) => /closePos/.test(e)))
})
