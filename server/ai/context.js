// 把行情/事件/事件研究压缩成给大模型的上下文，控制 token 与信息密度。
import { eventStudy } from '../../shared/wyckoff/eventStudy.js'

const CORE_EVENTS = ['SC', 'BC', 'AR', 'ST', 'Spring', 'Test', 'UTAD', 'SOS', 'SOW', 'LPS', 'LPSY']
const EVIDENCE_KEYS = ['volZ', 'spreadAtr', 'closePos', 'breakDepthAtr', 'breakAtr', 'reboundAtr', 'pullbackAtr', 'rallyAtr']
const f = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '-' : (+v).toFixed(d))
const pct = (v) => (v == null || !Number.isFinite(+v) ? '-' : ((+v) * 100).toFixed(2) + '%')

function compactEvidence(ev = {}) {
  const out = {}
  for (const k of EVIDENCE_KEYS) if (ev[k] != null && Number.isFinite(+ev[k])) out[k] = +(+ev[k]).toFixed(2)
  return out
}

/**
 * @param {object} p
 * @param {string} p.code
 * @param {string} p.start
 * @param {string} p.end
 * @param {Array} p.bars 对象格式 bars
 * @param {object} p.analysis analyzeWyckoff 结果
 * @param {object} [p.study] eventStudy 结果；不传则内部计算
 * @param {number} [p.maxBars=60]
 * @param {number} [p.maxEvents=20]
 */
export function buildMarketContext({ code, start, end, bars, analysis, study, maxBars = 60, maxEvents = 20 }) {
  const last = analysis.states?.[analysis.states.length - 1] || null
  const counts = {}
  for (const e of analysis.events) counts[e.type] = (counts[e.type] || 0) + 1

  const events = (analysis.events || [])
    .filter((e) => CORE_EVENTS.includes(e.type))
    .slice(-maxEvents)
    .map((e) => ({
      type: e.type,
      side: e.side ?? null,
      occurredDate: e.occurredDate,
      detectedDate: e.detectedDate,
      price: e.price == null ? null : +(+e.price).toFixed(3),
      rangeId: e.rangeId ?? null,
      evidence: compactEvidence(e.evidence),
    }))

  const es = study || eventStudy(bars, analysis.events, { horizons: [10, 20] })
  const stats = (es.summary || [])
    .filter((s) => CORE_EVENTS.includes(s.type))
    .map((s) => ({
      type: s.type,
      horizon: s.horizon,
      count: s.count,
      avgReturn: s.avgReturn,
      winRate: s.winRate,
      avgMfe: s.avgMfe,
      avgMae: s.avgMae,
    }))

  const recentBars = (bars || []).slice(-maxBars).map((b) => [
    b.date,
    +(+b.open).toFixed(3),
    +(+b.high).toFixed(3),
    +(+b.low).toFixed(3),
    +(+b.close).toFixed(3),
    Math.round(Number(b.volume) || 0),
  ])

  const summary = {
    code,
    start,
    end,
    bars: bars.length,
    lastDate: last?.date ?? null,
    lastClose: last?.close ?? null,
    phase: last?.phase ?? null,
    confidence: last?.confidence ?? null,
    range: last?.range ?? null,
    weekly: last?.weekly ?? null,
    share: last?.share ?? null,
    eventCounts: counts,
    rangeCount: (analysis.ranges || []).length,
    latestEvents: events,
    eventStats: stats,
  }

  const lines = []
  lines.push(`【标的】${code}  区间 ${start} ~ ${end}  共 ${bars.length} 根日K`)
  if (last) lines.push(`【最新】${last.date} 收盘 ${f(last.close, 3)}；ATR ${f(last.atr)}；量能Z ${f(last.volZ)}`)
  lines.push(`【当前阶段】${last?.phase ?? 'neutral'}（置信度 ${f(last?.confidence)}）`)
  if (last?.range) {
    const r = last.range
    lines.push(
      `【交易区间】${r.id} ${r.side} ${f(r.low, 2)}–${f(r.high, 2)}（${r.status}，起始 ${r.startDate}）`,
    )
  }
  if (last?.weekly) {
    const w = last.weekly
    lines.push(
      `【周线背景】weekEnd ${w.weekEnd}；趋势 ${w.trend}；阶段 ${w.phase}；收盘 ${f(w.close, 2)}；MA ${f(w.ma, 2)}；区间位置 ${f(w.position, 2)}`,
    )
  }
  if (last?.share?.value != null) {
    const s = last.share
    lines.push(
      `【份额流】${s.date} 值 ${f(s.value, 2)} 万份；delta ${f(s.delta, 2)}；累计 ${f(s.cum, 2)}；Z ${f(s.z)}；fresh=${s.fresh}`,
    )
  }
  lines.push(`【事件数量】${CORE_EVENTS.map((t) => `${t} ${counts[t] || 0}`).join(' / ')}；区间 ${summary.rangeCount} 个`)
  if (stats.length) {
    lines.push('【事件研究（次日开盘，10/20日）】')
    for (const s of stats) {
      lines.push(`- ${s.type} ${s.horizon}日：样本 ${s.count}，均收益 ${pct(s.avgReturn)}，胜率 ${pct(s.winRate)}，MFE ${pct(s.avgMfe)}，MAE ${pct(s.avgMae)}`)
    }
  }
  if (events.length) {
    lines.push('【最近事件】')
    for (const e of events) {
      const ev = Object.entries(e.evidence).map(([k, v]) => `${k}=${v}`).join(' ')
      lines.push(`- ${e.detectedDate} 确认 ${e.type}（发生 ${e.occurredDate}）${e.side || ''} 价格 ${f(e.price, 3)} 区间 ${e.rangeId || '-'} ${ev}`)
    }
  }
  lines.push(`【最近 ${recentBars.length} 根日K】date,open,high,low,close,volume`)
  for (const b of recentBars) lines.push(b.join(','))

  lines.push(
    '【数据说明】事件在确认日才可见；事件研究为次日开盘入场、未计费用；复权口径为未复权；样本量可能很小，请明确提示不确定性；不构成投资建议。',
  )

  return { summary, text: lines.join('\n') }
}
