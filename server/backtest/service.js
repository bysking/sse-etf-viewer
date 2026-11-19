// 回测任务执行：取数 → 流式分析 → 组合模拟 → 落库。
import { getKline } from '../data/kline.js'
import { getShares } from '../sse.js'
import { seriesToBars, analyzeWyckoff } from '../../shared/wyckoff/analyzer.js'
import { runBacktest } from './engine.js'
import * as repo from '../store/repositories.js'

/** 策略条件里是否引用了份额流（决定是否需要拉取份额数据） */
export function strategyUsesShares(config = {}) {
  const text = JSON.stringify({ entry: config.entry ?? null, exit: config.exit ?? null })
  return text.includes('"shareFlow"')
}

export async function executeBacktest(runId) {
  const run = repo.getRun(runId)
  if (!run) throw new Error('回测任务不存在')
  if (run.status === 'done' || run.status === 'failed') return run

  try {
    repo.setRunProgress(runId, 'running', 0.05)
    const k = await getKline(run.symbol, run.start, run.end)
    const bars = seriesToBars(k.series)
    if (!bars.length) throw new Error(`区间内没有 ${run.symbol} 的日 K 数据`)

    let shares = null
    if (strategyUsesShares(run.configSnapshot)) {
      repo.setRunProgress(runId, 'running', 0.1)
      const s = await getShares(run.symbol, run.start, run.end)
      shares = s.series.filter(([, v]) => v != null)
      if (!s.count) throw new Error(`区间内没有 ${run.symbol} 的份额数据`)
      repo.setRunProgress(runId, 'running', 0.5)
    } else {
      repo.setRunProgress(runId, 'running', 0.4)
    }

    const cfg = run.configSnapshot || {}
    const wyckoffCfg = cfg.wyckoff
      ? { ...cfg.wyckoff, context: cfg.context, shareFlow: cfg.shareFlow }
      : { ...cfg, context: cfg.context, shareFlow: cfg.shareFlow }

    const analysis = analyzeWyckoff(bars, wyckoffCfg, { shares })
    repo.setRunProgress(runId, 'running', 0.8)

    const result = runBacktest({
      bars,
      analysis,
      strategy: cfg,
      initialCash: cfg.initialCash ?? 100000,
    })
    repo.finishRun(runId, {
      metrics: result.metrics,
      equity: result.equity,
      trades: result.trades,
    })
    return repo.getRun(runId)
  } catch (e) {
    repo.failRun(runId, e.message)
    return repo.getRun(runId)
  }
}
