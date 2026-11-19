import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWyckoff, computeShareFlow } from './analyzer.js'
import { weeklyContext, buildWeeklyBars, weekStartOf } from './structure.js'
import { accumulationBars, distributionBars, mk, WYCKOFF_TEST_CONFIG as config } from '../../test-support/fixtures.js'

const eventKey = (e) => `${e.type}|${e.occurredIndex}|${e.detectedIndex}|${e.rangeId ?? '-'}`

test('吸筹场景识别 SC / AR / ST / Spring / Test / SOS / LPS', () => {
  const bars = accumulationBars()
  const res = analyzeWyckoff(bars, config)
  const types = res.events.map((e) => e.type)
  for (const t of ['SC', 'AR', 'ST', 'Spring', 'Test', 'SOS', 'LPS']) {
    assert.ok(types.includes(t), `应识别 ${t}，实际：${types.join(', ')}`)
  }
  const sc = res.events.find((e) => e.type === 'SC')
  const spring = res.events.find((e) => e.type === 'Spring')
  const sos = res.events.find((e) => e.type === 'SOS')
  assert.ok(sc && spring && sos)
  assert.equal(sc.side, 'accumulation')
  assert.ok(spring.detectedIndex >= spring.occurredIndex)
  assert.equal(spring.rangeId, sos.rangeId)
  // Spring 的状态应为 accumulation_C，SOS 后为 accumulation_D
  assert.equal(res.states[spring.detectedIndex].phase, 'accumulation_C')
  assert.equal(res.states[sos.detectedIndex].phase, 'accumulation_D')
})

test('派发场景识别 BC / AR / ST / UTAD / SOW / LPSY', () => {
  const bars = distributionBars()
  const res = analyzeWyckoff(bars, config)
  const types = res.events.map((e) => e.type)
  for (const t of ['BC', 'AR', 'ST', 'UTAD', 'SOW', 'LPSY']) {
    assert.ok(types.includes(t), `应识别 ${t}，实际：${types.join(', ')}`)
  }
  const utad = res.events.find((e) => e.type === 'UTAD')
  const sow = res.events.find((e) => e.type === 'SOW')
  assert.equal(utad.side, 'distribution')
  assert.equal(res.states[utad.detectedIndex].phase, 'distribution_C')
  assert.equal(res.states[sow.detectedIndex].phase, 'distribution_D')
})

test('截断未来数据后，过去的信号完全不变（无未来函数）', () => {
  const bars = accumulationBars()
  const full = analyzeWyckoff(bars, config)
  for (const k of [40, 75, 82, 90, bars.length - 1]) {
    const part = analyzeWyckoff(bars.slice(0, k), config)
    const a = full.events.filter((e) => e.detectedIndex < k).map(eventKey).sort()
    const b = part.events.map(eventKey).sort()
    assert.deepEqual(b, a, `截断到 ${k} 根时事件不一致`)
  }
})

test('SC 的事件双时间：occurredAt 是价格发生日，detectedAt 是确认日', () => {
  const bars = accumulationBars()
  const res = analyzeWyckoff(bars, config)
  const sc = res.events.find((e) => e.type === 'SC')
  assert.ok(sc)
  assert.equal(sc.occurredDate, bars[sc.occurredIndex].date)
  assert.equal(sc.detectedDate, bars[sc.detectedIndex].date)
  assert.ok(sc.detectedIndex >= sc.occurredIndex)
})

test('周线背景只使用上一完整周', () => {
  // 三周，每周 5 个工作日
  const weeks = [
    ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'],
    ['2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12'],
    ['2024-01-15', '2024-01-16', '2024-01-17', '2024-01-18', '2024-01-19'],
  ]
  const bars = []
  weeks.forEach((dates, w) => {
    dates.forEach((date, d) => {
      const c = 10 + w * 2 + d * 0.2
      bars.push({ date, open: c - 0.1, high: c + 0.4, low: c - 0.4, close: c, volume: 1_000_000 })
    })
  })
  const ctx = weeklyContext(bars, { context: { weekly: { maPeriod: 2, rangeWeeks: 2 } } })
  const wed = ctx[7] // 第二周周三
  assert.equal(wed.weekEnd, bars[4].date)
  const fri = ctx[9] // 第二周周五
  assert.equal(fri.weekEnd, bars[9].date)
  assert.equal(weekStartOf(bars[9].date), weekStartOf(bars[5].date))
  assert.equal(buildWeeklyBars(bars).length, 3)
})

test('份额流对齐与新鲜度', () => {
  const bars = [0, 1, 2, 3, 4].map((i) => mk(i, 10, 10.5, 9.5, 10, 1000))
  const shares = [
    [bars[0].date, 100],
    [bars[1].date, 110],
  ]
  const flow = computeShareFlow(bars, shares, { shareFlow: { cumulativeDays: 2, staleMaxDays: 2, zWindow: 5 } })
  assert.equal(flow.rows[0].value, 100)
  assert.equal(flow.rows[0].fresh, true)
  assert.equal(flow.rows[1].value, 110)
  assert.equal(flow.rows[1].delta, 10)
  assert.equal(flow.rows[2].staleDays, 1)
  assert.equal(flow.rows[2].fresh, true)
  assert.equal(flow.rows[3].staleDays, 2)
  assert.equal(flow.rows[3].fresh, true)
  assert.equal(flow.rows[4].staleDays, 3)
  assert.equal(flow.rows[4].fresh, false)
  // 第 4 天相对第 2 天：110 - 110 = 0
  assert.equal(flow.rows[4].cum, 0)
})
