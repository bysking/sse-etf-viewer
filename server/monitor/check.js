// 单个策略的一次检查：分析 → 生成信号 → 双账本挂单/结算 → 通知。
import { randomUUID } from 'node:crypto'
import { getStrategyState, setStrategyState, insertSignal, getActiveStrategyVersion } from '../store/repositories.js'
import { loadAnalysis, detectSignalsAtLatest, persistSignal, strategyUsesShares } from './signals.js'
import { ensureAccount, createPendingOrder, settleOrders, getAccount } from '../paper/service.js'
import { dispatch, signalMessage } from '../notify/dispatch.js'
import { addDays, todayCST } from '../sse.js'
import { sizePosition, DEFAULT_EXECUTION, feeOf } from '../backtest/engine.js'
import { compileStrategy } from '../../shared/strategy/evaluate.js'

const LOOKBACK_DAYS = 420 // 约 1.7 年，足够识别区间与预热指标

/**
 * @param {object} p
 * @param {object} p.strategy 策略（含 id/name/config）
 * @param {string} p.date 检查日期
 * @param {boolean} p.force 手动触发
 * @param {boolean} p.notify 是否发送通知（测试可关）
 */
export async function executeCheck({ strategy, date = todayCST(), force = false, notify = true, fetchImpl = null }) {
  const cfg = strategy.config || {}
  const symbol = cfg.symbol
  if (!symbol) throw new Error('策略缺少 symbol')

  const start = addDays(date, -LOOKBACK_DAYS)
  const includeShares = strategyUsesShares(cfg)
  const { bars, analysis, adjust } = await loadAnalysis({ symbol, start, end: date, includeShares })

  const lastBar = bars[bars.length - 1]
  if (!lastBar) throw new Error('没有可用行情')

  const state = getStrategyState(strategy.id) || {}
  const signals = detectSignalsAtLatest({ bars, analysis, strategy: cfg, state })

  const result = {
    symbol,
    adjust,
    barDate: lastBar.date,
    close: lastBar.close,
    phase: analysis.states[analysis.states.length - 1]?.phase ?? null,
    signals: [],
    orders: [],
    notifications: [],
    changed: false,
  }

  // ---- 1. 先用最新数据结算历史待成交订单（双账本） ----
  const execution = { ...DEFAULT_EXECUTION, ...(cfg.execution || {}) }
  for (const ledger of ['rule', 'manual']) {
    const acc = ensureAccount({
      strategyId: strategy.id,
      symbol,
      ledger,
      initialCash: cfg.initialCash ?? 100000,
    })
    if (!acc) continue
    const settled = settleOrders({ strategyId: strategy.id, symbol, ledger, bars, execution })
    if (settled.settled.length || settled.cancelled.length || settled.missed.length) {
      result.orders.push({ ledger, ...settled })
      result.changed = true
    }
  }

  // ---- 2. 生成新信号 ----
  for (const sig of signals) {
    const row = persistSignal({ strategyId: strategy.id, symbol, signal: sig })
    if (!row) continue // 已存在，重启/重复检查不重复处理
    result.signals.push(row)
    result.changed = true

    // 规则账本：自动挂单
    const ruleAcc = getAccount(strategy.id, 'rule')
    if (ruleAcc) {
      const order = planOrder({ strategy: cfg, signal: sig, acc: ruleAcc, execution })
      if (order) {
        createPendingOrder({
          strategyId: strategy.id,
          signalId: row.id,
          ledger: 'rule',
          side: order.side,
          qty: order.qty,
          signalDate: lastBar.date,
          stopLevel: order.stopLevel ?? null,
          reason: order.side === 'buy' ? 'entry' : 'exit',
        })
        result.orders.push({ ledger: 'rule', queued: order })
      }
    }
    // 人工确认账本：不自动下单，等用户在前端确认
  }

  // ---- 3. 更新策略状态 ----
  const holding = (getAccount(strategy.id, 'rule')?.units ?? 0) > 0
  setStrategyState(strategy.id, {
    symbol,
    lastBar: lastBar.date,
    lastPhase: result.phase,
    lastConfidence: analysis.states[analysis.states.length - 1]?.confidence ?? null,
    lastAction: signals[0]?.action ?? null,
    lastEventKey: signals[0] ? `${signals[0].eventType}:${signals[0].detectedAt}` : state.lastEventKey ?? null,
    lastCheckedDate: lastBar.date,
    holding,
  })

  // ---- 4. 通知 ----
  if (notify && result.signals.length) {
    const merged = mergeMessages({ strategy, signals: result.signals, bar: lastBar })
    const r = await dispatch(merged, { fetchImpl: fetchImpl || undefined })
    result.notifications.push(r)
  }

  return result
}

/** 按当前账户与信号计算要下的订单（不成交，只挂单） */
export function planOrder({ strategy, signal, acc, execution }) {
  const ex = { ...DEFAULT_EXECUTION, ...execution }
  if (signal.action === 'entry_candidate') {
    if ((acc.units ?? 0) > 0) return null // 已持仓不加仓
    const equity = acc.cash + (acc.units ?? 0) * (signal.price ?? 0)
    const qty = sizePosition({
      equity,
      entryRef: Number(signal.price) || 0,
      stopLevel: signal.stopLevel ?? null,
      ex,
    })
    if (!(qty > 0)) return null
    return { side: 'buy', qty, stopLevel: signal.stopLevel ?? null }
  }
  if (signal.action === 'exit_candidate') {
    const qty = acc.units ?? 0
    if (!(qty > 0)) return null
    return { side: 'sell', qty }
  }
  return null
}

/** 同一轮多个信号合并成一条消息，避免刷屏 */
function mergeMessages({ strategy, signals, bar }) {
  if (signals.length === 1) {
    return signalMessage({
      strategyName: strategy.name,
      symbol: signals[0].eventType ? strategy.config.symbol : strategy.config.symbol,
      signal: signals[0],
      price: bar.close,
      extra: `数据日期：${bar.date}`,
    })
  }
  const title = `【威科夫候选】${strategy.config.symbol} ${signals.length} 条信号`
  const lines = signals.map(
    (s) => `- ${s.detectedAt} ${s.eventType} ${s.action === 'entry_candidate' ? '买入观察' : '离场观察'} 参考价 ${Number(s.price ?? 0).toFixed(3)}`,
  )
  return {
    level: 'candidate',
    title,
    markdown: [`策略：${strategy.name}`, ...lines, '说明：候选信号，需人工确认。'].join('\n'),
  }
}
