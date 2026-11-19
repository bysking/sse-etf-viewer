import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWyckoff } from './analyzer.js'
import { eventStudy } from './eventStudy.js'
import { accumulationBars, WYCKOFF_TEST_CONFIG } from '../../test-support/fixtures.js'

test('事件研究：次日开盘入场，统计前瞻收益与 MFE/MAE', () => {
  const bars = accumulationBars()
  const analysis = analyzeWyckoff(bars, WYCKOFF_TEST_CONFIG)
  const study = eventStudy(bars, analysis.events, { horizons: [5, 10], slippageBps: 2 })
  const spring = analysis.events.find((e) => e.type === 'Spring')
  const row = study.rows.find((r) => r.type === 'Spring' && r.detectedDate === spring.detectedDate)

  assert.ok(row)
  assert.equal(row.entryDate, bars[spring.detectedIndex + 1].date)
  const h5 = row.horizons[5]
  assert.ok(h5)
  assert.ok(h5.mfe >= h5.return) // 最高价必然不低于收盘价
  assert.ok(h5.mae <= h5.return) // 最低价必然不高于收盘价
  assert.ok(h5.return > 0)

  const s = study.summary.find((x) => x.type === 'Spring' && x.horizon === 5)
  assert.ok(s)
  assert.ok(s.count >= 1)
  assert.ok(s.winRate > 0)
  assert.ok(s.avgMfe >= s.avgReturn)

  // RangeStart / RangeBreak 不是交易事件，不能混进事件研究统计
  assert.ok(!study.rows.some((r) => r.type === 'RangeStart' || r.type === 'RangeBreakDown'))
})

test('事件研究：最后一个事件之后没有足够 bar 时不出行', () => {
  const bars = accumulationBars()
  const analysis = analyzeWyckoff(bars, WYCKOFF_TEST_CONFIG)
  const last = analysis.events[analysis.events.length - 1]
  const tail = analysis.events.filter((e) => e.detectedIndex >= bars.length - 1)
  const study = eventStudy(bars, tail, { horizons: [5] })
  assert.equal(study.rows.length, 0)
  assert.ok(last)
})
