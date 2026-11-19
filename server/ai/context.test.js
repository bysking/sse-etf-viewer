import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWyckoff } from '../../shared/wyckoff/analyzer.js'
import { eventStudy } from '../../shared/wyckoff/eventStudy.js'
import { buildMarketContext } from './context.js'
import { accumulationBars, WYCKOFF_TEST_CONFIG } from '../../test-support/fixtures.js'

test('上下文包含阶段、事件、统计和受限的近期 K 线', () => {
  const bars = accumulationBars()
  const analysis = analyzeWyckoff(bars, WYCKOFF_TEST_CONFIG)
  const study = eventStudy(bars, analysis.events, { horizons: [10, 20] })
  const ctx = buildMarketContext({
    code: '510300',
    start: bars[0].date,
    end: bars[bars.length - 1].date,
    bars,
    analysis,
    study,
    maxBars: 10,
    maxEvents: 5,
  })
  assert.equal(ctx.summary.code, '510300')
  assert.equal(ctx.summary.bars, bars.length)
  assert.ok(ctx.summary.phase)
  assert.ok(ctx.summary.eventCounts.Spring >= 1)
  assert.ok(ctx.summary.latestEvents.length <= 5)
  assert.ok(ctx.summary.eventStats.length > 0)
  assert.match(ctx.text, /【标的】510300/)
  assert.match(ctx.text, /【当前阶段】/)
  assert.match(ctx.text, /【事件研究/)
  const barLines = ctx.text.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2},/.test(l))
  assert.equal(barLines.length, 10)
})

test('份额流存在时进入上下文', () => {
  const bars = accumulationBars()
  const shares = [
    [bars[bars.length - 3].date, 1000],
    [bars[bars.length - 2].date, 1050],
    [bars[bars.length - 1].date, 1100],
  ]
  const analysis = analyzeWyckoff(bars, WYCKOFF_TEST_CONFIG, { shares })
  const ctx = buildMarketContext({ code: '510300', start: bars[0].date, end: bars.at(-1).date, bars, analysis, maxBars: 5 })
  assert.match(ctx.text, /【份额流】/)
})
