// 训练页图表：K 线 + 成交量 + 买卖点。只画「已推进」的 bar，绝不出现未来数据。
import * as echarts from 'echarts/core'
import { BarChart, CandlestickChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  CandlestickChart,
  LineChart,
  BarChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  AxisPointerComponent,
  MarkLineComponent,
  CanvasRenderer,
])

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
const n2 = (v) => (v == null || !Number.isFinite(+v) ? '-' : (+v).toFixed(2))
const pct = (v) => (v == null || !Number.isFinite(+v) ? '-' : (v * 100).toFixed(2) + '%')

/**
 * @param {object} p
 * @param {Array} p.bars 已推进的 bar（{ts,date,open,high,low,close,volume}）
 * @param {Array} p.trades 成交记录（含 barTs, side, qty, price）
 * @param {number} p.avgCost 当前持仓成本，用于画成本线
 */
export function buildTrainingOption({ bars = [], trades = [], avgCost = 0 } = {}) {
  const times = bars.map((b) => b.ts)
  const byTime = new Map(bars.map((b) => [b.ts, b]))
  const UP = css('--up') || '#e5484d'
  const DOWN = css('--down') || '#12a150'
  const text = css('--text')
  const muted = css('--muted')
  const line = css('--line')
  const accent = css('--accent')
  const idx = css('--idx')

  const candles = bars.map((b) => [b.open, b.close, b.low, b.high])
  const vols = bars.map((b) => ({
    value: b.volume,
    itemStyle: { color: b.close >= b.open ? UP : DOWN, opacity: 0.5 },
  }))

  const tradesByTime = new Map()
  for (const t of trades) {
    if (!tradesByTime.has(t.barTs)) tradesByTime.set(t.barTs, [])
    tradesByTime.get(t.barTs).push(t)
  }
  const buys = trades.filter((t) => t.side === 'buy' && times.includes(t.barTs))
  const sells = trades.filter((t) => t.side === 'sell' && times.includes(t.barTs))

  // 默认显示尾部 180 根，避免分钟线挤成一团
  const startPct = bars.length > 180 ? Math.max(0, 100 - (180 / bars.length) * 100) : 0

  return {
    animation: false,
    textStyle: { color: text },
    legend: { top: 2, textStyle: { color: text }, data: ['K线', '成交量', '买入', '卖出'] },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: 'rgba(20,24,32,0.92)',
      borderColor: line,
      textStyle: { color: '#fff', fontSize: 12 },
      formatter(params) {
        const p = params.find((x) => x.seriesType === 'candlestick')
        const ts = p?.axisValue || params[0]?.axisValue
        const bar = byTime.get(ts)
        if (!bar) return ts
        const chg = bar.open ? bar.close / bar.open - 1 : 0
        const lines = [
          `<b>${ts}</b>`,
          `开 ${n2(bar.open)}　高 ${n2(bar.high)}　低 ${n2(bar.low)}　收 ${n2(bar.close)}`,
          `<span style="color:${chg >= 0 ? UP : DOWN}">当根 ${pct(chg)}</span>　量 ${(bar.volume / 1e4).toFixed(1)} 万`,
        ]
        const tr = tradesByTime.get(ts)
        if (tr?.length) {
          lines.push(
            tr
              .map((t) => `<span style="color:${t.side === 'buy' ? UP : DOWN}">${t.side === 'buy' ? '买入' : '卖出'} ${t.qty} 份 @ ${n2(t.price)}</span>`)
              .join('<br/>'),
          )
        }
        return lines.join('<br/>')
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 62, right: 20, top: 32, height: '60%' },
      { left: 62, right: 20, top: '74%', height: '14%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: times,
        gridIndex: 0,
        boundaryGap: true,
        axisLabel: { color: muted, fontSize: 11, formatter: (v) => String(v).slice(-11) },
        axisLine: { lineStyle: { color: line } },
      },
      {
        type: 'category',
        data: times,
        gridIndex: 1,
        boundaryGap: true,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: line } },
      },
    ],
    yAxis: [
      {
        type: 'value',
        scale: true,
        gridIndex: 0,
        name: '价格',
        nameTextStyle: { color: muted, align: 'left' },
        axisLabel: { color: muted },
        splitLine: { lineStyle: { color: line } },
      },
      {
        type: 'value',
        gridIndex: 1,
        name: '量',
        nameTextStyle: { color: muted, align: 'left' },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: startPct, end: 100 },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        bottom: 2,
        height: 18,
        borderColor: line,
        textStyle: { color: muted },
        start: startPct,
        end: 100,
      },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: candles,
        itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
        markLine:
          avgCost > 0
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: idx, type: 'dashed', width: 1 },
                label: { color: idx, fontSize: 11, formatter: `成本 ${n2(avgCost)}`, position: 'insideEndTop' },
                data: [{ yAxis: avgCost }],
              }
            : undefined,
      },
      { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols, barWidth: '60%' },
      {
        name: '买入',
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 0,
        symbol: 'triangle',
        symbolSize: 12,
        itemStyle: { color: UP },
        data: buys.map((t) => [t.barTs, t.price]),
        z: 10,
      },
      {
        name: '卖出',
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 0,
        symbol: 'triangle',
        symbolRotate: 180,
        symbolSize: 12,
        itemStyle: { color: DOWN },
        data: sells.map((t) => [t.barTs, t.price]),
        z: 10,
      },
    ],
    color: [accent, idx, UP, DOWN],
  }
}

export { echarts }
