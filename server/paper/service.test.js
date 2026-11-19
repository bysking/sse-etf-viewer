import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb } from '../store/db.js'
import * as repo from '../store/repositories.js'
import {
  ensureAccount,
  getAccount,
  getPaperSummary,
  createPendingOrder,
  settleOrders,
  listOrders,
  listTrades,
} from './service.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-paper-'))
process.env.DATA_DIR = dir

after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

const mkBars = (rows) =>
  rows.map(([date, open, high, low, close]) => ({ date, open, high, low, close, volume: 1000 }))

const EXECUTION = {
  position: { type: 'allIn', maxPositionPct: 1 },
  feeRate: 0.0003,
  minFee: 5,
  slippageBps: 2,
  lotSize: 100,
  cancelIfInvalidated: true,
}

function newStrategy(name = '模拟盘测试') {
  return repo.createStrategy({
    name,
    config: {
      symbol: '510300',
      entry: { all: [{ event: 'Spring', withinBars: 5 }] },
      exit: { any: [{ event: 'SOS', withinBars: 4 }, { stopLoss: { reference: 'rangeLow', bufferAtr: 0.5 } }] },
      execution: EXECUTION,
    },
  })
}

test('ensureAccount：两个账本互不影响，重复调用不重置余额', () => {
  const s = newStrategy('双账本')
  const rule = ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 100000 })
  const manual = ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'manual', initialCash: 50000 })

  assert.equal(rule.cash, 100000)
  assert.equal(manual.cash, 50000)
  assert.notEqual(rule.id, manual.id)

  const again = ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 999 })
  assert.equal(again.id, rule.id)
  assert.equal(again.cash, 100000, '已有账户不应被重置')
  assert.throws(() => ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'bad' }), /未知账本/)
})

test('settleOrders：T 日信号、T+1 开盘成交，含滑点与最低佣金', () => {
  const s = newStrategy('买入结算')
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 100000 })

  const bars = mkBars([
    ['2024-01-02', 10, 10.2, 9.9, 10],
    ['2024-01-03', 10.1, 10.3, 10, 10.2], // 成交日
    ['2024-01-04', 10.2, 10.4, 10.1, 10.3],
  ])
  const order = createPendingOrder({
    strategyId: s.id,
    ledger: 'rule',
    side: 'buy',
    qty: 5000,
    signalDate: '2024-01-02',
    reason: 'entry',
  })

  const r = settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'rule', bars, execution: EXECUTION })
  assert.equal(r.settled.length, 1)
  assert.equal(r.settled[0].date, '2024-01-03')

  const filled = listOrders({ strategyId: s.id, ledger: 'rule' })[0]
  assert.equal(filled.status, 'filled')
  assert.equal(filled.fillDate, '2024-01-03')
  // 开盘 10.1 × (1 + 2bp)
  assert.ok(Math.abs(filled.fillPrice - 10.1 * 1.0002) < 1e-9)

  const acc = getAccount(s.id, 'rule')
  assert.equal(acc.units, 5000)
  assert.ok(acc.cash < 100000 - 5000 * 10.1)

  const trades = listTrades({ strategyId: s.id, ledger: 'rule' })
  assert.equal(trades.length, 1)
  assert.equal(trades[0].side, 'buy')
  assert.ok(trades[0].fee >= 5, '最低佣金 5 元')
  assert.equal(order.status, 'pending')
})

test('settleOrders：T+1 限制，当日买入不能当日卖出', () => {
  const s = newStrategy('T+1')
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 100000 })
  const bars = mkBars([
    ['2024-01-02', 10, 10.2, 9.9, 10],
    ['2024-01-03', 10.1, 10.3, 10, 10.2],
    ['2024-01-04', 10.2, 10.4, 10.1, 10.3],
  ])

  // 同一信号日同时挂买单和卖单：卖单因可卖数量为 0 保持 pending
  createPendingOrder({ strategyId: s.id, ledger: 'rule', side: 'buy', qty: 5000, signalDate: '2024-01-02' })
  createPendingOrder({ strategyId: s.id, ledger: 'rule', side: 'sell', qty: 5000, signalDate: '2024-01-02' })

  settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'rule', bars, execution: EXECUTION })
  const orders = listOrders({ strategyId: s.id, ledger: 'rule' })
  const buy = orders.find((o) => o.side === 'buy')
  const sell = orders.find((o) => o.side === 'sell')
  assert.equal(buy.status, 'filled')
  assert.equal(sell.status, 'pending', 'T+1 当日不可卖，卖单应留在 pending')
  assert.equal(getAccount(s.id, 'rule').units, 5000)
})

test('settleOrders：开盘跌破失效位取消入场', () => {
  const s = newStrategy('开盘失效')
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 100000 })
  const bars = mkBars([
    ['2024-01-02', 10, 10.2, 9.9, 10],
    ['2024-01-03', 9.0, 9.2, 8.8, 9.1], // 开盘 9.0 低于失效位 9.5
  ])
  createPendingOrder({
    strategyId: s.id,
    ledger: 'rule',
    side: 'buy',
    qty: 5000,
    signalDate: '2024-01-02',
    stopLevel: 9.5,
    reason: 'entry',
  })
  const r = settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'rule', bars, execution: EXECUTION })
  assert.equal(r.cancelled.length, 1)
  assert.equal(r.cancelled[0].reason, 'invalidatedAtOpen')
  assert.equal(getAccount(s.id, 'rule').units, 0)
  assert.equal(listOrders({ strategyId: s.id, ledger: 'rule' })[0].status, 'cancelled')
})

test('settleOrders：落后太多交易日标记 missed，不伪造成交', () => {
  const s = newStrategy('补结算')
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 100000 })
  const rows = [['2024-01-02', 10, 10.2, 9.9, 10]]
  for (let i = 3; i <= 20; i++) rows.push([`2024-01-${String(i).padStart(2, '0')}`, 10, 10, 10, 10])
  const bars = mkBars(rows)
  createPendingOrder({ strategyId: s.id, ledger: 'rule', side: 'buy', qty: 1000, signalDate: '2024-01-02' })

  const r = settleOrders({
    strategyId: s.id,
    symbol: '510300',
    ledger: 'rule',
    bars,
    execution: EXECUTION,
    maxLagBars: 3,
  })
  assert.equal(r.missed.length, 1)
  assert.equal(getAccount(s.id, 'rule').units, 0)
  assert.equal(listOrders({ strategyId: s.id, ledger: 'rule' })[0].status, 'missed')
})

test('settleOrders：现金不足时按可负担数量成交', () => {
  const s = newStrategy('现金不足')
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 10000 })
  const bars = mkBars([
    ['2024-01-02', 10, 10.2, 9.9, 10],
    ['2024-01-03', 10, 10.2, 9.9, 10],
  ])
  createPendingOrder({ strategyId: s.id, ledger: 'rule', side: 'buy', qty: 5000, signalDate: '2024-01-02' })
  settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'rule', bars, execution: EXECUTION })
  const acc = getAccount(s.id, 'rule')
  assert.ok(acc.units > 0 && acc.units < 5000)
  assert.ok(acc.cash >= 0)
})

test('卖出计算已实现盈亏并清空持仓', () => {
  const s = newStrategy('卖出')
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 100000 })
  const bars = mkBars([
    ['2024-01-02', 10, 10.2, 9.9, 10],
    ['2024-01-03', 10, 10.2, 9.9, 10], // 买入
    ['2024-01-04', 11, 11.2, 10.9, 11], // 卖出
  ])
  createPendingOrder({ strategyId: s.id, ledger: 'rule', side: 'buy', qty: 1000, signalDate: '2024-01-02' })
  settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'rule', bars, execution: EXECUTION })

  createPendingOrder({ strategyId: s.id, ledger: 'rule', side: 'sell', qty: 1000, signalDate: '2024-01-03' })
  const r = settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'rule', bars, execution: EXECUTION })
  assert.equal(r.settled.length, 1)
  assert.ok(r.settled[0].pnl > 0)

  const acc = getAccount(s.id, 'rule')
  assert.equal(acc.units, 0)
  assert.equal(acc.avgCost, 0)

  const summary = getPaperSummary({ strategyId: s.id, ledger: 'rule', bars })
  assert.equal(summary.tradeCount, 1)
  assert.equal(summary.winRate, 1)
  assert.ok(summary.realizedPnl > 0)
})

test('双账本独立结算：同一策略的 rule 与 manual 互不影响', () => {
  const s = newStrategy('隔离')
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 100000 })
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'manual', initialCash: 100000 })
  const bars = mkBars([
    ['2024-01-02', 10, 10.2, 9.9, 10],
    ['2024-01-03', 10, 10.2, 9.9, 10],
  ])
  createPendingOrder({ strategyId: s.id, ledger: 'rule', side: 'buy', qty: 3000, signalDate: '2024-01-02' })
  createPendingOrder({ strategyId: s.id, ledger: 'manual', side: 'buy', qty: 1000, signalDate: '2024-01-02' })

  settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'rule', bars, execution: EXECUTION })
  assert.equal(getAccount(s.id, 'rule').units, 3000)
  assert.equal(getAccount(s.id, 'manual').units, 0, 'manual 未结算前不应变化')

  settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'manual', bars, execution: EXECUTION })
  assert.equal(getAccount(s.id, 'manual').units, 1000)
  assert.equal(getAccount(s.id, 'rule').units, 3000)
})

test('重复结算不会重复成交', () => {
  const s = newStrategy('幂等')
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'rule', initialCash: 100000 })
  const bars = mkBars([
    ['2024-01-02', 10, 10.2, 9.9, 10],
    ['2024-01-03', 10, 10.2, 9.9, 10],
  ])
  createPendingOrder({ strategyId: s.id, ledger: 'rule', side: 'buy', qty: 1000, signalDate: '2024-01-02' })
  settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'rule', bars, execution: EXECUTION })
  const first = getAccount(s.id, 'rule')

  const r2 = settleOrders({ strategyId: s.id, symbol: '510300', ledger: 'rule', bars, execution: EXECUTION })
  assert.equal(r2.settled.length, 0)
  assert.equal(getAccount(s.id, 'rule').units, first.units)
  assert.equal(listTrades({ strategyId: s.id, ledger: 'rule' }).length, 1)
})
