// 人工模拟训练的核心规则：纯函数，前后端共用、可单测。
//
// 规则（已与需求确认）：
//   - 成交价 = 当前 bar 的收盘价，不计费用、不计滑点（纯粹的形态训练）；
//   - 买入金额 = 当前可用现金 × positionPct，数量向下取整到 100 份（A 股最小交易单位）；
//   - 卖出默认清空全部持仓，也支持指定份额；
//   - 不使用未来数据：调用方只能把「已推进到的那根」传进来。

export const LOT_SIZE = 100

/** 常用比例预设：1/10、1/5、1/4、1/3、1/2，另有「全部」单独处理 */
export const RATIO_PRESETS = [
  { num: 1, den: 10, label: '1/10' },
  { num: 1, den: 5, label: '1/5' },
  { num: 1, den: 4, label: '1/4' },
  { num: 1, den: 3, label: '1/3' },
  { num: 1, den: 2, label: '1/2' },
]

const round2 = (v) => Math.round(v * 100) / 100

/** 把比例夹到 (0, 1]；非法值回退到 fallback */
export function normalizeRatio(value, fallback = 1) {
  const v = Number(value)
  if (!Number.isFinite(v) || v <= 0) return fallback
  return Math.min(1, v)
}

/** 按现金比例算可买数量（向下取整到 100 份） */
export function qtyForBuy({ cash, price, positionPct, lotSize = LOT_SIZE }) {
  const p = Number(price)
  const c = Number(cash)
  const pct = normalizeRatio(positionPct, 0)
  if (!(p > 0) || !(c > 0) || !(pct > 0)) return 0
  const budget = c * pct
  const units = Math.floor(budget / p / lotSize) * lotSize
  return units > 0 ? units : 0
}

/**
 * 应用一笔买入。
 * positionPct 是「本次买入使用的现金比例」，不传则用会话默认仓位。
 */
export function applyBuy({ cash, units, avgCost, price, positionPct, lotSize = LOT_SIZE }) {
  const p = Number(price)
  if (!(p > 0)) return { error: '当前 bar 没有有效收盘价' }
  const qty = qtyForBuy({ cash, price: p, positionPct, lotSize })
  if (qty <= 0) {
    const pctText = (normalizeRatio(positionPct, 0) * 100).toFixed(0)
    return {
      error: `现金不足：按 ${pctText}% 仓位最多买 0 份（当前现金 ${round2(cash)}）`,
    }
  }
  const cost = qty * p
  const nextUnits = units + qty
  const nextCash = cash - cost
  const nextAvg = (avgCost * units + cost) / nextUnits
  return { qty, price: round2(p), cash: round2(nextCash), units: nextUnits, avgCost: round2(nextAvg) }
}

/** 按持仓比例算可卖数量（向下取整到 100 份，至少 100 份且不超过持仓） */
export function qtyForSell({ units, positionPct, lotSize = LOT_SIZE }) {
  const u = Math.trunc(Number(units) || 0)
  if (u <= 0) return 0
  const pct = normalizeRatio(positionPct, 1)
  if (pct >= 1) return u
  const qty = Math.floor((u * pct) / lotSize) * lotSize
  // 按比例算出来不足一手时，至少卖一手（否则「1/10 卖出 3 手」这类场景会变成无法卖出）
  if (qty <= 0) return Math.min(lotSize, u)
  return Math.min(qty, u)
}

/**
 * 应用一笔卖出。优先级：qty（绝对份额）> positionPct（持仓比例）> 清空。
 */
export function applySell({ cash, units, avgCost, price, qty = null, positionPct = null }) {
  const p = Number(price)
  if (!(p > 0)) return { error: '当前 bar 没有有效收盘价' }
  if (units <= 0) return { error: '当前没有持仓' }
  const sellQty =
    qty != null
      ? Math.min(Math.trunc(qty), units)
      : positionPct != null
        ? qtyForSell({ units, positionPct })
        : units
  if (!(sellQty > 0)) return { error: '卖出数量必须大于 0' }
  const proceeds = sellQty * p
  const pnl = (p - avgCost) * sellQty
  const nextUnits = units - sellQty
  return {
    qty: sellQty,
    price: round2(p),
    cash: round2(cash + proceeds),
    units: nextUnits,
    avgCost: nextUnits > 0 ? round2(avgCost) : 0,
    pnl: round2(pnl),
  }
}

/** 账户快照：净值、浮动盈亏、收益率、仓位占比 */
export function snapshotOf({ cash, units, avgCost, initialCash, price }) {
  const p = Number(price) || 0
  const marketValue = units * p
  const equity = cash + marketValue
  const unrealized = units > 0 ? (p - avgCost) * units : 0
  return {
    price: round2(p),
    cash: round2(cash),
    units,
    avgCost: round2(avgCost),
    marketValue: round2(marketValue),
    equity: round2(equity),
    unrealized: round2(unrealized),
    totalReturn: initialCash > 0 ? equity / initialCash - 1 : 0,
    positionPct: equity > 0 ? marketValue / equity : 0,
  }
}

/** 只暴露已推进的部分，绝不返回未来 bar */
export function visibleSlice(bars, cursor) {
  const n = Math.max(0, Math.min(bars.length, Number(cursor) || 0))
  return bars.slice(0, n)
}

/** 结束时的成绩单 */
export function summarizeSession({ session, bars, trades = [] }) {
  const last = bars[bars.length - 1]
  const snap = snapshotOf({
    cash: session.cash,
    units: session.units,
    avgCost: session.avgCost,
    initialCash: session.initialCash,
    price: last?.close,
  })
  const sells = trades.filter((t) => t.side === 'sell' && t.pnl != null)
  const wins = sells.filter((t) => t.pnl > 0)
  // 买入持有基准：从实际起始 bar 开盘买入，持到最后一根收盘
  const first = bars[0]
  const buyHold =
    first && last && Number(first.open) > 0 ? (Number(last.close) / Number(first.open) - 1) : null
  return {
    ...snap,
    tradeCount: trades.length,
    closedCount: sells.length,
    winRate: sells.length ? wins.length / sells.length : null,
    realizedPnl: round2(sells.reduce((a, t) => a + (t.pnl || 0), 0)),
    buyHold,
    barCount: bars.length,
    lastTs: last?.ts ?? null,
  }
}
