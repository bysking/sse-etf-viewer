// 双账本模拟盘：规则自动账本 + 人工确认账本。
// 成交口径与回测完全一致（复用 engine 的成交/费用函数），只是状态持久化到 SQLite。
import { randomUUID } from 'node:crypto'
import { getDb } from '../store/db.js'
import { compileStrategy } from '../../shared/strategy/evaluate.js'
import { DEFAULT_EXECUTION, buyPriceOf, sellPriceOf, feeOf, sizePosition } from '../backtest/engine.js'
import { getKline, applyAdjust } from '../data/kline.js'
import { seriesToBars, analyzeWyckoff } from '../../shared/wyckoff/analyzer.js'
import { listDividends } from '../store/repositories.js'

export const LEDGERS = ['rule', 'manual']
const now = () => new Date().toISOString()

/* ---------------------------- 账户 ---------------------------- */

export function getAccount(strategyId, ledger) {
  if (!LEDGERS.includes(ledger)) throw new Error(`未知账本：${ledger}`)
  const row = getDb()
    .prepare('SELECT * FROM paper_accounts WHERE strategy_id = ? AND ledger = ?')
    .get(strategyId, ledger)
  if (!row) return null
  return {
    id: row.id,
    strategyId: row.strategy_id,
    symbol: row.symbol,
    ledger: row.ledger,
    cash: row.cash,
    units: row.units,
    sellableUnits: row.sellable_units,
    avgCost: row.avg_cost,
    lastEquity: row.last_equity,
    updatedAt: row.updated_at,
  }
}

export function ensureAccount({ strategyId, symbol, ledger, initialCash = 100000 }) {
  const existing = getAccount(strategyId, ledger)
  if (existing) return existing
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO paper_accounts
       (id, strategy_id, symbol, ledger, cash, units, sellable_units, avg_cost, last_equity, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    )
    .run(id, strategyId, symbol, ledger, initialCash, initialCash, now())
  return getAccount(strategyId, ledger)
}

function saveAccount(acc) {
  getDb()
    .prepare(
      `UPDATE paper_accounts
       SET cash = ?, units = ?, sellable_units = ?, avg_cost = ?, last_equity = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(acc.cash, acc.units, acc.sellableUnits, acc.avgCost, acc.lastEquity, now(), acc.id)
  return acc
}

/* ---------------------------- 订单 ---------------------------- */

const mapOrder = (row) =>
  row
    ? {
        id: row.id,
        strategyId: row.strategy_id,
        signalId: row.signal_id,
        ledger: row.ledger,
        side: row.side,
        qty: row.qty,
        signalDate: row.signal_date,
        stopLevel: row.stop_level ?? null,
        fillDate: row.fill_date,
        fillPrice: row.fill_price,
        status: row.status,
        reason: row.reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null

export function listOrders({ strategyId, ledger, status, limit = 100 } = {}) {
  const where = []
  const args = []
  if (strategyId) {
    where.push('strategy_id = ?')
    args.push(strategyId)
  }
  if (ledger) {
    where.push('ledger = ?')
    args.push(ledger)
  }
  if (status) {
    where.push('status = ?')
    args.push(status)
  }
  const sql = `SELECT * FROM paper_orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY signal_date DESC LIMIT ?`
  return getDb()
    .prepare(sql)
    .all(...args, limit)
    .map(mapOrder)
}

export function createPendingOrder({
  strategyId,
  signalId = null,
  ledger,
  side,
  qty,
  signalDate,
  stopLevel = null,
  reason = null,
}) {
  if (!LEDGERS.includes(ledger)) throw new Error(`未知账本：${ledger}`)
  if (!['buy', 'sell'].includes(side)) throw new Error('side 仅支持 buy / sell')
  if (!(qty > 0)) throw new Error('qty 必须为正数')
  const id = randomUUID()
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO paper_orders
       (id, strategy_id, signal_id, ledger, side, qty, signal_date, stop_level, status, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(id, strategyId, signalId, ledger, side, Math.trunc(qty), signalDate, stopLevel, reason, ts, ts)
  return mapOrder(getDb().prepare('SELECT * FROM paper_orders WHERE id = ?').get(id))
}

function closeOrder(id, { status, fillDate = null, fillPrice = null }) {
  getDb()
    .prepare('UPDATE paper_orders SET status = ?, fill_date = ?, fill_price = ?, updated_at = ? WHERE id = ?')
    .run(status, fillDate, fillPrice, now(), id)
}

export function listTrades({ strategyId, ledger, limit = 200 } = {}) {
  const rows = getDb()
    .prepare(
      `SELECT t.* FROM paper_trades t
       JOIN paper_accounts a ON a.id = t.account_id
       WHERE (? IS NULL OR a.strategy_id = ?) AND (? IS NULL OR a.ledger = ?)
       ORDER BY t.trade_date DESC LIMIT ?`,
    )
    .all(strategyId ?? null, strategyId ?? null, ledger ?? null, ledger ?? null, limit)
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    orderId: r.order_id,
    side: r.side,
    qty: r.qty,
    price: r.price,
    fee: r.fee,
    tradeDate: r.trade_date,
    signalId: r.signal_id,
    pnl: r.pnl,
  }))
}

function insertTrade({ accountId, orderId, side, qty, price, fee, tradeDate, signalId, pnl }) {
  getDb()
    .prepare(
      `INSERT INTO paper_trades
       (id, account_id, order_id, side, qty, price, fee, trade_date, signal_id, pnl, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), accountId, orderId, side, qty, price, fee, tradeDate, signalId, pnl, now())
}

/* ---------------------------- 结算 ---------------------------- */

/**
 * 结算待成交订单：取信号日之后第一个交易日的开盘价。
 * 与回测口径一致：开盘跌破结构失效位则取消；T+1 约束；不足一手按可负担数量向下取整。
 *
 * @param {object} p
 * @param {string} p.strategyId
 * @param {string} p.symbol
 * @param {string} p.ledger
 * @param {Array} p.bars 复权后的 bars（需覆盖 signalDate 之后的交易日）
 * @param {object} p.execution
 * @param {number} [p.maxLagBars=5] 超过该交易日数未结算则标记 missed，不伪造成交
 */
export function settleOrders({ strategyId, symbol, ledger, bars, execution = {}, maxLagBars = 5 }) {
  const ex = { ...DEFAULT_EXECUTION, ...execution }
  const acc = getAccount(strategyId, ledger)
  if (!acc) return { settled: [], cancelled: [], missed: [] }

  const pending = getDb()
    .prepare(`SELECT * FROM paper_orders WHERE strategy_id = ? AND ledger = ? AND status = 'pending' ORDER BY signal_date`)
    .all(strategyId, ledger)
    .map(mapOrder)

  const settled = []
  const cancelled = []
  const missed = []
  const dateIndex = new Map(bars.map((b, i) => [b.date, i]))

  // T+1：批次开始时已持有的份额才可卖；本批次新买入的份额下一轮才可卖
  acc.sellableUnits = acc.units

  for (const order of pending) {
    const signalIdx = dateIndex.get(order.signalDate)
    // 信号日不在本轮 bars 内：还没有后续交易日数据，保持 pending
    if (signalIdx == null) continue
    const fillIdx = signalIdx + 1
    if (fillIdx >= bars.length) continue

    // 停机补结算：落后太多说明期间数据缺失，标记 missed 而不是伪造成交
    if (bars.length - 1 - fillIdx > maxLagBars) {
      closeOrder(order.id, { status: 'missed' })
      missed.push({ orderId: order.id, reason: 'settlementLagTooLong' })
      continue
    }

    const bar = bars[fillIdx]
    if (order.side === 'buy') {
      const open = Number(bar.open)
      const invalid = ex.cancelIfInvalidated && order.reason === 'entry' && opensBelowStop(order, ex, bar)
      if (invalid) {
        closeOrder(order.id, { status: 'cancelled', fillDate: bar.date })
        cancelled.push({ orderId: order.id, reason: 'invalidatedAtOpen' })
        continue
      }
      const price = buyPriceOf(open, ex)
      let qty = order.qty
      let fee = feeOf(price, qty, ex)
      let cost = price * qty + fee
      if (cost > acc.cash) {
        const lot = Math.max(1, Math.floor(ex.lotSize || 100))
        qty = Math.max(0, Math.floor(acc.cash / (price * (1 + ex.feeRate)) / lot) * lot)
        fee = feeOf(price, qty, ex)
        cost = price * qty + fee
      }
      if (qty <= 0) {
        closeOrder(order.id, { status: 'cancelled', fillDate: bar.date })
        cancelled.push({ orderId: order.id, reason: 'insufficientCash' })
        continue
      }
      acc.cash -= cost
      const prevUnits = acc.units
      acc.units += qty
      acc.avgCost = (acc.avgCost * prevUnits + cost) / acc.units
      insertTrade({
        accountId: acc.id,
        orderId: order.id,
        side: 'buy',
        qty,
        price,
        fee,
        tradeDate: bar.date,
        signalId: order.signalId,
        pnl: null,
      })
      closeOrder(order.id, { status: 'filled', fillDate: bar.date, fillPrice: price })
      settled.push({ orderId: order.id, side: 'buy', qty, price, date: bar.date })
    } else {
      const qty = Math.min(order.qty, acc.units, acc.sellableUnits)
      if (qty <= 0) {
        // T+1：当日买入不可卖，本轮不成交，等下一轮
        continue
      }
      const price = sellPriceOf(Number(bar.open), ex)
      const fee = feeOf(price, qty, ex)
      const proceeds = price * qty - fee
      const pnl = proceeds - acc.avgCost * qty
      acc.cash += proceeds
      acc.units -= qty
      acc.sellableUnits -= qty
      if (acc.units === 0) acc.avgCost = 0
      insertTrade({
        accountId: acc.id,
        orderId: order.id,
        side: 'sell',
        qty,
        price,
        fee,
        tradeDate: bar.date,
        signalId: order.signalId,
        pnl,
      })
      closeOrder(order.id, { status: 'filled', fillDate: bar.date, fillPrice: price })
      settled.push({ orderId: order.id, side: 'sell', qty, price, date: bar.date, pnl })
    }
  }

  saveAccount(acc)
  return { settled, cancelled, missed }
}

/** 入场订单在开盘时是否已跌破结构失效位（与回测一致） */
function opensBelowStop(order, ex, bar) {
  const stop = order.stopLevel ?? null
  if (stop == null) return false
  return Number(bar.open) <= stop
}

/* ---------------------------- 净值 ---------------------------- */

export function getPaperSummary({ strategyId, ledger, bars = [] }) {
  const acc = getAccount(strategyId, ledger)
  if (!acc) return null
  const lastBar = bars[bars.length - 1]
  const equity = lastBar ? acc.cash + acc.units * lastBar.close : acc.cash
  const trades = listTrades({ strategyId, ledger })
  const closed = trades.filter((t) => t.side === 'sell' && t.pnl != null)
  const wins = closed.filter((t) => t.pnl > 0)
  return {
    ...acc,
    equity,
    lastClose: lastBar?.close ?? null,
    lastDate: lastBar?.date ?? null,
    unrealized: acc.units && lastBar ? (lastBar.close - acc.avgCost / 1) * acc.units : 0,
    tradeCount: closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    realizedPnl: closed.reduce((a, t) => a + t.pnl, 0),
    orders: listOrders({ strategyId, ledger, limit: 20 }),
    trades: trades.slice(0, 50),
  }
}
