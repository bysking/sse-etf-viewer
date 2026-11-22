// 参数扫描：在训练段选参数，在验证段检验，避免“只在样本内好看”。
// 只做网格搜索与结果对比，不自动采纳最优参数——过拟合风险由人判断。
import { analyzeWyckoff } from '../../shared/wyckoff/analyzer.js'
import { runBacktest } from './engine.js'

export const MAX_COMBOS = 200

/** 把 grid 展开成参数组合列表；超过上限直接报错，避免误触发大规模计算 */
export function expandGrid(grid) {
  if (!Array.isArray(grid) || !grid.length) return [{}]
  let combos = [{}]
  for (const axis of grid) {
    if (!axis || typeof axis.path !== 'string' || !axis.path) throw new Error('grid 每项需要 path')
    const values = Array.isArray(axis.values) ? axis.values : []
    if (!values.length) throw new Error(`grid ${axis.path} 的 values 不能为空`)
    if (values.length > 20) throw new Error(`grid ${axis.path} 取值过多（上限 20）`)
    const next = []
    for (const base of combos) {
      for (const v of values) next.push({ ...base, [axis.path]: v })
    }
    combos = next
    if (combos.length > MAX_COMBOS) throw new Error(`参数组合超过 ${MAX_COMBOS} 个，请减少取值范围`)
  }
  return combos
}

/** 按点分路径写值（返回新对象，不改原配置） */
export function setPath(obj, path, value) {
  const out = Array.isArray(obj) ? [...obj] : { ...obj }
  const parts = path.split('.')
  let cur = out
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    cur[k] = cur[k] != null && typeof cur[k] === 'object' ? { ...cur[k] } : {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
  return out
}

/** 扫描参数是否触及 Wyckoff 分析参数（触及则需要重新分析） */
export function touchesWyckoff(grid = []) {
  return grid.some((a) => String(a?.path || '').startsWith('wyckoff.'))
}

const METRIC_KEYS = ['totalReturn', 'annualized', 'maxDrawdown', 'sharpe', 'winRate', 'tradeCount', 'finalEquity', 'benchmarkReturn']

function pickMetrics(m) {
  const out = {}
  for (const k of METRIC_KEYS) out[k] = m?.[k] ?? null
  return out
}

/**
 * 执行扫描。
 * @param {object} p
 * @param {Array} p.bars 复权后的 bars
 * @param {object} p.strategy 基础策略配置
 * @param {Array} p.grid [{ path, values }]
 * @param {string} p.trainEnd 训练段结束日（含）；之后的日期作为验证段
 * @param {number} [p.initialCash]
 * @param {object} [p.shares] 份额序列
 * @param {(done:number,total:number)=>void} [p.onProgress]
 */
export function sweepBacktest({ bars, strategy = {}, grid = [], trainEnd, initialCash = 100000, shares = null, onProgress }) {
  if (!Array.isArray(bars) || !bars.length) throw new Error('bars 不能为空')
  if (!trainEnd) throw new Error('需要 trainEnd 划分训练段与验证段')
  const combos = expandGrid(grid)
  const needReanalysis = touchesWyckoff(grid)

  // 分析结果只在参数不涉及 wyckoff 时复用，否则每个组合都要重算
  let sharedAnalysis = null
  if (!needReanalysis) {
    sharedAnalysis = analyzeWyckoff(bars, strategy.wyckoff || {}, { shares })
  }

  const results = []
  combos.forEach((combo, i) => {
    let cfg = strategy
    for (const [path, value] of Object.entries(combo)) {
      // 允许 path 省略 wyckoff. 前缀：直接命中策略配置本身
      cfg = setPath(cfg, path, value)
    }
    try {
      const analysis = needReanalysis
        ? analyzeWyckoff(bars, cfg.wyckoff || {}, { shares })
        : sharedAnalysis
      const full = runBacktest({ bars, analysis, strategy: { ...cfg, initialCash }, initialCash })
      // 训练段 / 验证段分别统计：切分点按日期
      const trainTrades = full.trades.filter((t) => t.date <= trainEnd)
      const valTrades = full.trades.filter((t) => t.date > trainEnd)
      results.push({
        params: combo,
        train: summarizeCurve(full.equity, trainEnd, initialCash, trainTrades, 'lte'),
        validation: summarizeCurve(full.equity, trainEnd, initialCash, valTrades, 'gt'),
      })
    } catch (e) {
      results.push({ params: combo, error: e.message })
    }
    onProgress?.(i + 1, combos.length)
  })

  return {
    combos: combos.length,
    trainEnd,
    reanalyzed: needReanalysis,
    results: results.sort(sortByTrainReturn),
  }
}

/** 从净值曲线里切出训练/验证段并计算关键指标 */
function summarizeCurve(equity, trainEnd, initialCash, trades, side) {
  const seg = equity.filter((p) => (side === 'lte' ? p.date <= trainEnd : p.date > trainEnd))
  if (!seg.length) return { totalReturn: null, maxDrawdown: null, tradeCount: trades.length }
  const first = side === 'lte' ? initialCash : seg[0].equity
  const last = seg[seg.length - 1].equity
  const totalReturn = first > 0 ? last / first - 1 : null
  const maxDrawdown = Math.min(...seg.map((p) => p.drawdown))
  const closed = trades.filter((t) => t.side === 'sell' && t.pnl != null)
  const wins = closed.filter((t) => t.pnl > 0)
  return {
    totalReturn,
    maxDrawdown,
    tradeCount: closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
  }
}

/** 训练段收益降序；无收益的排后面 */
function sortByTrainReturn(a, b) {
  const av = a?.train?.totalReturn
  const bv = b?.train?.totalReturn
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return bv - av
}

/**
 * 挑出“训练与验证都不错”的组合，降低纯样本内最优的误导。
 * 只做筛选与排序，不替用户决定用哪组。
 */
export function rankRobust(results, { minTrades = 1 } = {}) {
  return results
    .filter((r) => !r.error)
    .filter((r) => (r.train?.tradeCount ?? 0) >= minTrades)
    .map((r) => {
      const tr = r.train?.totalReturn
      const va = r.validation?.totalReturn
      // 稳健度：取两段收益的较小值；验证段缺失时按 0 处理并标记
      const score = va == null ? Math.min(tr ?? 0, 0) : Math.min(tr ?? 0, va)
      return { ...r, robustScore: score, validationMissing: va == null }
    })
    .sort((a, b) => b.robustScore - a.robustScore)
}
