import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWyckoff } from '../../shared/wyckoff/analyzer.js'
import { runBacktest, sizePosition } from './engine.js'
import { accumulationBars, WYCKOFF_TEST_CONFIG } from '../../test-support/fixtures.js'

const strategy = {
  entry: {
    all: [
      { event: 'Spring', withinBars: 5 },
      { phase: { in: ['accumulation_C', 'accumulation_D'], minConfidence: 0.5 } },
    ],
  },
  exit: {
    any: [
      { event: 'SOS', withinBars: 3 },
      { stopLoss: { reference: 'eventLow', event: 'Spring', bufferAtr: 0.5 } },
    ],
  },
  execution: {
    position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1.0 },
    feeRate: 0.0003,
    minFee: 5,
    slippageBps: 2,
    lotSize: 100,
    cancelIfInvalidated: true,
  },
}

function setup() {
  const bars = accumulationBars()
  const analysis = analyzeWyckoff(bars, WYCKOFF_TEST_CONFIG)
  return { bars, analysis }
}

test('回测：Spring 入场、SOS 出场，按次日开盘成交', () => {
  const { bars, analysis } = setup()
  const res = runBacktest({ bars, analysis, strategy, initialCash: 100000 })
  assert.equal(res.trades.length, 2)
  const [buy, sell] = res.trades
  const spring = analysis.events.find((e) => e.type === 'Spring')
  const sos = analysis.events.find((e) => e.type === 'SOS')
  assert.ok(spring && sos)

  assert.equal(buy.side, 'buy')
  assert.equal(buy.signalIndex, spring.detectedIndex)
  // 信号日 T，成交日 T+1 开盘
  assert.equal(buy.date, bars[spring.detectedIndex + 1].date)
  assert.ok(Math.abs(buy.price - bars[spring.detectedIndex + 1].open * 1.0002) < 1e-9)
  assert.equal(buy.qty % 100, 0)

  assert.equal(sell.side, 'sell')
  assert.equal(sell.signalIndex, sos.detectedIndex)
  assert.equal(sell.date, bars[sos.detectedIndex + 1].date)
  assert.ok(Math.abs(sell.price - bars[sos.detectedIndex + 1].open * 0.9998) < 1e-9)
  assert.ok(sell.pnl > 0, `期望盈利，实际 ${sell.pnl}`)

  assert.ok(res.metrics.totalReturn > 0)
  assert.equal(res.metrics.tradeCount, 1)
  assert.equal(res.metrics.winRate, 1)
  assert.ok(res.metrics.maxDrawdown <= 0)
  assert.ok(res.equity.length === bars.length)
  assert.equal(res.cancelled.length, 0)
})

test('回测：次日开盘跌破结构失效位时取消入场', () => {
  const { bars, analysis } = setup()
  const spring = analysis.events.find((e) => e.type === 'Spring')
  const entryBar = spring.detectedIndex + 1
  const stop = spring.price - 0.5 * analysis.states[spring.detectedIndex].atr
  bars[entryBar] = { ...bars[entryBar], open: stop - 1, high: Math.max(stop, bars[entryBar].high), low: Math.min(stop - 1, bars[entryBar].low) }
  const res = runBacktest({ bars, analysis, strategy, initialCash: 100000 })
  assert.equal(res.trades.length, 0)
  assert.equal(res.cancelled.length, 1)
  assert.equal(res.cancelled[0].reason, 'invalidatedAtOpen')
  assert.equal(res.metrics.totalReturn, 0)
})

test('回测：手续费与滑点计入，T+1 不允许同日卖出', () => {
  const { bars, analysis } = setup()
  const res = runBacktest({ bars, analysis, strategy, initialCash: 100000 })
  const [buy, sell] = res.trades
  assert.ok(buy.fee >= 5)
  assert.ok(sell.fee >= 5)
  assert.ok(buy.date > buy.signalDate)
  assert.ok(sell.date > sell.signalDate)
})

test('仓位计算：浮点误差不应少买一档', () => {
  // 100000 × 1% / (4.0 - 3.8) = 4999.999999999995，直接 floor 会算成 4900
  const ex = { position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1 }, lotSize: 100 }
  assert.equal(sizePosition({ equity: 100000, entryRef: 4.0, stopLevel: 3.8, ex }), 5000)
  // 全仓同样受最小单位约束
  assert.equal(
    sizePosition({ equity: 100000, entryRef: 4.0, stopLevel: null, ex: { position: { type: 'allIn' }, lotSize: 100 } }),
    25000,
  )
  // 止损位不低于入场价时不开仓
  assert.equal(sizePosition({ equity: 100000, entryRef: 4.0, stopLevel: 4.0, ex }), 0)
  assert.equal(sizePosition({ equity: 100000, entryRef: 4.0, stopLevel: null, ex }), 0)
})

test('回测：非法成交模式直接报错', () => {
  const { bars, analysis } = setup()
  assert.throws(
    () => runBacktest({ bars, analysis, strategy: { ...strategy, execution: { ...strategy.execution, fillAt: 'close' } } }),
    /仅支持 T\+1 开盘成交/,
  )
})
