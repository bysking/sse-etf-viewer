// bar-by-bar 回测：T 日收盘出信号，T+1 开盘成交；含手续费、滑点、T+1、结构失效取消。
import { compileStrategy } from '../../shared/strategy/evaluate.js'

export const DEFAULT_EXECUTION = {
  fillAt: 'nextOpen',
  tPlus1: true,
  position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1.0 },
  feeRate: 0.0003,
  minFee: 5,
  slippageBps: 2,
  lotSize: 100,
  cancelIfInvalidated: true,
  cancelCooldownBars: 5,
}

/** 手续费：佣金 + 最低佣金（ETF 无印花税） */
export const feeOf = (price, qty, ex) => Math.max(ex.minFee, price * qty * ex.feeRate)

/** 买入价：开盘价 × (1 + 滑点) */
export const buyPriceOf = (open, ex) => Number(open) * (1 + ex.slippageBps / 10000)

/** 卖出价：开盘价 × (1 - 滑点) */
export const sellPriceOf = (open, ex) => Number(open) * (1 - ex.slippageBps / 10000)

/** 按最小交易单位向下取整；先吸收浮点误差，避免 4999.99999 被截成 4900 */
function floorToLot(shares, lot) {
  if (!(shares > 0)) return 0
  return Math.floor(shares / lot + 1e-9) * lot
}

/** 按风险比例或全仓计算买入数量（已按最小交易单位取整） */
export function sizePosition({ equity, entryRef, stopLevel, ex }) {
  const pos = ex.position || {}
  const lot = Math.max(1, Math.floor(ex.lotSize || 100))
  if (pos.type === 'allIn') {
    const byMax = (equity * (pos.maxPositionPct ?? 1)) / entryRef
    return floorToLot(byMax, lot)
  }
  const riskPct = pos.riskPct ?? 0.01
  if (stopLevel == null) return 0
  const dist = entryRef - stopLevel
  if (!(dist > 0)) return 0
  const byRisk = (equity * riskPct) / dist
  const byMax = (equity * (pos.maxPositionPct ?? 1)) / entryRef
  return floorToLot(Math.min(byRisk, byMax), lot)
}

export { floorToLot }

function calcMetrics({ curve, initialCash, trades }) {
  if (!curve.length) return { totalReturn: 0, annualized: null, maxDrawdown: 0, sharpe: null, winRate: null, profitFactor: null, tradeCount: 0 }
  const finalEquity = curve[curve.length - 1].equity
  const totalReturn = finalEquity / initialCash - 1
  const maxDrawdown = Math.min(...curve.map((p) => p.drawdown))
  const rets = []
  for (let i = 1; i < curve.length; i++) {
    if (curve[i - 1].equity > 0) rets.push(curve[i].equity / curve[i - 1].equity - 1)
  }
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null
  const variance = rets.length ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length : null
  const std = variance == null ? null : Math.sqrt(variance)
  const sharpe = mean != null && std && std > 0 ? (mean / std) * Math.sqrt(252) : null
  const annualized =
    curve.length > 1 ? Math.pow(1 + totalReturn, 252 / Math.max(1, curve.length - 1)) - 1 : null

  const closed = trades.filter((t) => t.side === 'sell' && t.pnl != null)
  const wins = closed.filter((t) => t.pnl > 0)
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0)
  const grossLoss = Math.abs(closed.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0))
  return {
    totalReturn,
    annualized,
    maxDrawdown,
    sharpe,
    winRate: closed.length ? wins.length / closed.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossLoss === 0 && grossProfit > 0 ? Infinity : null,
    tradeCount: closed.length,
    finalEquity,
    benchmarkReturn: curve[curve.length - 1].benchmark / initialCash - 1,
  }
}

/**
 * @param {object} p
 * @param {Array} p.bars
 * @param {object} p.analysis analyzeWyckoff 的结果
 * @param {object} p.strategy 策略配置（entry/exit/execution）
 * @param {number} p.initialCash
 */
export function runBacktest({ bars, analysis, strategy = {}, initialCash = 100000 }) {
  const ex = { ...DEFAULT_EXECUTION, ...(strategy.execution || {}) }
  if (ex.fillAt !== 'nextOpen') throw new Error('v1 仅支持 T+1 开盘成交（fillAt=nextOpen）')
  if (!framesOk(bars, analysis)) throw new Error('bars 与 analysis 长度不一致')

  const compiled = compileStrategy(strategy)
  const events = analysis.events
  const states = analysis.states

  let cash = initialCash
  let units = 0
  let sellableUnits = 0
  let avgCost = 0
  let positionStop = null
  let pendingBuy = null
  let pendingSell = null
  let entryCooldownUntil = -1

  const trades = []
  const cancelled = []
  const curve = []
  let peak = initialCash
  const firstClose = Math.max(1e-9, bars[0].close)

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]

    // ---- 开盘：先处理上一日收盘生成的订单 ----
    if (pendingBuy) {
      const open = Number(bar.open)
      const invalid = ex.cancelIfInvalidated && pendingBuy.stopLevel != null && open <= pendingBuy.stopLevel
      if (invalid) {
        cancelled.push({ ...pendingBuy, cancelDate: bar.date, reason: 'invalidatedAtOpen' })
        // 开盘即失效说明该结构已被破坏，不能在同一事件上立刻重试
        entryCooldownUntil = i + (ex.cancelCooldownBars ?? 5)
        pendingBuy = null
      } else {
        const price = buyPriceOf(open, ex)
        let qty = pendingBuy.qty
        let fee = feeOf(price, qty, ex)
        let cost = price * qty + fee
        if (cost > cash) {
          const affordable = Math.floor(cash / (price * (1 + ex.feeRate)) / ex.lotSize) * ex.lotSize
          qty = Math.max(0, Math.min(qty, affordable))
          fee = feeOf(price, qty, ex)
          cost = price * qty + fee
        }
        if (qty <= 0) {
          cancelled.push({ ...pendingBuy, cancelDate: bar.date, reason: 'insufficientCash' })
        } else {
          cash -= cost
          const prevUnits = units
          units += qty
          avgCost = (avgCost * prevUnits + cost) / units
          positionStop = pendingBuy.stopLevel
          trades.push({
            side: 'buy',
            date: bar.date,
            signalDate: pendingBuy.signalDate,
            signalIndex: pendingBuy.signalIndex,
            price,
            qty,
            fee,
            pnl: null,
            reason: pendingBuy.reason,
          })
          pendingBuy = null
        }
      }
    }

    if (pendingSell) {
      const open = Number(bar.open)
      const qty = Math.min(pendingSell.qty, units, sellableUnits)
      if (qty > 0) {
        const price = sellPriceOf(open, ex)
        const fee = feeOf(price, qty, ex)
        const proceeds = price * qty - fee
        const pnl = proceeds - avgCost * qty
        cash += proceeds
        units -= qty
        sellableUnits -= qty
        if (units === 0) {
          avgCost = 0
          positionStop = null
        }
        trades.push({
          side: 'sell',
          date: bar.date,
          signalDate: pendingSell.signalDate,
          signalIndex: pendingSell.signalIndex,
          price,
          qty,
          fee,
          pnl,
          reason: pendingSell.reason,
        })
      }
      pendingSell = null
    }

    // 收盘后：当日买入的份额可在下一交易日卖出（T+1）
    sellableUnits = units

    const equity = cash + units * bar.close
    peak = Math.max(peak, equity)
    curve.push({
      date: bar.date,
      equity,
      benchmark: initialCash * (bar.close / firstClose),
      drawdown: equity / peak - 1,
      units,
      cash,
    })

    if (i >= bars.length - 1) continue

    const ctx = { state: states[i], i, events, analysis }

    // 入场
    if (units === 0 && !pendingBuy && !pendingSell && i >= entryCooldownUntil && compiled.entry(ctx)) {
      const entryRef = bar.close
      const stopLevel = compiled.stopLevel(ctx)
      const qty = sizePosition({ equity, entryRef, stopLevel, ex })
      if (qty > 0) {
        pendingBuy = {
          side: 'buy',
          qty,
          stopLevel,
          signalIndex: i,
          signalDate: bar.date,
          reason: 'entry',
        }
      }
    }

    // 出场：策略信号或收盘价触及结构止损
    if (units > 0 && !pendingSell) {
      const stopHit = positionStop != null && bar.close <= positionStop
      if (stopHit || compiled.exit(ctx)) {
        pendingSell = {
          side: 'sell',
          qty: units,
          signalIndex: i,
          signalDate: bar.date,
          reason: stopHit ? 'stopLoss' : 'exit',
        }
      }
    }
  }

  const metrics = calcMetrics({ curve, initialCash, trades })
  return { trades, cancelled, equity: curve, metrics, execution: ex, pending: { pendingBuy, pendingSell } }
}

function framesOk(bars, analysis) {
  return Array.isArray(bars) && Array.isArray(analysis?.states) && bars.length === analysis.states.length
}
