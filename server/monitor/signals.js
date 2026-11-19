// 信号生成：把「最新交易日确认的事件 + 策略条件」转成候选信号。
// 与回测共用 compileStrategy，保证同一策略在回测和监控里的判断一致。
import { analyzeWyckoff, seriesToBars } from '../../shared/wyckoff/analyzer.js'
import { compileStrategy } from '../../shared/strategy/evaluate.js'
import { getKline, applyAdjust } from '../data/kline.js'
import { getShares } from '../sse.js'
import { listDividends, insertSignal, getStrategyState, setStrategyState } from '../store/repositories.js'

/** 策略是否引用份额流（决定是否需要等 T 日晚间数据） */
export function strategyUsesShares(config = {}) {
  return JSON.stringify({ entry: config.entry ?? null, exit: config.exit ?? null }).includes('"shareFlow"')
}

/**
 * 拉取数据并分析到最新交易日。返回与回测一致的结构。
 */
export async function loadAnalysis({ symbol, start, end, includeShares }) {
  const raw = await getKline(symbol, start, end)
  const k = applyAdjust(raw, listDividends(symbol, { onlyConfirmed: true }))
  const bars = seriesToBars(k.series)
  if (!bars.length) throw new Error(`区间内没有 ${symbol} 的日 K 数据`)
  let shares = null
  if (includeShares) {
    const s = await getShares(symbol, start, end)
    shares = s.series.filter(([, v]) => v != null)
  }
  const analysis = analyzeWyckoff(bars, {}, { shares })
  return { bars, analysis, adjust: k.adjust, dataVersion: `${k.adjust}:${k.adjustmentCount ?? 0}` }
}

/**
 * 找出「最新一根 bar」上由策略条件触发的信号。
 * 只在最后一根 bar 判断，避免把历史事件重复当作今日信号。
 */
export function detectSignalsAtLatest({ bars, analysis, strategy, state = null }) {
  const compiled = compileStrategy(strategy)
  const i = bars.length - 1
  if (i < 0) return []
  const ctx = { state: analysis.states[i], i, events: analysis.events, analysis }
  const bar = bars[i]
  const holding = state?.holding === true
  const out = []

  // 出场优先：持仓时先看离场条件，避免同一天既买又卖
  if (holding && compiled.exit(ctx)) {
    out.push({
      action: 'exit_candidate',
      eventType: pickExitEvent(analysis.events, i) || 'Exit',
      detectedAt: bar.date,
      price: bar.close,
      evidence: { phase: analysis.states[i].phase, confidence: analysis.states[i].confidence },
    })
    return out
  }

  if (!holding && compiled.entry(ctx)) {
    const stop = compiled.stopLevel(ctx)
    out.push({
      action: 'entry_candidate',
      eventType: pickEntryEvent(analysis.events, i) || 'Entry',
      detectedAt: bar.date,
      price: bar.close,
      stopLevel: stop,
      evidence: {
        phase: analysis.states[i].phase,
        confidence: analysis.states[i].confidence,
        range: analysis.states[i].range ?? null,
        stopLevel: stop,
      },
    })
  }
  return out
}

/** 取最近一根触发的事件类型，用于信号展示 */
function pickEntryEvent(events, i, withinBars = 5) {
  const types = ['Spring', 'SOS', 'LPS', 'Test', 'ST', 'SC']
  return pickLatest(events, i, types, withinBars)
}

function pickExitEvent(events, i, withinBars = 5) {
  const types = ['UTAD', 'SOW', 'LPSY', 'BC']
  return pickLatest(events, i, types, withinBars)
}

function pickLatest(events, i, types, withinBars) {
  let best = null
  for (const e of events) {
    if (e.detectedIndex > i) break
    if (!types.includes(e.type)) continue
    if (i - e.detectedIndex > withinBars) continue
    if (!best || e.detectedIndex >= best.detectedIndex) best = e
  }
  return best?.type ?? null
}

/**
 * 把信号入库。唯一约束保证重启/重复检查不会重复写入。
 * 返回 null 表示已存在（本次是重复检查）。
 */
export function persistSignal({ strategyId, symbol, signal }) {
  return insertSignal({
    strategyId,
    symbol,
    rangeId: signal.evidence?.range?.id ?? null,
    eventType: signal.eventType,
    occurredAt: signal.occurredAt ?? signal.detectedAt,
    detectedAt: signal.detectedAt,
    action: signal.action,
    price: signal.price,
    evidence: signal.evidence ?? {},
  })
}
