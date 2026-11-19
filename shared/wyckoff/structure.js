// L2 市场结构：ATR ZigZag Swing、周线背景。
import { sma, rollingMax, rollingMin } from '../indicators.js'
import { mergeConfig } from './config.js'

/**
 * 在线 Swing 检测器：pivot 只有在反向移动超过阈值并等待足够 bar 后才确认，
 * 因此 detectedIndex 一定晚于（或等于）极值点，不存在未来函数。
 */
export function createPivotTracker(bars, atrArr, userConfig = {}) {
  const cfg = mergeConfig(userConfig).swing
  const pivots = []
  let dir = null // null | 'up'（最近 pivot 是低点，寻找高点） | 'down'
  let extLow = null
  let extHigh = null

  const push = (type, ext, i, bar) => {
    const p = {
      type,
      index: ext.index,
      date: bars[ext.index].date,
      price: ext.price,
      detectedIndex: i,
      detectedDate: bar.date,
    }
    pivots.push(p)
    return p
  }

  return {
    pivots,
    /** 处理第 i 根 bar，返回本次新确认的 pivot 数组 */
    update(i) {
      const bar = bars[i]
      const out = []
      if (i === 0 || !bar) {
        extLow = { index: 0, price: Number(bars[0]?.low ?? 0) }
        extHigh = { index: 0, price: Number(bars[0]?.high ?? 0) }
        return out
      }
      const a = atrArr[i] ?? atrArr[i - 1] ?? Math.max(1e-9, Number(bar.high) - Number(bar.low))
      const th = Math.max(1e-9, cfg.atrMult * a)

      if (dir === null) {
        if (!extLow || Number(bar.low) < extLow.price) extLow = { index: i, price: Number(bar.low) }
        if (!extHigh || Number(bar.high) > extHigh.price) extHigh = { index: i, price: Number(bar.high) }

        const upMove = Number(bar.high) - extLow.price
        const downMove = extHigh.price - Number(bar.low)
        const upReady = upMove >= th && i - extLow.index >= cfg.confirmBars
        const downReady = downMove >= th && i - extHigh.index >= cfg.confirmBars

        if (upReady && downReady) {
          if (upMove >= downMove) {
            out.push(push('low', extLow, i, bar))
            dir = 'up'
            extHigh = { index: i, price: Number(bar.high) }
            extLow = null
          } else {
            out.push(push('high', extHigh, i, bar))
            dir = 'down'
            extLow = { index: i, price: Number(bar.low) }
            extHigh = null
          }
        } else if (upReady) {
          out.push(push('low', extLow, i, bar))
          dir = 'up'
          extHigh = { index: i, price: Number(bar.high) }
          extLow = null
        } else if (downReady) {
          out.push(push('high', extHigh, i, bar))
          dir = 'down'
          extLow = { index: i, price: Number(bar.low) }
          extHigh = null
        }
        return out
      }

      if (dir === 'up') {
        if (Number(bar.high) > extHigh.price) extHigh = { index: i, price: Number(bar.high) }
        if (extHigh.price - Number(bar.low) >= th && i - extHigh.index >= cfg.confirmBars) {
          out.push(push('high', extHigh, i, bar))
          dir = 'down'
          extLow = { index: i, price: Number(bar.low) }
          extHigh = null
        }
        return out
      }

      // dir === 'down'：最近 pivot 是高点，寻找低点
      if (Number(bar.low) < extLow.price) extLow = { index: i, price: Number(bar.low) }
      if (Number(bar.high) - extLow.price >= th && i - extLow.index >= cfg.confirmBars) {
        out.push(push('low', extLow, i, bar))
        dir = 'up'
        extHigh = { index: i, price: Number(bar.high) }
        extLow = null
      }
      return out
    },
  }
}

/**
 * 区间方向推断：用区间起点之前 N 根的涨跌幅判断吸筹/派发。
 * 只影响 pivot 区间，SC/BC 种子区间由事件本身决定方向。
 */
export function inferRangeSide(bars, startIndex, rangeCfg = {}) {
  const lb = rangeCfg.sideLookbackBars ?? 60
  const minRet = rangeCfg.sideMinReturn ?? 0.05
  if (!(lb > 0) || startIndex < lb) return 'neutral'
  const base = Number(bars[startIndex - lb]?.close)
  const cur = Number(bars[startIndex]?.close)
  if (!(base > 0) || !Number.isFinite(cur)) return 'neutral'
  const ret = cur / base - 1
  if (ret <= -minRet) return 'accumulation'
  if (ret >= minRet) return 'distribution'
  return 'neutral'
}

/** 取某日期所在周的周一（YYYY-MM-DD） */
export function weekStartOf(date) {
  const d = new Date(date + 'T00:00:00Z')
  const day = d.getUTCDay() // 0=周日
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}

/** 把日 K 聚合为周 K，周以周一为起点 */
export function buildWeeklyBars(bars) {
  const groups = new Map()
  for (const b of bars) {
    const wk = weekStartOf(b.date)
    if (!groups.has(wk)) {
      groups.set(wk, { weekStart: wk, weekEnd: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 })
    }
    const g = groups.get(wk)
    g.weekEnd = b.date
    g.high = Math.max(g.high, b.high)
    g.low = Math.min(g.low, b.low)
    g.close = b.close
    g.volume += Number(b.volume) || 0
  }
  return [...groups.values()].sort((a, b) => (a.weekEnd < b.weekEnd ? -1 : 1))
}

/**
 * 周线背景 as-of：对任意日 bar，只使用 weekEnd <= 当日 的最近一根周线。
 * 周内尚未收盘的日子自然只能看到上一完整周。
 */
export function weeklyContext(bars, userConfig = {}) {
  const cfg = mergeConfig(userConfig).context?.weekly || { maPeriod: 30, rangeWeeks: 20 }
  const maPeriod = cfg.maPeriod ?? 30
  const rangeWeeks = cfg.rangeWeeks ?? 20
  const weekly = buildWeeklyBars(bars)
  const closes = weekly.map((w) => w.close)
  const ma = sma(closes, maPeriod)
  const hi = rollingMax(weekly.map((w) => w.high), rangeWeeks)
  const lo = rollingMin(weekly.map((w) => w.low), rangeWeeks)

  const enriched = weekly.map((w, i) => {
    const rangeHigh = hi[i]
    const rangeLow = lo[i]
    const position =
      rangeHigh != null && rangeLow != null && rangeHigh > rangeLow
        ? (w.close - rangeLow) / (rangeHigh - rangeLow)
        : null
    let trend = 'unknown'
    if (ma[i] != null) trend = w.close > ma[i] ? 'up' : w.close < ma[i] ? 'down' : 'flat'
    let phase = 'neutral'
    if (trend === 'up' && position != null) phase = position > 0.5 ? 'markup' : 'accumulation'
    else if (trend === 'down' && position != null) phase = position < 0.5 ? 'markdown' : 'distribution'
    return { ...w, ma: ma[i], rangeHigh, rangeLow, position, trend, phase }
  })

  const out = new Array(bars.length).fill(null)
  let ptr = -1
  for (let i = 0; i < bars.length; i++) {
    while (ptr + 1 < enriched.length && enriched[ptr + 1].weekEnd <= bars[i].date) ptr++
    if (ptr >= 0) out[i] = enriched[ptr]
  }
  return out
}
