// 前复权：yunhq 日 K 不复权，除息日会出现价格缺口。
// 用「ETF 相对基准指数的额外低开」识别除息，再按比例回溯调整历史价格。

/** 纯函数：把原始日 K 按除息事件做前复权，返回新数组（不改原数据） */
export function applyForwardAdjust(series, exDates) {
  if (!Array.isArray(series) || !series.length || !exDates?.length) return { series, applied: [] }
  const sorted = [...new Set(exDates)]
    .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
  if (!sorted.length) return { series, applied: [] }

  const posOf = new Map(series.map((r, i) => [r[0], i]))

  // 第一步：全部用【原始】数据计算每处除息的比例，避免前一次调整污染后一次判断
  const applied = []
  for (const date of sorted) {
    const i = posOf.get(date)
    if (i == null || i <= 0) continue
    const prevClose = Number(series[i - 1][4])
    const open = Number(series[i][1])
    if (!(prevClose > 0) || !(open > 0)) continue
    const gap = open / prevClose - 1
    if (!(gap < 0)) continue
    const ratio = 1 + gap // 用跳空幅度近似除息比例
    if (!(ratio > 0.5 && ratio < 1)) continue
    // ratio 保留完整精度，否则连续除息会累积舍入误差
    applied.push({ date, index: i, gapPct: +(gap * 100).toFixed(3), ratio })
  }
  if (!applied.length) return { series, applied: [] }

  // 第二步：从最新一根往前处理。
  // 每根 bar 只受【位于它之后】的除息影响；除息日当根本身已是除息后价格，不再缩放。
  const out = series.map((r) => [...r])
  const byIndex = new Map(applied.map((a) => [a.index, a.ratio]))
  let cumulative = 1
  for (let j = out.length - 1; j >= 0; j--) {
    if (cumulative !== 1) {
      out[j][1] = Number(out[j][1]) * cumulative
      out[j][2] = Number(out[j][2]) * cumulative
      out[j][3] = Number(out[j][3]) * cumulative
      out[j][4] = Number(out[j][4]) * cumulative
    }
    // 处理完本根后，再把它自身的比例累加给更早的 bar
    const ratio = byIndex.get(j)
    if (ratio) cumulative *= ratio
  }
  return { series: out, applied }
}

/**
 * 自动识别除息日：对比 ETF 与基准指数同日开盘跳空。
 * 只有当 ETF 额外低开超过阈值、且基准当天没有同等跌幅时才认定为除息。
 *
 * 注意：这是启发式识别，会有噪声（例如真实利空导致的独立下跌）。
 * 结果一律以 source=auto、confirmed=0 入库，需人工确认后才参与复权。
 */
export function detectDividends(
  etfSeries,
  indexSeries,
  { minExtraGap = 0.02, minGap = 0.02, maxPerYear = 2 } = {},
) {
  if (!etfSeries?.length || !indexSeries?.length) return []
  const idxPos = new Map()
  indexSeries.forEach((r, i) => idxPos.set(r[0], i))
  const found = []
  for (let i = 1; i < etfSeries.length; i++) {
    const date = etfSeries[i][0]
    const j = idxPos.get(date)
    if (j == null || j < 1) continue
    const etfPrev = Number(etfSeries[i - 1][4])
    const etfOpen = Number(etfSeries[i][1])
    const idxPrev = Number(indexSeries[j - 1][4])
    const idxOpen = Number(indexSeries[j][1])
    if (!(etfPrev > 0 && etfOpen > 0 && idxPrev > 0 && idxOpen > 0)) continue
    const etfGap = etfOpen / etfPrev - 1
    const idxGap = idxOpen / idxPrev - 1
    const extra = etfGap - idxGap
    // 只认“ETF 额外低开”这一种；指数同步下跌属于市场行情
    if (extra >= -minExtraGap) continue
    if (etfGap >= -minGap) continue
    const amount = +(etfPrev * Math.abs(extra)).toFixed(4)
    found.push({
      date,
      dropPct: +(-extra * 100).toFixed(3),
      amount,
      etfGapPct: +(etfGap * 100).toFixed(3),
      indexGapPct: +(idxGap * 100).toFixed(3),
    })
  }

  // ETF 通常每年最多分红 1–2 次；同年出现更多属于噪声，只保留幅度最大的几笔
  if (maxPerYear > 0) {
    const byYear = new Map()
    for (const f of found) {
      const y = f.date.slice(0, 4)
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y).push(f)
    }
    const kept = []
    for (const list of byYear.values()) {
      list.sort((a, b) => b.dropPct - a.dropPct)
      kept.push(...list.slice(0, maxPerYear))
    }
    kept.sort((a, b) => (a.date < b.date ? -1 : 1))
    return kept
  }
  return found
}

/** 前复权后的序列在指定日期区间的切片 */
export function sliceSeries(series, start, end) {
  return series.filter((r) => r[0] >= start && r[0] <= end)
}
