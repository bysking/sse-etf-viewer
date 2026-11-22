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

/**
 * 按风险比例或全仓计算买入数量（已按最小交易单位取整）。
 * @param {object} [p.pct] 分批建仓时该档占总仓位的比例，默认 1（一次性建满）
 */
export function sizePosition({ equity, entryRef, stopLevel, ex, pct = 1 }) {
  const pos = ex.position || {}
  const lot = Math.max(1, Math.floor(ex.lotSize || 100))
  const share = Math.min(1, Math.max(0, Number(pct) || 0))
  if (!(share > 0)) return 0
  if (pos.type === 'allIn' || pos.type === 'scaled') {
    const byMax = (equity * (pos.maxPositionPct ?? 1) * share) / entryRef
    return floorToLot(byMax, lot)
  }
  const riskPct = pos.riskPct ?? 0.01
  if (stopLevel == null) return 0
  const dist = entryRef - stopLevel
  if (!(dist > 0)) return 0
  const byRisk = (equity * riskPct * share) / dist
  const byMax = (equity * (pos.maxPositionPct ?? 1) * share) / entryRef
  return floorToLot(Math.min(byRisk, byMax), lot)
}

/**
 * 分批建仓：判断当前是否满足下一档的触发条件。
 * 档位按顺序推进，每档触发一次。
 * @param {object} p
 * @param {Array} p.tiers 已校验的档位
 * @param {number} p.nextTier 下一档下标
 * @param {object} p.ctx 当前 bar 的策略上下文
 * @param {object} p.position { avgCost }
 * @param {object} p.compiled compileStrategy 结果
 * @param {number} p.index 当前 bar 下标
 */
export function isTierTriggered({ tiers, nextTier, ctx, position, compiled, index }) {
  const tier = tiers?.[nextTier]
  if (!tier) return false
  const trigger = tier.trigger || 'immediate'
  if (trigger === 'immediate') return true
  if (trigger === 'event') {
    // 用与策略条件相同的“最近事件”判定，保证回测/监控一致
    const ev = findRecentEvent(ctx.events, index, tier.event, tier.withinBars ?? 5)
    return Boolean(ev)
  }
  if (trigger === 'pullbackPct') {
    const ref = Number(ctx.state?.close)
    const base = Number(position?.avgCost)
    if (!(ref > 0) || !(base > 0)) return false
    return ref <= base * (1 - Number(tier.value || 0))
  }
  return false
}

function findRecentEvent(events, i, type, withinBars) {
  const want = String(type || '').toLowerCase()
  let found = null
  for (const e of events || []) {
    if (e.detectedIndex > i) break
    if (String(e.type).toLowerCase() !== want) continue
    if (i - e.detectedIndex > withinBars) continue
    found = e
  }
  return found
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
  // 分批建仓：下一档待触发的下标；0 表示还没开首仓
  let nextTier = 0

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
            tierIndex: pendingBuy.tierIndex ?? 0,
          })
          // 成交后推进到下一档
          nextTier = (pendingBuy.tierIndex ?? 0) + 1
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
          nextTier = 0 // 清仓后重新从首档开始
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

    // 入场 / 加仓
    const scaled = ex.position?.type === 'scaled' && Array.isArray(ex.position.tiers) && ex.position.tiers.length > 0
    const canOpen = scaled ? units === 0 : units === 0
    const canScale = scaled && units > 0 && nextTier < ex.position.tiers.length

    if ((canOpen || canScale) && !pendingBuy && !pendingSell && i >= entryCooldownUntil) {
      // 首档或单次入场需要策略入场条件；后续档位只看该档自己的触发条件
      const entryOk = canOpen ? compiled.entry(ctx) : true
      const tierOk =
        !scaled || canOpen ? true : isTierTriggered({ tiers: ex.position.tiers, nextTier, ctx, position: { avgCost }, compiled, index: i })

      if (entryOk && tierOk) {
        const entryRef = bar.close
        const stopLevel = compiled.stopLevel(ctx)
        const tierPct = scaled ? ex.position.tiers[canOpen ? 0 : nextTier].pct : 1
        // 加仓时按剩余可用比例计算，避免超出 maxPositionPct
        const qty = sizePosition({ equity, entryRef, stopLevel, ex, pct: tierPct })
        if (qty > 0) {
          pendingBuy = {
            side: 'buy',
            qty,
            stopLevel: canOpen ? stopLevel : positionStop ?? stopLevel,
            signalIndex: i,
            signalDate: bar.date,
            reason: canOpen ? 'entry' : `scale-${(canOpen ? 0 : nextTier) + 1}`,
            tierIndex: scaled ? (canOpen ? 0 : nextTier) : 0,
          }
        } else if (canScale) {
          // 该档算不出数量（例如资金不足），跳过它继续等下一档
          nextTier += 1
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
