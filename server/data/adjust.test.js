import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyForwardAdjust, detectDividends, sliceSeries } from './adjust.js'

const mk = (date, open, high, low, close) => [date, open, high, low, close, 1000]

test('applyForwardAdjust：除息日之前的价格被按比例上调，之后不变', () => {
  const series = [
    mk('2024-01-02', 10, 10.2, 9.9, 10),
    mk('2024-01-03', 10.1, 10.3, 10, 10.2),
    mk('2024-01-04', 9.8, 9.9, 9.7, 9.8), // 除息日：相对前收 10.2 低开约 -3.92%
    mk('2024-01-05', 9.85, 9.95, 9.8, 9.9),
  ]
  const { series: adj, applied } = applyForwardAdjust(series, ['2024-01-04'])
  assert.equal(applied.length, 1)
  assert.ok(applied[0].gapPct < 0)
  // 除息日之后保持原值
  assert.equal(adj[2][4], 9.8)
  assert.equal(adj[3][4], 9.9)
  // 除息日之前整体上调，缺口被抹平
  const ratio = applied[0].ratio
  assert.ok(Math.abs(adj[1][4] - 10.2 * ratio) < 1e-9)
  assert.ok(Math.abs(adj[0][4] - 10 * ratio) < 1e-9)
  // 调整后：前收与当日开盘的相对关系应恢复
  const newGap = adj[2][1] / adj[1][4] - 1
  assert.ok(Math.abs(newGap) < 1e-9, `调整后跳空应为 0，实际 ${newGap}`)
  // 原始数组不被修改
  assert.equal(series[1][4], 10.2)
})

test('applyForwardAdjust：多个除息日累乘', () => {
  const series = [
    mk('2023-01-02', 10, 10, 10, 10),
    mk('2023-01-03', 9.7, 9.7, 9.7, 9.7), // -3%
    mk('2023-01-04', 9.7, 9.7, 9.7, 9.7),
    mk('2023-01-05', 9.4, 9.4, 9.4, 9.4), // 再 -3.09%
    mk('2023-01-06', 9.4, 9.4, 9.4, 9.4),
  ]
  const { series: adj, applied } = applyForwardAdjust(series, ['2023-01-03', '2023-01-05'])
  assert.equal(applied.length, 2)
  // 最早一根累计两次缩放
  const expected = 10 * applied[0].ratio * applied[1].ratio
  assert.ok(Math.abs(adj[0][4] - expected) < 1e-9)
})

test('applyForwardAdjust：无除息日时原样返回', () => {
  const series = [mk('2024-01-02', 10, 10, 10, 10)]
  const r = applyForwardAdjust(series, [])
  assert.deepEqual(r.series, series)
  assert.equal(r.applied.length, 0)
})

test('applyForwardAdjust：忽略越界和不合法日期', () => {
  const series = [mk('2024-01-02', 10, 10, 10, 10), mk('2024-01-03', 10, 10, 10, 10)]
  const r = applyForwardAdjust(series, ['2030-01-01', 'bad-date'])
  assert.equal(r.applied.length, 0)
})

test('detectDividends：只识别 ETF 相对指数的额外低开', () => {
  const idx = [
    mk('2024-01-02', 100, 100, 100, 100),
    mk('2024-01-03', 100, 100, 100, 100), // 指数平开
    mk('2024-01-04', 98, 98, 98, 98), // 指数低开 -2%（市场下跌）
    mk('2024-01-05', 98, 98, 98, 98),
  ]
  const etf = [
    mk('2024-01-02', 10, 10, 10, 10),
    mk('2024-01-03', 9.65, 9.65, 9.65, 9.65), // 额外低开 -3.5%（除息）
    mk('2024-01-04', 9.65 * 0.98, 9.65 * 0.98, 9.65 * 0.98, 9.65 * 0.98), // 跟随指数 -2%，不是除息
    mk('2024-01-05', 9.65 * 0.98, 9.65 * 0.98, 9.65 * 0.98, 9.65 * 0.98),
  ]
  const found = detectDividends(etf, idx, { minExtraGap: 0.008, minGap: 0.008 })
  assert.equal(found.length, 1)
  assert.equal(found[0].date, '2024-01-03')
  assert.ok(found[0].dropPct > 3)
  assert.ok(found[0].amount > 0)
  assert.equal(found[0].indexGapPct, 0)
})

test('detectDividends：默认阈值 2% 过滤掉小幅噪声', () => {
  const idx = [mk('2024-01-02', 100, 100, 100, 100), mk('2024-01-03', 100, 100, 100, 100)]
  const small = [mk('2024-01-02', 10, 10, 10, 10), mk('2024-01-03', 9.9, 9.9, 9.9, 9.9)] // -1%
  assert.equal(detectDividends(small, idx).length, 0, '1% 不应被默认识别')
  assert.equal(detectDividends(small, idx, { minExtraGap: 0.008, minGap: 0.008 }).length, 1, '降低阈值后可识别')
})

test('detectDividends：同一年出现过多候选时只保留幅度最大的', () => {
  // 每个跳空日的前一天都回到 10 元，保证各笔缺口互相独立
  const idx = [mk('2024-03-01', 100, 100, 100, 100)]
  const etf = [mk('2024-03-01', 10, 10, 10, 10)]
  const drops = [0.96, 0.97, 0.975, 0.978] // -4% -3% -2.5% -2.2%
  drops.forEach((d, k) => {
    const date = `2024-03-0${k + 2}`
    // 正常日：平盘，收在前一日 10 元
    idx.push(mk(date, 100, 100, 100, 100))
    etf.push(mk(date, 10 * d, 10 * d, 10 * d, 10 * d))
    // 次日恢复，避免影响下一笔判断
    const nextDate = `2024-03-1${k}`
    idx.push(mk(nextDate, 100, 100, 100, 100))
    etf.push(mk(nextDate, 10, 10, 10, 10))
  })
  const found = detectDividends(etf, idx, { minExtraGap: 0.015, minGap: 0.015, maxPerYear: 2 })
  assert.equal(found.length, 2)
  // 保留跌幅更大的两笔（-4% 和 -3%）
  assert.ok(found.every((f) => f.dropPct >= 3))
})

test('detectDividends：指数同步下跌不算除息', () => {
  const idx = [mk('2024-01-02', 100, 100, 100, 100), mk('2024-01-03', 95, 95, 95, 95)]
  const etf = [mk('2024-01-02', 10, 10, 10, 10), mk('2024-01-03', 9.5, 9.5, 9.5, 9.5)]
  assert.equal(detectDividends(etf, idx).length, 0)
})

test('detectDividends：空输入返回空数组', () => {
  assert.deepEqual(detectDividends([], []), [])
  assert.deepEqual(detectDividends(null, null), [])
})

test('sliceSeries 按日期闭区间切片', () => {
  const s = [mk('2024-01-01', 1, 1, 1, 1), mk('2024-01-02', 1, 1, 1, 1), mk('2024-01-03', 1, 1, 1, 1)]
  assert.equal(sliceSeries(s, '2024-01-02', '2024-01-03').length, 2)
  assert.equal(sliceSeries(s, '2024-01-02', '2024-01-02').length, 1)
})
