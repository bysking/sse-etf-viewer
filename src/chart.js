import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { AxisPointerComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, AxisPointerComponent, CanvasRenderer])

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
const lastOf = (a) => {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]
  return null
}
const firstOf = (a) => a.find((x) => x != null) ?? null
const sgn = (v) => (v > 0 ? '+' : '')
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')

/**
 * 把 shares / index 归并到统一日期轴。
 * shares: [[date, 万份|null]]，index: [[date, close]]
 * null 表示当日无数据，必须保留为 null（不能算成 0，否则曲线会掉到 0）。
 */
export function prepare({ shares, index }) {
  const sMap = new Map(shares.map(([d, v]) => [d, v == null ? null : v / 1e4])) // 万份 → 亿份
  const iMap = new Map(index)
  const dates = [...new Set([...sMap.keys(), ...iMap.keys()])].sort()
  const rawS = dates.map((d) => (sMap.has(d) ? sMap.get(d) : null))
  const rawI = dates.map((d) => (iMap.has(d) ? iMap.get(d) : null))

  // 份额日变化：与上一个有数据的交易日比较（即“较上一交易日”）；
  // 跨度过大（如长期停牌/退市后复牌）则视为不连续，不出柱，避免假尖峰。
  const dayGap = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5
  const chg = []
  let prev = null // { v, d }
  for (let i = 0; i < dates.length; i++) {
    const v = rawS[i]
    if (v == null) {
      chg.push(null)
      continue
    }
    if (prev == null || dayGap(dates[i], prev.d) > 10) chg.push(null)
    else chg.push(v - prev.v)
    prev = { v, d: dates[i] }
  }
  return { dates, rawS, rawI, chg }
}

/** 统计卡片数据：[标签, 主值, 副值, 涨跌 class] */
export function computeStats({ rawS, rawI, dates }, indexName) {
  const s0 = firstOf(rawS)
  const s1 = lastOf(rawS)
  const i0 = firstOf(rawI)
  const i1 = lastOf(rawI)
  const sLastDate = dates[rawS.map((x) => x != null).lastIndexOf(true)] || '-'
  const iLastDate = dates[rawI.map((x) => x != null).lastIndexOf(true)] || '-'
  const cards = []
  if (s1 != null) {
    cards.push(['最新份额', s1.toFixed(2) + ' 亿份', sLastDate, ''])
    const d = s1 - s0
    const p = s0 ? (d / s0) * 100 : 0
    cards.push(['区间份额变化', sgn(d) + d.toFixed(2) + ' 亿份', sgn(p) + p.toFixed(2) + '%', cls(d)])
  }
  if (i1 != null) {
    const p = i0 ? (i1 / i0 - 1) * 100 : 0
    cards.push([`${indexName}区间涨跌`, sgn(p) + p.toFixed(2) + '%', `最新 ${i1.toFixed(2)}（${iLastDate}）`, cls(p)])
  }
  return cards
}

/** 纯函数：由已准备的序列生成 ECharts option（便于 React 端按需重渲染） */
export function buildOption({ dates, rawS, rawI, chg }, { norm }, indexName) {
  // 归一化（起点=100）
  const normArr = (a) => {
    const b = firstOf(a)
    return b ? a.map((x) => (x == null ? null : (x / b) * 100)) : a
  }
  const sv = norm ? normArr(rawS) : rawS
  const iv = norm ? normArr(rawI) : rawI

  const text = css('--text')
  const muted = css('--muted')
  const line = css('--line')
  const accent = css('--accent')
  const idxC = css('--idx')
  const UP = css('--up')
  const DOWN = css('--down')
  const f2 = (v) => (v == null ? '-' : (+v).toFixed(2))
  const f4 = (v) => (v == null ? '-' : (+v).toFixed(4))

  return {
    animation: false,
    textStyle: { color: text },
    legend: { top: 4, textStyle: { color: text }, data: ['ETF 份额', indexName, '份额日变化'] },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 66, right: 66, top: 44, height: '52%' },
      { left: 66, right: 66, top: '68%', height: '15%' },
    ],
    xAxis: [
      { type: 'category', data: dates, gridIndex: 0, boundaryGap: false, axisLabel: { show: false }, axisLine: { lineStyle: { color: line } } },
      { type: 'category', data: dates, gridIndex: 1, boundaryGap: true, axisLabel: { color: muted }, axisLine: { lineStyle: { color: line } } },
    ],
    yAxis: [
      {
        type: 'value', gridIndex: 0, scale: true,
        name: norm ? '份额(起点=100)' : '份额(亿份)', nameTextStyle: { color: accent, align: 'left' },
        axisLabel: { color: accent, formatter: (v) => +(+v).toFixed(2) }, splitLine: { lineStyle: { color: line } },
      },
      {
        type: 'value', gridIndex: 0, scale: true, position: 'right',
        name: norm ? '指数(起点=100)' : indexName, nameTextStyle: { color: idxC, align: 'right' },
        axisLabel: { color: idxC }, splitLine: { show: false },
      },
      {
        type: 'value', gridIndex: 1, scale: true,
        name: '日变化(亿份)', nameTextStyle: { color: muted, align: 'left' },
        axisLabel: { color: muted, formatter: (v) => +(+v).toFixed(2) }, splitLine: { lineStyle: { color: line } },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1] },
      { type: 'slider', xAxisIndex: [0, 1], bottom: 8, height: 22, borderColor: line, textStyle: { color: muted } },
    ],
    series: [
      {
        name: 'ETF 份额', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: sv, connectNulls: true, showSymbol: false,
        lineStyle: { width: 2, color: accent }, itemStyle: { color: accent }, areaStyle: { color: accent, opacity: 0.1 },
        tooltip: { valueFormatter: norm ? f2 : f4 },
      },
      {
        name: indexName, type: 'line', xAxisIndex: 0, yAxisIndex: 1, data: iv, connectNulls: true, showSymbol: false,
        lineStyle: { width: 1.8, color: idxC }, itemStyle: { color: idxC }, tooltip: { valueFormatter: f2 },
      },
      {
        name: '份额日变化', type: 'bar', xAxisIndex: 1, yAxisIndex: 2,
        data: chg.map((v) => (v == null ? null : { value: +v.toFixed(4), itemStyle: { color: v >= 0 ? UP : DOWN } })),
        tooltip: { valueFormatter: f4 },
      },
    ],
  }
}

export { echarts }
