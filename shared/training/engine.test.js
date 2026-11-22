import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOT_SIZE,
  qtyForBuy,
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
