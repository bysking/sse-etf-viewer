import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWyckoff } from './analyzer.js'
import { weeklyEvents, buildWeeklyBars } from './structure.js'
import { accumulationBars } from '../../test-support/fixtures.js'

/** 构造足够长的日线，保证有 30 周以上 */
function longBars(weeks = 60) {
  const bars = []
  const start = Date.UTC(2023, 0, 2)
  let i = 0
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 5; d++) {
      const date = new Date(start + (w * 7 + d) * 864e5).toISOString().slice(0, 10)
      // 前 2/3 缓跌、后 1/3 反弹，制造可识别的结构
      const base = w < weeks * 0.66 ? 100 - w * 0.8 : 100 - weeks * 0.66 * 0.8 + (w - weeks * 0.66) * 1.2
      bars.push({
        date,
        open: base,
        high: base + 1.5,
        low: base - 1.5,
        close: base + (d % 2 ? 0.4 : -0.3),
        volume: 1_000_000 + (w % 5) * 200_000,
      })
      i++
    }
  }
  return bars
}

test('weeklyEvents 默认关闭时返回空', () => {
  const bars = longBars()
  assert.deepEqual(weeklyEvents(bars, {}, analyzeWyckoff), [])
  assert.deepEqual(weeklyEvents(bars, { context: { weekly: { events: true } } }), [], '未注入 analyzer 时安全返回空')
})

test('weeklyEvents 开启后返回周线周期事件', () => {
  const bars = longBars()
  const events = weeklyEvents(bars, { context: { weekly: { events: true } } }, analyzeWyckoff)
  assert.ok(Array.isArray(events))
  for (const e of events) {
    assert.equal(e.timeframe, 'weekly')
    assert.ok(e.detectedDate)
    assert.ok(e.type)
  }
  // 数据不足 30 周时返回空，避免不可靠的统计
  const short = longBars(10)
  assert.deepEqual(weeklyEvents(short, { context: { weekly: { events: true } } }, analyzeWyckoff), [])
})

test('周线事件按 as-of 挂到日线状态，不使用未收盘周', () => {
  const bars = longBars(40)
  const analysis = analyzeWyckoff(bars, { context: { weekly: { enabled: true, events: true } } })
  // 每个 state 上的周线事件都必须早于或等于当日
  for (const st of analysis.states) {
    for (const e of st.weeklyEvents || []) {
      assert.ok(e.detectedDate <= st.date, `事件 ${e.detectedDate} 不应晚于当日 ${st.date}`)
    }
  }
})

test('周线事件不影响日线事件识别', () => {
  const bars = longBars(40)
  const without = analyzeWyckoff(bars, { context: { weekly: { enabled: true } } })
  const withEvents = analyzeWyckoff(bars, { context: { weekly: { enabled: true, events: true } } })
  assert.equal(without.events.length, withEvents.events.length, '日线事件数量不应因周线事件开关而变化')
})

test('buildWeeklyBars 周聚合正确', () => {
  const bars = accumulationBars().slice(0, 30)
  const weekly = buildWeeklyBars(bars)
  assert.ok(weekly.length > 0)
  for (const w of weekly) {
    assert.ok(w.weekEnd >= w.weekStart)
    assert.ok(w.high >= w.low)
  }
})
