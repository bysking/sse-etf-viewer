// 事件研究：统计事件确认后次日开盘买入的前瞻收益、MFE/MAE、胜率。
// 只用于校准阈值，不参与策略自动择优，避免过拟合。

export const STUDY_EVENT_TYPES = ['SC', 'BC', 'AR', 'ST', 'Spring', 'Test', 'UTAD', 'SOS', 'SOW', 'LPS', 'LPSY']

const median = (arr) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)

/**
 * @param {Array} bars
 * @param {Array} events analyzer 输出的事件
 * @param {object} options { horizons, slippageBps }
 */
export function eventStudy(bars, events, options = {}) {
  const horizons = options.horizons || [5, 10, 20, 60]
  const types = options.types || STUDY_EVENT_TYPES
  const slip = (options.slippageBps ?? 0) / 10000
  const rows = []

  for (const e of events) {
    if (!types.includes(e.type)) continue
    const entryIndex = e.detectedIndex + 1
    if (entryIndex >= bars.length) continue
    const entryPrice = Number(bars[entryIndex].open) * (1 + slip)
    if (!(entryPrice > 0)) continue

    const horizonsOut = {}
    for (const h of horizons) {
      const end = Math.min(entryIndex + h, bars.length - 1)
      if (end <= entryIndex) continue
      let maxHigh = -Infinity
      let minLow = Infinity
      for (let i = entryIndex; i <= end; i++) {
        maxHigh = Math.max(maxHigh, Number(bars[i].high))
        minLow = Math.min(minLow, Number(bars[i].low))
      }
      const exitPrice = Number(bars[end].close) * (1 - slip)
      horizonsOut[h] = {
        return: exitPrice / entryPrice - 1,
        mfe: maxHigh / entryPrice - 1,
        mae: minLow / entryPrice - 1,
        endDate: bars[end].date,
      }
    }

    rows.push({
      type: e.type,
      side: e.side ?? null,
      occurredDate: e.occurredDate,
      detectedDate: e.detectedDate,
      detectedIndex: e.detectedIndex,
      rangeId: e.rangeId ?? null,
      entryDate: bars[entryIndex].date,
      entryPrice,
      horizons: horizonsOut,
    })
  }

  const summary = []
  for (const type of [...new Set(rows.map((r) => r.type))]) {
    for (const h of horizons) {
      const vals = rows
        .filter((r) => r.type === type && r.horizons[h])
        .map((r) => r.horizons[h])
      if (!vals.length) continue
      const rets = vals.map((v) => v.return)
      summary.push({
        type,
        horizon: h,
        count: vals.length,
        avgReturn: mean(rets),
        medianReturn: median(rets),
        winRate: rets.filter((x) => x > 0).length / rets.length,
        avgMfe: mean(vals.map((v) => v.mfe)),
        avgMae: mean(vals.map((v) => v.mae)),
      })
    }
  }

  return { horizons, rows, summary }
}
