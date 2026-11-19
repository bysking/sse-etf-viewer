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

test('默认参数保持 2026-11-19 校准结果', () => {
  const c = mergeConfig({})
  assert.equal(c.spring.maxBreakAtr, 1.0)
  assert.equal(c.spring.confirmBars, 5)
  assert.equal(c.utad.maxBreakAtr, 1.0)
  assert.equal(c.sc.volZ, 1.2)
  assert.equal(c.sc.spreadAtr, 1.0)
  assert.equal(c.bc.volZ, 1.2)
  assert.equal(c.ar.reboundAtr, 1.2)
  assert.equal(c.ar.maxBars, 15)
  // SOS/SOW 在样本外检验中放宽无效，恢复旧阈值
  assert.equal(c.sos.volZ, 0.5)
  assert.equal(c.sos.breakAtr, 0.3)
  assert.equal(c.sow.volZ, 1.0)
  assert.equal(c.sow.closePos, 0.3)
  assert.equal(c.sow.breakAtr, 0.3)
  assert.equal(c.range.sideLookbackBars, 60)
  assert.equal(c.range.sideMinReturn, 0.05)
})

test('validateConfig 捕获非法阈值', () => {
  assert.deepEqual(validateConfig({ swing: { atrMult: 0.5 } }), [])
  assert.ok(validateConfig({ swing: { atrMult: -1 } }).some((e) => /atrMult/.test(e)))
  assert.ok(validateConfig({ sc: { closePos: 2 } }).some((e) => /closePos/.test(e)))
})
