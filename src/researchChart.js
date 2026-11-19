// 策略研究图表：K 线 + 事件 marker + 区间框 + 买卖点；以及回测净值/回撤。
import * as echarts from 'echarts/core'
import { BarChart, CandlestickChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkPointComponent,
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
  MarkPointComponent,
  MarkAreaComponent,
  CanvasRenderer,
])

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
const n2 = (v) => (v == null || !Number.isFinite(+v) ? '-' : (+v).toFixed(2))
const pct = (v) => (v == null || !Number.isFinite(+v) ? '-' : (v * 100).toFixed(2) + '%')

export const EVENT_TYPES = ['SC', 'BC', 'AR', 'ST', 'Spring', 'Test', 'UTAD', 'SOS', 'SOW', 'LPS', 'LPSY']
export const EVENT_COLORS = {
  SC: '#e5484d',
  BC: '#f59e0b',
  AR: '#2563eb',
  ST: '#8b5cf6',
  Spring: '#06b6d4',
  Test: '#14b8a6',
  UTAD: '#d946ef',
  SOS: '#ef4444',
  SOW: '#16a34a',
  LPS: '#3b82f6',
  LPSY: '#a855f7',
}

/** 事件 marker 使用的日期：确认日（detectedDate），避免用发生日造成“提前知道”的错觉 */
const markerDate = (e) => e.detectedDate || e.occurredDate

export function buildResearchOption({ bars = [], events = [], ranges = [], trades = [] } = {}) {
  const dates = bars.map((b) => b[0])
  const byDate = new Map(bars.map((b) => [b[0], b]))
  const eventsByDate = new Map()
  for (const e of events) {
    if (!EVENT_TYPES.includes(e.type)) continue
    const d = markerDate(e)
    if (!eventsByDate.has(d)) eventsByDate.set(d, [])
    eventsByDate.get(d).push(e)
  }
  const tradesByDate = new Map()
  for (const t of trades || []) {
    if (!tradesByDate.has(t.date)) tradesByDate.set(t.date, [])
    tradesByDate.get(t.date).push(t)
  }

  const UP = css('--up') || '#e5484d'
  const DOWN = css('--down') || '#12a150'
  const text = css('--text')
  const muted = css('--muted')
  const line = css('--line')
  const accent = css('--accent')
  const idx = css('--idx')

  const candles = bars.map((b) => [b[1], b[4], b[3], b[2]])
  const volData = bars.map((b) => ({
    value: b[5],
    itemStyle: { color: b[4] >= b[1] ? UP : DOWN, opacity: 0.55 },
  }))

  const markPoints = events
    .filter((e) => EVENT_TYPES.includes(e.type) && Number.isFinite(+e.price) && dates.includes(markerDate(e)))
    .map((e) => ({
      name: e.type,
      coord: [markerDate(e), +e.price],
      symbol: 'pin',
      symbolSize: 30,
      itemStyle: { color: EVENT_COLORS[e.type] || muted },
      label: { show: false },
    }))

  const markAreas = ranges
    .filter((r) => Number.isFinite(+r.high) && Number.isFinite(+r.low))
    .map((r) => {
      const end = r.endIndex != null && dates[r.endIndex] ? dates[r.endIndex] : dates[dates.length - 1]
      const color = r.side === 'distribution' ? DOWN : r.side === 'accumulation' ? UP : muted
      return [
        { xAxis: r.startDate, yAxis: +r.low, itemStyle: { color, opacity: 0.06 }, silent: true },
        { xAxis: end, yAxis: +r.high, silent: true },
      ]
    })

  const buys = (trades || []).filter((t) => t.side === 'buy' && dates.includes(t.date))
  const sells = (trades || []).filter((t) => t.side === 'sell' && dates.includes(t.date))

  return {
    animation: false,
    textStyle: { color: text },
    legend: {
      top: 2,
      textStyle: { color: text },
      data: ['K线', '成交量', '买入', '卖出'],
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: 'rgba(20,24,32,0.92)',
      borderColor: line,
      textStyle: { color: '#fff', fontSize: 12 },
      formatter(params) {
        const p = params.find((x) => x.seriesType === 'candlestick')
        const date = p?.axisValue || params[0]?.axisValue
        const bar = byDate.get(date)
        if (!bar) return date
        const evs = eventsByDate.get(date)
        const tr = tradesByDate.get(date)
        const lines = [
          `<b>${date}</b>`,
          `开 ${n2(bar[1])}　高 ${n2(bar[2])}　低 ${n2(bar[3])}　收 ${n2(bar[4])}`,
          `量 ${(bar[5] / 1e4).toFixed(1)} 万`,
        ]
        if (evs?.length) {
          lines.push(
            '事件：' +
              evs
                .map((e) => `<span style="color:${EVENT_COLORS[e.type] || '#fff'}">${e.type}</span>${e.occurredDate && e.occurredDate !== e.detectedDate ? `(发生 ${e.occurredDate})` : ''}`)
                .join(' / '),
          )
        }
        if (tr?.length) {
          lines.push(tr.map((t) => `${t.side === 'buy' ? '买入' : '卖出'} ${t.qty} 份 @ ${n2(t.price)}`).join(' / '))
        }
        return lines.join('<br/>')
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 64, right: 24, top: 34, height: '58%' },
      { left: 64, right: 24, top: '72%', height: '14%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        gridIndex: 0,
        boundaryGap: true,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: line } },
      },
      {
        type: 'category',
        data: dates,
        gridIndex: 1,
        boundaryGap: true,
        axisLabel: { color: muted, fontSize: 11 },
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
        name: '成交量(万)',
        nameTextStyle: { color: muted, align: 'left' },
        axisLabel: { color: muted, formatter: (v) => (v / 1e4).toFixed(0) },
        splitLine: { show: false },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 60, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], bottom: 4, height: 20, borderColor: line, textStyle: { color: muted }, start: 60, end: 100 },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: candles,
        itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
        markPoint: { data: markPoints, tooltip: { show: false } },
        markArea: { silent: true, data: markAreas },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volData,
        barWidth: '60%',
      },
      {
        name: '买入',
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 0,
        symbol: 'triangle',
        symbolSize: 11,
        itemStyle: { color: UP },
        data: buys.map((t) => [t.date, +t.price]),
        z: 10,
        tooltip: { formatter: (p) => `买入 ${p.data[1]?.toFixed?.(2) ?? p.data[1]}` },
      },
      {
        name: '卖出',
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 0,
        symbol: 'triangle',
        symbolRotate: 180,
        symbolSize: 11,
        itemStyle: { color: DOWN },
        data: sells.map((t) => [t.date, +t.price]),
        z: 10,
      },
    ],
    // 保留色值引用，避免打包器摇树丢掉主题变量
    color: [accent, idx, UP, DOWN],
  }
}

export function buildEquityOption(equity = []) {
  const dates = equity.map((p) => p.date)
  const text = css('--text')
  const muted = css('--muted')
  const line = css('--line')
  const accent = css('--accent')
  const idx = css('--idx')
  const down = css('--down')

  return {
    animation: false,
    textStyle: { color: text },
    legend: { top: 2, textStyle: { color: text }, data: ['策略净值', '买入持有', '回撤'] },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: 'rgba(20,24,32,0.92)',
      borderColor: line,
      textStyle: { color: '#fff', fontSize: 12 },
      formatter(params) {
        const date = params[0]?.axisValue
        const lines = [`<b>${date}</b>`]
        for (const p of params) {
          if (p.seriesName === '回撤') lines.push(`回撤 ${pct(p.value)}`)
          else lines.push(`${p.seriesName} ${n2(p.value)}`)
        }
        return lines.join('<br/>')
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 64, right: 24, top: 30, height: '58%' },
      { left: 64, right: 24, top: '73%', height: '14%' },
    ],
    xAxis: [
      { type: 'category', data: dates, gridIndex: 0, boundaryGap: false, axisLabel: { show: false }, axisLine: { lineStyle: { color: line } } },
      { type: 'category', data: dates, gridIndex: 1, boundaryGap: false, axisLabel: { color: muted, fontSize: 11 }, axisLine: { lineStyle: { color: line } } },
    ],
    yAxis: [
      {
        type: 'value',
        scale: true,
        gridIndex: 0,
        name: '净值',
        nameTextStyle: { color: muted, align: 'left' },
        axisLabel: { color: muted },
        splitLine: { lineStyle: { color: line } },
      },
      {
        type: 'value',
        gridIndex: 1,
        name: '回撤',
        nameTextStyle: { color: muted, align: 'left' },
        // 回撤数值很小时标签会挤在一起，具体数值交给 tooltip
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1] },
      { type: 'slider', xAxisIndex: [0, 1], bottom: 4, height: 20, borderColor: line, textStyle: { color: muted } },
    ],
    series: [
      {
        name: '策略净值',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: equity.map((p) => p.equity),
        showSymbol: false,
        lineStyle: { width: 2, color: accent },
        itemStyle: { color: accent },
      },
      {
        name: '买入持有',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: equity.map((p) => p.benchmark),
        showSymbol: false,
        lineStyle: { width: 1.4, color: idx },
        itemStyle: { color: idx },
      },
      {
        name: '回撤',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: equity.map((p) => p.drawdown),
        showSymbol: false,
        areaStyle: { color: down, opacity: 0.18 },
        lineStyle: { width: 1, color: down },
        itemStyle: { color: down },
      },
    ],
  }
}

export { echarts }
