import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateStrategyConfig } from './validate.js'

const base = () => ({
  symbol: '510300',
  wyckoff: { spring: { maxBreakAtr: 1.0 } },
  entry: {
    all: [
      { event: 'Spring', withinBars: 5, require: { closeBackInRange: true } },
      { phase: { in: ['accumulation_C', 'accumulation_D'], minConfidence: 0.5 } },
    ],
  },
  exit: {
    any: [
      { event: 'SOS', withinBars: 4 },
      { stopLoss: { reference: 'eventLow', event: 'Spring', bufferAtr: 0.5 } },
    ],
  },
  execution: {
    fillAt: 'nextOpen',
    position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1 },
    feeRate: 0.0003,
    lotSize: 100,
  },
})

test('合法策略通过校验', () => {
  assert.deepEqual(validateStrategyConfig(base()), [])
})

test('未知事件类型被拒绝', () => {
  const c = base()
  c.entry.all[0].event = 'MagicSpring'
  const errors = validateStrategyConfig(c)
  assert.ok(errors.some((e) => /类型不支持/.test(e)), JSON.stringify(errors))
})

test('riskBased 仓位缺少 stopLoss 被拒绝', () => {
  const c = base()
  delete c.exit.any[1]
  assert.ok(validateStrategyConfig(c).some((e) => /必须.*stopLoss/.test(e)))
})

test('allIn 允许没有 stopLoss', () => {
  const c = base()
  c.execution.position = { type: 'allIn', maxPositionPct: 1 }
  delete c.exit.any[1]
  assert.deepEqual(validateStrategyConfig(c), [])
})

test('entry 只有 stopLoss 不算触发条件', () => {
  const c = base()
  c.entry = { any: [{ stopLoss: { reference: 'rangeLow', bufferAtr: 0.5 } }] }
  assert.ok(validateStrategyConfig(c).some((e) => /至少需要一个/.test(e)))
})

test('未知条件节点与非法执行参数被拒绝', () => {
  const c = base()
  c.entry.all.push({ magic: { value: 1 } })
  c.execution.fillAt = 'close'
  const errors = validateStrategyConfig(c)
  assert.ok(errors.some((e) => /不支持的条件/.test(e)))
  assert.ok(errors.some((e) => /fillAt/.test(e)))
})

test('shareFlow 条件与周线条件可组合', () => {
  const c = base()
  c.entry.all.push({ shareFlow: { cumulativeDays: 3, gt: 0, requireFresh: true } })
  c.entry.all.push({ weekly: { phaseIn: ['accumulation', 'markup'], closeAboveMa: true } })
  assert.deepEqual(validateStrategyConfig(c), [])
})
