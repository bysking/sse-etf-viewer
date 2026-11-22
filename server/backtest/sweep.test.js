import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandGrid, setPath, touchesWyckoff, rankRobust, sweepBacktest } from './sweep.js'
import { analyzeWyckoff } from '../../shared/wyckoff/analyzer.js'
import { accumulationBars, WYCKOFF_TEST_CONFIG } from '../../test-support/fixtures.js'

const strategy = {
  symbol: '510300',
  entry: {
    all: [
      { event: 'Spring', withinBars: 5 },
      { phase: { in: ['accumulation_C', 'accumulation_D'], minConfidence: 0.5 } },
    ],
  },
  exit: {
    any: [{ event: 'SOS', withinBars: 4 }, { stopLoss: { reference: 'eventLow', event: 'Spring', bufferAtr: 0.5 } }],
  },
  execution: { position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1 }, lotSize: 100, minFee: 5, feeRate: 0.0003, slippageBps: 2 },
  wyckoff: WYCKOFF_TEST_CONFIG,
}

test('expandGrid 展开笛卡尔积', () => {
  const combos = expandGrid([
    { path: 'wyckoff.spring.maxBreakAtr', values: [0.5, 1.0] },
    { path: 'execution.position.riskPct', values: [0.01, 0.02] },
  ])
  assert.equal(combos.length, 4)
  assert.ok(combos.some((c) => c['wyckoff.spring.maxBreakAtr'] === 1.0 && c['execution.position.riskPct'] === 0.02))
  assert.deepEqual(expandGrid([]), [{}])
})

test('expandGrid 拒绝非法与超量输入', () => {
  assert.throws(() => expandGrid([{ values: [1] }]), /path/)
  assert.throws(() => expandGrid([{ path: 'a', values: [] }]), /values/)
  assert.throws(() => expandGrid([{ path: 'a', values: Array.from({ length: 25 }, (_, i) => i) }]), /上限/)
  const wide = [
    { path: 'a', values: [1, 2, 3, 4, 5] },
    { path: 'b', values: [1, 2, 3, 4, 5] },
    { path: 'c', values: [1, 2, 3, 4, 5] },
    { path: 'd', values: [1, 2, 3, 4, 5] },
  ]
  assert.throws(() => expandGrid(wide), /超过 200/)
})

test('setPath 写入嵌套路径且不改原对象', () => {
  const base = { a: { b: 1 } }
  const out = setPath(base, 'a.c', 2)
  assert.equal(out.a.c, 2)
  assert.equal(out.a.b, 1)
  assert.equal(base.a.c, undefined, '原对象不应被修改')

  const deep = setPath({}, 'x.y.z', 9)
  assert.equal(deep.x.y.z, 9)
})

test('touchesWyckoff 判断是否需要重新分析', () => {
  assert.equal(touchesWyckoff([{ path: 'wyckoff.spring.maxBreakAtr', values: [1] }]), true)
  assert.equal(touchesWyckoff([{ path: 'execution.position.riskPct', values: [0.01] }]), false)
})

test('sweepBacktest：训练/验证分段统计并返回结果', () => {
  const bars = accumulationBars()
  const mid = bars[Math.floor(bars.length * 0.75)].date
  const r = sweepBacktest({
    bars,
    strategy,
    grid: [{ path: 'execution.position.riskPct', values: [0.01, 0.05] }],
    trainEnd: mid,
    initialCash: 100000,
  })
  assert.equal(r.combos, 2)
  assert.equal(r.reanalyzed, false, '仅执行参数变化时复用分析结果')
  assert.equal(r.results.length, 2)
  for (const item of r.results) {
    assert.ok(item.params['execution.position.riskPct'])
    assert.ok(item.train && item.validation)
  }
})

test('sweepBacktest：wyckoff 参数变化触发重新分析', () => {
  const bars = accumulationBars()
  const mid = bars[Math.floor(bars.length * 0.75)].date
  const r = sweepBacktest({
    bars,
    strategy,
    grid: [{ path: 'wyckoff.spring.maxBreakAtr', values: [0.5, 1.5] }],
    trainEnd: mid,
  })
  assert.equal(r.reanalyzed, true)
  assert.equal(r.results.length, 2)
})

test('sweepBacktest：缺少 trainEnd 或 bars 时报错', () => {
  assert.throws(() => sweepBacktest({ bars: [], grid: [], trainEnd: '2024-01-01' }), /bars/)
  assert.throws(() => sweepBacktest({ bars: accumulationBars(), grid: [] }), /trainEnd/)
})

test('rankRobust：按两段较小收益排序，并标记验证段缺失', () => {
  const results = [
    { params: { a: 1 }, train: { totalReturn: 0.3, tradeCount: 3 }, validation: { totalReturn: 0.05 } },
    { params: { a: 2 }, train: { totalReturn: 0.1, tradeCount: 3 }, validation: { totalReturn: 0.12 } },
    { params: { a: 3 }, train: { totalReturn: 0.5, tradeCount: 0 }, validation: { totalReturn: 0.4 } },
    { params: { a: 4 }, train: { totalReturn: 0.2, tradeCount: 2 }, validation: { totalReturn: null } },
    { params: { a: 5 }, error: 'boom' },
  ]
  const ranked = rankRobust(results, { minTrades: 1 })
  // a=2 两段都稳（min 0.1）胜出；a=1 受验证段拖累（min 0.05）
  assert.equal(ranked[0].params.a, 2)
  assert.equal(ranked[1].params.a, 1)
  // 交易数不足的被过滤
  assert.ok(!ranked.some((r) => r.params.a === 3))
  // 出错的不参与
  assert.ok(!ranked.some((r) => r.params.a === 5))
  // 验证段缺失的标记出来
  const missing = ranked.find((r) => r.params.a === 4)
  assert.equal(missing.validationMissing, true)
})

test('sweepBacktest 结果按训练段收益降序', () => {
  const bars = accumulationBars()
  const mid = bars[Math.floor(bars.length * 0.8)].date
  const r = sweepBacktest({
    bars,
    strategy,
    grid: [{ path: 'execution.position.riskPct', values: [0.005, 0.02] }],
    trainEnd: mid,
  })
  const returns = r.results.map((x) => x.train?.totalReturn).filter((v) => v != null)
  const sorted = [...returns].sort((a, b) => b - a)
  assert.deepEqual(returns, sorted)
})
