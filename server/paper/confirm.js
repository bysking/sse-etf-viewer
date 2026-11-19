// 人工确认：把候选信号转成人工账本的待成交订单。
// 与规则账本共用同一套下单/结算逻辑，差别只在“谁来触发”。
import { getSignal, setSignalStatus, getStrategy } from '../store/repositories.js'
import { ensureAccount, createPendingOrder, getAccount } from './service.js'
import { planOrder } from '../monitor/check.js'
import { DEFAULT_EXECUTION } from '../backtest/engine.js'

/**
 * 确认信号 → 人工账本挂单。
 * @returns {{ signal, order, reason? }}
 */
export function confirmSignal({ signalId, strategyId = null }) {
  const signal = getSignal(signalId)
  if (!signal) throw Object.assign(new Error('信号不存在'), { status: 404 })
  if (strategyId && signal.strategyId !== strategyId) {
    throw Object.assign(new Error('信号不属于该策略'), { status: 400 })
  }
  if (signal.status !== 'candidate') {
    return { signal, order: null, reason: 'alreadyHandled' }
  }

  const strategy = getStrategy(signal.strategyId)
  if (!strategy) throw Object.assign(new Error('策略不存在'), { status: 404 })

  const acc = ensureAccount({
    strategyId: strategy.id,
    symbol: signal.symbol,
    ledger: 'manual',
    initialCash: strategy.config?.initialCash ?? 100000,
  })

  const execution = { ...DEFAULT_EXECUTION, ...(strategy.config?.execution || {}) }
  // 用信号价作为参考价估算仓位；实际成交价在次日开盘确定
  const orderSpec = planOrder({
    strategy: strategy.config,
    signal: { ...signal, stopLevel: signal.evidence?.stopLevel ?? null },
    acc,
    execution,
  })

  if (!orderSpec) {
    // 条件已不满足（例如已持仓、或没有止损位）：仍然标记为已处理，避免反复出现
    const updated = setSignalStatus(signalId, 'confirmed')
    return { signal: updated, order: null, reason: 'notExecutable' }
  }

  const order = createPendingOrder({
    strategyId: strategy.id,
    signalId: signal.id,
    ledger: 'manual',
    side: orderSpec.side,
    qty: orderSpec.qty,
    signalDate: signal.detectedAt,
    stopLevel: orderSpec.stopLevel ?? null,
    reason: orderSpec.side === 'buy' ? 'entry' : 'exit',
  })
  const updated = setSignalStatus(signalId, 'confirmed')
  return { signal: updated, order, reason: null }
}

/** 忽略信号：只改状态，不产生订单 */
export function ignoreSignal({ signalId, strategyId = null }) {
  const signal = getSignal(signalId)
  if (!signal) throw Object.assign(new Error('信号不存在'), { status: 404 })
  if (strategyId && signal.strategyId !== strategyId) {
    throw Object.assign(new Error('信号不属于该策略'), { status: 400 })
  }
  if (signal.status !== 'candidate') return { signal, reason: 'alreadyHandled' }
  const updated = setSignalStatus(signalId, 'ignored')
  return { signal: updated, reason: null }
}

/** 人工账本的当前持仓，供前端展示“确认后会发生什么” */
export function manualPositionOf(strategyId, symbol) {
  const acc = getAccount(strategyId, 'manual')
  return acc ? { units: acc.units, cash: acc.cash, avgCost: acc.avgCost } : null
}