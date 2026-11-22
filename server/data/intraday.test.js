import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIntraday, toWeeklyBars, TIMEFRAMES, TIMEFRAME_KEYS, timeframeOf, coverageHintOf, listTimeframes } from './intraday.js'

test('parseIntraday：解析 mink 行，open 缺失时用前一根收盘兜底', () => {
  const json = {
    code: '510300',
    total: 3,
    kline: [
      // 6 字段格式：[时间戳, open, high, low, close, volume]，分钟线 open 常为 null
      // 注意 fixture 必须 OHLC 自洽（high 最大、low 最小），否则会被健全性检查丢掉
      [20261120144500, null, 4.011, 3.995, 4.007, 204164600],
      [20261120145000, null, 4.027, 4.008, 4.026, 270603950],
      [20261120145500, 4.03, 4.032, 4.014, 4.023, 375206200],
    ],
  }
  const r = parseIntraday(json)
  assert.equal(r.bars.length, 3)
  assert.equal(r.bars[0].ts, '2026-11-20 14:45')
  assert.equal(r.bars[0].date, '2026-11-20')
  // 第一根没有前值，退回当根 low
  assert.equal(r.bars[0].open, 3.995)
  // 第二根用上一根收盘 4.007，但它低于当根 low(4.008)（跳空），夹到 4.008 才自洽
  assert.equal(r.bars[1].open, 4.008)
  // 第三根有真实 open
  assert.equal(r.bars[2].open, 4.03)
  // 所有 K 线都必须 OHLC 自洽
  for (const b of r.bars) {
    assert.ok(b.high >= Math.max(b.open, b.close, b.low), `${b.ts}: high 应最大`)
    assert.ok(b.low <= Math.min(b.open, b.close, b.high), `${b.ts}: low 应最小`)
  }
})

test('parseIntraday：7 字段（请求了 time）时不能整体错位', () => {
  // 带上 time 后接口返回 [时间戳, time=null, open, high, low, close, volume]
  // 曾经的 bug：按 6 字段解析，volume 读到了 close，表现为成交量柱等高、K 线上影线错乱
  const json = {
    kline: [
      [20261120143000, null, 3.988, 4.003, 3.984, 4.001, 688478400],
      [20261120150000, null, 4.001, 4.035, 3.995, 4.018, 1690431920],
    ],
  }
  const r = parseIntraday(json)
  assert.equal(r.bars.length, 2)
  const [a, b] = r.bars
  assert.equal(a.open, 3.988)
  assert.equal(a.high, 4.003)
  assert.equal(a.low, 3.984)
  assert.equal(a.close, 4.001)
  assert.equal(a.volume, 688478400, 'volume 必须是最后一列的成交量，不能是 close')
  assert.equal(b.volume, 1690431920)
  assert.notEqual(a.volume, b.volume, '成交量不能变成价格')
})

test('parseIntraday：字段错位导致 OHLC 不自洽时丢弃该根', () => {
  // high(4.003) < close(688478400) 这类错位数据必须被过滤，不能画出来
  const json = {
    kline: [
      [20261120143000, 3.988, 4.003, 3.984, 4.001, 688478400], // 正常 6 字段，会被误读成 high=4.003... 检查逻辑兜底
      [20261120150000, null, 4.001, 4.035, 3.995, 4.018, 1690431920], // 正常 7 字段
    ],
  }
  const r = parseIntraday(json)
  // 第一行按 6 字段解析：high=4.003, low=3.984, close=4.001, volume=688478400 → 自洽，保留
  // 关键是第二行不能因为长度不同而错位
  assert.ok(r.bars.length >= 1)
  for (const b of r.bars) {
    assert.ok(b.high >= b.low, `${b.ts} high 应 ≥ low`)
    assert.ok(b.high >= b.open && b.high >= b.close, `${b.ts} high 应是最高`)
    assert.ok(b.low <= b.open && b.low <= b.close, `${b.ts} low 应是最低`)
    assert.ok(b.volume > 1e5, `${b.ts} 成交量应是量级合理的数字，不该是价格`)
  }
})

test('parseIntraday：成交量不应退化成收盘价（回归测试）', () => {
  const rows = []
  for (let i = 0; i < 10; i++) {
    // 价格在 4 元附近小幅波动，成交量差异很大
    const close = 4 + i * 0.001
    rows.push([20261120100000 + i * 100000, 3.99 + i * 0.001, 4.01 + i * 0.001, 3.98 + i * 0.001, close, 1e8 + i * 1e7])
  }
  const r = parseIntraday({ kline: rows })
  assert.equal(r.bars.length, 10)
  const vols = r.bars.map((b) => b.volume)
  assert.equal(new Set(vols).size, 10, '成交量必须各不相同')
  assert.ok(Math.min(...vols) > 1e7, '成交量量级应是千万级，不是 4 元这种价格')
})

test('parseIntraday：过滤非法行并按时间升序', () => {
  const json = {
    kline: [
      [20261120150000, null, 4.02, 4.01, 4.018, 100],
      [20261120144000, null, 4.01, 3.99, 4.0, 200],
      ['bad', null, 1, 1, 1, 1],
      [20261120145000, null, 4.02, 4.0, 4.015, 150],
    ],
  }
  const r = parseIntraday(json)
  assert.deepEqual(
    r.bars.map((b) => b.ts),
    ['2026-11-20 14:40', '2026-11-20 14:50', '2026-11-20 15:00'],
  )
})

test('parseIntraday：空输入返回空数组', () => {
  assert.deepEqual(parseIntraday(null).bars, [])
  assert.deepEqual(parseIntraday({}).bars, [])
})

test('toWeeklyBars：按周一分组，聚合高低收与成交量', () => {
  // 2024-01-01 是周一
  const daily = [
    ['2024-01-02', 10, 11, 9.5, 10.5, 1000],
    ['2024-01-03', 10.5, 12, 10.2, 11.5, 2000],
    ['2024-01-05', 11.5, 11.8, 10.8, 11.0, 1500],
    // 下一周
    ['2024-01-08', 11.0, 11.2, 10.4, 10.6, 800],
    ['2024-01-09', 10.6, 10.9, 10.1, 10.8, 900],
  ]
  const w = toWeeklyBars(daily)
  assert.equal(w.length, 2)

  assert.equal(w[0].weekStart, '2024-01-01')
  assert.equal(w[0].open, 10)
  assert.equal(w[0].high, 12)
  assert.equal(w[0].low, 9.5)
  assert.equal(w[0].close, 11.0)
  assert.equal(w[0].volume, 4500)
  assert.equal(w[0].days, 3)
  // ts 是该周最后一根日线日期，用于区间过滤与排序
  assert.equal(w[0].ts, '2024-01-05')

  assert.equal(w[1].weekStart, '2024-01-08')
  assert.equal(w[1].open, 11.0)
  assert.equal(w[1].high, 11.2)
  assert.equal(w[1].low, 10.1)
  assert.equal(w[1].close, 10.8)
})

test('toWeeklyBars：周日归属上一周（周一为周起点）', () => {
  // 2024-01-07 是周日，应归到 2024-01-01 那一周
  const daily = [
    ['2024-01-02', 10, 11, 9, 10, 100],
    ['2024-01-07', 10, 12, 9.5, 11, 200],
    ['2024-01-08', 11, 11.5, 10.8, 11.2, 300],
  ]
  const w = toWeeklyBars(daily)
  assert.equal(w.length, 2)
  assert.equal(w[0].weekStart, '2024-01-01')
  assert.equal(w[0].days, 2)
  assert.equal(w[0].high, 12)
  assert.equal(w[1].weekStart, '2024-01-08')
})

test('toWeeklyBars：输入为空返回空数组', () => {
  assert.deepEqual(toWeeklyBars([]), [])
  assert.deepEqual(toWeeklyBars(null), [])
})

test('TIMEFRAMES：周期清单包含需求里的 6 个周期', () => {
  assert.deepEqual(TIMEFRAME_KEYS, ['1w', '1d', '60m', '30m', '15m', '5m'])
  for (const key of ['1w', '1d', '60m', '30m', '15m', '5m']) {
    assert.ok(timeframeOf(key), `${key} 应存在`)
  }
  assert.equal(timeframeOf('3m'), null)
})

test('TIMEFRAMES：分钟周期的 api 参数与实测上限一致', () => {
  const byKey = Object.fromEntries(TIMEFRAMES.map((t) => [t.key, t]))
  assert.equal(byKey['5m'].api, 5)
  assert.equal(byKey['15m'].api, 15)
  assert.equal(byKey['30m'].api, 30)
  assert.equal(byKey['60m'].api, 60)
  // 实测上限：5m=12000, 15m=4000, 30m=2000, 60m=1000
  assert.equal(byKey['5m'].maxBars, 12000)
  assert.equal(byKey['15m'].maxBars, 4000)
  assert.equal(byKey['30m'].maxBars, 2000)
  assert.equal(byKey['60m'].maxBars, 1000)
})

test('coverageHintOf：日线承诺多年，分钟线说明约 1 年', () => {
  assert.match(coverageHintOf('1d').text, /10 年/)
  assert.match(coverageHintOf('5m').text, /250 个交易日/)
  assert.equal(coverageHintOf('5m').days, 250)
  assert.equal(coverageHintOf('nope'), null)
})

test('listTimeframes：返回前端需要的元信息', () => {
  const items = listTimeframes()
  assert.equal(items.length, 6)
  for (const it of items) {
    assert.ok(it.key)
    assert.ok(it.label)
    assert.ok(it.coverage)
  }
})
