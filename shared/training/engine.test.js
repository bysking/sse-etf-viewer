import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOT_SIZE,
  RATIO_PRESETS,
  normalizeRatio,
  qtyForBuy,
  qtyForSell,
  applyBuy,
  applySell,
  snapshotOf,
  visibleSlice,
  summarizeSession,
} from './engine.js'

test('qtyForBuy：按现金比例且向下取整到 100 份', () => {
  // 现金 100000，30% -> 30000 预算，价格 3.48 -> 8620.6 份 -> 8600
  assert.equal(qtyForBuy({ cash: 100000, price: 3.48, positionPct: 0.3 }), 8600)
  // 刚好整手
  assert.equal(qtyForBuy({ cash: 10000, price: 10, positionPct: 0.5 }), 500)
  // 买不起一手
  assert.equal(qtyForBuy({ cash: 1000, price: 50, positionPct: 0.5 }), 0)
  // 非法输入
  assert.equal(qtyForBuy({ cash: 0, price: 10, positionPct: 0.5 }), 0)
  assert.equal(qtyForBuy({ cash: 10000, price: 0, positionPct: 0.5 }), 0)
  assert.equal(qtyForBuy({ cash: 10000, price: 10, positionPct: 0 }), 0)
})

test('qtyForBuy：比例 > 1 时按满仓处理', () => {
  assert.equal(qtyForBuy({ cash: 10000, price: 10, positionPct: 2 }), 1000)
})

test('applyBuy：更新现金、持仓与成本价', () => {
  const r = applyBuy({ cash: 100000, units: 0, avgCost: 0, price: 10, positionPct: 0.5 })
  assert.equal(r.qty, 5000)
  assert.equal(r.cash, 50000)
  assert.equal(r.units, 5000)
  assert.equal(r.avgCost, 10)
})

test('applyBuy：加仓后成本价按加权平均', () => {
  // 已有 1000 份 @ 10，再按 50% 现金买 @ 20
  const r = applyBuy({ cash: 100000, units: 1000, avgCost: 10, price: 20, positionPct: 0.5 })
  assert.equal(r.qty, 2500)
  assert.equal(r.units, 3500)
  // (10*1000 + 20*2500) / 3500 = 60000/3500 = 17.14
  assert.equal(r.avgCost, 17.14)
})

test('applyBuy：钱不够一手时返回错误而不是静默成交', () => {
  const r = applyBuy({ cash: 500, units: 0, avgCost: 0, price: 100, positionPct: 0.5 })
  assert.match(r.error, /现金不足/)
})

test('applySell：默认清空持仓并算已实现盈亏', () => {
  const r = applySell({ cash: 0, units: 1000, avgCost: 10, price: 12 })
  assert.equal(r.qty, 1000)
  assert.equal(r.cash, 12000)
  assert.equal(r.units, 0)
  assert.equal(r.avgCost, 0)
  assert.equal(r.pnl, 2000)
})

test('applySell：指定数量时不超过持仓，部分卖出保留成本价', () => {
  const r = applySell({ cash: 0, units: 1000, avgCost: 10, price: 12, qty: 400 })
  assert.equal(r.qty, 400)
  assert.equal(r.units, 600)
  assert.equal(r.avgCost, 10)
  assert.equal(r.pnl, 800)

  const over = applySell({ cash: 0, units: 1000, avgCost: 10, price: 12, qty: 9999 })
  assert.equal(over.qty, 1000)
})

test('applySell：空仓返回错误', () => {
  assert.match(applySell({ cash: 100, units: 0, avgCost: 0, price: 10 }).error, /没有持仓/)
})

test('snapshotOf：净值、浮盈、收益率、仓位', () => {
  const s = snapshotOf({ cash: 50000, units: 5000, avgCost: 10, initialCash: 100000, price: 12 })
  assert.equal(s.marketValue, 60000)
  assert.equal(s.equity, 110000)
  assert.equal(s.unrealized, 10000)
  assert.ok(Math.abs(s.totalReturn - 0.1) < 1e-9)
  assert.ok(Math.abs(s.positionPct - 60000 / 110000) < 1e-9)
})

test('visibleSlice：游标越界与负数都被夹紧', () => {
  const bars = Array.from({ length: 10 }, (_, i) => ({ ts: `d${i}` }))
  assert.equal(visibleSlice(bars, 3).length, 3)
  assert.equal(visibleSlice(bars, 0).length, 0)
  assert.equal(visibleSlice(bars, -5).length, 0)
  assert.equal(visibleSlice(bars, 999).length, 10)
})

test('summarizeSession：汇总收益、胜率、买入持有基准', () => {
  const bars = [
    { ts: '2024-01-02', open: 10, close: 10 },
    { ts: '2024-01-03', open: 10, close: 12 },
  ]
  const session = { cash: 100000, units: 0, avgCost: 0, initialCash: 100000 }
  const trades = [
    { side: 'buy', pnl: null },
    { side: 'sell', pnl: 500 },
    { side: 'sell', pnl: -200 },
  ]
  const s = summarizeSession({ session, bars, trades })
  assert.equal(s.equity, 100000)
  assert.equal(s.tradeCount, 3)
  assert.equal(s.closedCount, 2)
  assert.equal(s.winRate, 0.5)
  assert.equal(s.realizedPnl, 300)
  // 买入持有：10 -> 12 = +20%
  assert.ok(Math.abs(s.buyHold - 0.2) < 1e-9)
})

test('LOT_SIZE 是 A 股最小交易单位', () => {
  assert.equal(LOT_SIZE, 100)
})

/* ---------------- 比例化买卖 ---------------- */

test('RATIO_PRESETS 覆盖需求里的 1/10、1/5、1/4、1/3、1/2', () => {
  const labels = RATIO_PRESETS.map((p) => p.label)
  for (const need of ['1/10', '1/5', '1/4', '1/3', '1/2']) {
    assert.ok(labels.includes(need), `缺少预设 ${need}`)
  }
})

test('normalizeRatio 把非法值夹到合法区间', () => {
  assert.equal(normalizeRatio(0.5), 0.5)
  assert.equal(normalizeRatio(1), 1)
  assert.equal(normalizeRatio(2), 1, '超过 1 夹到 1')
  assert.equal(normalizeRatio(0), 1, '非法值回退 fallback')
  assert.equal(normalizeRatio(NaN, 0.3), 0.3)
  assert.equal(normalizeRatio(-1, 0.3), 0.3)
})

test('买入比例：1/5 现金买 1/5，1/4 买 1/4', () => {
  // 100000 现金，价格 10 元：1/5 -> 20000/10=2000 份
  assert.equal(qtyForBuy({ cash: 100000, price: 10, positionPct: 1 / 5 }), 2000)
  assert.equal(qtyForBuy({ cash: 100000, price: 10, positionPct: 1 / 4 }), 2500)
  assert.equal(qtyForBuy({ cash: 100000, price: 10, positionPct: 1 / 3 }), 3300, '向下取整到 100 份')
  assert.equal(qtyForBuy({ cash: 100000, price: 10, positionPct: 1 / 2 }), 5000)
  assert.equal(qtyForBuy({ cash: 100000, price: 10, positionPct: 1 / 10 }), 1000)
})

test('买入比例：不同比例成交后的现金与持仓', () => {
  // 从空仓开始，用 1/2 买一次
  const half = applyBuy({ cash: 100000, units: 0, avgCost: 0, price: 10, positionPct: 0.5 })
  assert.equal(half.qty, 5000)
  assert.equal(half.cash, 50000)
  assert.equal(half.units, 5000)
  assert.equal(half.avgCost, 10)

  // 再按剩余现金的 1/2 加仓
  const again = applyBuy({ cash: half.cash, units: half.units, avgCost: half.avgCost, price: 10, positionPct: 0.5 })
  assert.equal(again.qty, 2500)
  assert.equal(again.cash, 25000)
  assert.equal(again.units, 7500)
  assert.equal(again.avgCost, 10)
})

test('买入比例：1/3 分三次接近满仓（因取整不会刚好满）', () => {
  let acc = { cash: 100000, units: 0, avgCost: 0 }
  for (let i = 0; i < 3; i++) {
    const r = applyBuy({ ...acc, price: 10, positionPct: 1 / 3 })
    acc = { cash: r.cash, units: r.units, avgCost: r.avgCost }
  }
  // 100000 -> 66600 -> 44334 -> 29511 左右，持仓 7000 份上下
  assert.ok(acc.units >= 6700 && acc.units <= 7100, `三次 1/3 后持仓应约 7000，实际 ${acc.units}`)
  assert.ok(acc.cash > 0, '不应花光现金')
})

test('卖出比例：按持仓比例卖，向下取整到 100 份', () => {
  // 10000 份持仓
  assert.equal(qtyForSell({ units: 10000, positionPct: 1 / 2 }), 5000)
  assert.equal(qtyForSell({ units: 10000, positionPct: 1 / 4 }), 2500)
  assert.equal(qtyForSell({ units: 10000, positionPct: 1 / 5 }), 2000)
  assert.equal(qtyForSell({ units: 10000, positionPct: 1 / 10 }), 1000)
  assert.equal(qtyForSell({ units: 10000, positionPct: 1 }), 10000, '全部')
})

test('卖出比例：1/3 时取整到 100 份', () => {
  assert.equal(qtyForSell({ units: 1000, positionPct: 1 / 3 }), 300)
  assert.equal(qtyForSell({ units: 100, positionPct: 1 / 3 }), 100, '不足一手按一手')
})

test('卖出比例：持仓很少时至少卖一手，不会变成无法卖出', () => {
  // 30 份持仓（不整手，历史遗留），按 1/10 算出来 3 份 -> 取整 0 -> 兜底卖全部 30
  assert.equal(qtyForSell({ units: 30, positionPct: 1 / 10 }), 30)
  // 150 份按 1/10 = 15 -> 取整 0 -> 兜底 100 份
  assert.equal(qtyForSell({ units: 150, positionPct: 1 / 10 }), 100)
})

test('卖出比例：空仓返回 0', () => {
  assert.equal(qtyForSell({ units: 0, positionPct: 0.5 }), 0)
})

test('applySell 支持 positionPct：部分卖出后保留成本价，盈亏按卖出份额算', () => {
  const r = applySell({ cash: 0, units: 1000, avgCost: 10, price: 12, positionPct: 0.5 })
  assert.equal(r.qty, 500)
  assert.equal(r.units, 500)
  assert.equal(r.avgCost, 10, '剩余持仓成本不变')
  assert.equal(r.cash, 6000)
  assert.equal(r.pnl, 1000, '(12-10)*500')
})

test('applySell 优先级：qty > positionPct > 清空', () => {
  // 给了 qty 就按 qty
  const byQty = applySell({ cash: 0, units: 1000, avgCost: 10, price: 10, qty: 200, positionPct: 0.5 })
  assert.equal(byQty.qty, 200)
  // 没 qty 有 positionPct 就按比例
  const byRatio = applySell({ cash: 0, units: 1000, avgCost: 10, price: 10, positionPct: 0.25 })
  assert.equal(byRatio.qty, 200)
  // 都没有就清空
  const byAll = applySell({ cash: 0, units: 1000, avgCost: 10, price: 10 })
  assert.equal(byAll.qty, 1000)
})

test('多次按比例卖出可以清空持仓', () => {
  let acc = { cash: 0, units: 1000, avgCost: 10 }
  // 第一次 1/2：卖 500，剩 500
  let r = applySell({ ...acc, price: 10, positionPct: 0.5 })
  assert.equal(r.qty, 500)
  acc = { cash: r.cash, units: r.units, avgCost: r.avgCost }
  assert.equal(acc.units, 500)
  // 第二次 1/2：500 的一半是 250，但按 100 份取整只能卖 200，剩 300
  r = applySell({ ...acc, price: 10, positionPct: 0.5 })
  assert.equal(r.qty, 200, '必须取整到 100 份的整数倍')
  acc = { cash: r.cash, units: r.units, avgCost: r.avgCost }
  assert.equal(acc.units, 300)
  // 最后用「全部」清空
  const all = applySell({ ...acc, price: 10, positionPct: 1 })
  assert.equal(all.qty, 300)
  assert.equal(all.units, 0)
  assert.equal(all.avgCost, 0)
})
