// Wyckoff 参数校准：多标的、训练/验证分段，输出事件样本量与前向收益。
// 用法：node scripts/calibrate-wyckoff.mjs
import { getKline } from '../server/data/kline.js'
import { seriesToBars, analyzeWyckoff } from '../shared/wyckoff/analyzer.js'
import { eventStudy } from '../shared/wyckoff/eventStudy.js'

// 可用 CODES=000001,510180,... 覆盖标的清单，便于样本外检验。
const CODES = (process.env.CODES || '510300,510050,510500,588000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const START = process.env.START || '2016-11-19'
const END = process.env.END || '2026-11-19'
const TRAIN_END = '2023-12-31'
const VAL_START = '2024-01-01'
const HORIZON = 10

const ENTRY_TYPES = ['SC', 'AR', 'ST', 'Spring', 'Test', 'SOS', 'LPS']
const EXIT_TYPES = ['BC', 'UTAD', 'SOW', 'LPSY']
const SHOW_TYPES = [...ENTRY_TYPES, ...EXIT_TYPES]

const VARIANTS = {
  legacy: {
    spring: { maxBreakAtr: 0.5, confirmBars: 3 },
    utad: { maxBreakAtr: 0.5, confirmBars: 3 },
    sc: { volZ: 1.5, spreadAtr: 1.2 },
    bc: { volZ: 1.5, spreadAtr: 1.2 },
    ar: { reboundAtr: 1.5, maxBars: 10 },
    sos: { volZ: 0.5, breakAtr: 0.3 },
    sow: { volZ: 1.0, closePos: 0.3, breakAtr: 0.3 },
  },
  calibrated_default: {},
  legacy_except_spring: {
    spring: { maxBreakAtr: 1.0, confirmBars: 5 },
    utad: { maxBreakAtr: 1.0, confirmBars: 5 },
    sc: { volZ: 1.5, spreadAtr: 1.2 },
    bc: { volZ: 1.5, spreadAtr: 1.2 },
    ar: { reboundAtr: 1.5, maxBars: 10 },
    sos: { volZ: 0.5, breakAtr: 0.3 },
    sow: { volZ: 1.0, closePos: 0.3, breakAtr: 0.3 },
  },
  calibrated_strong_legacy: {
    sos: { volZ: 0.5, breakAtr: 0.3 },
    sow: { volZ: 1.0, closePos: 0.3, breakAtr: 0.3 },
  },
  spring_wide: { spring: { maxBreakAtr: 1.0, confirmBars: 5 }, utad: { maxBreakAtr: 1.0, confirmBars: 5 } },
  climax_easy: {
    sc: { volZ: 1.2, spreadAtr: 1.0 },
    bc: { volZ: 1.2, spreadAtr: 1.0 },
    ar: { reboundAtr: 1.2, maxBars: 15 },
  },
  strong_easy: {
    sos: { volZ: 0, breakAtr: 0.2 },
    sow: { volZ: 0.5, closePos: 0.4, breakAtr: 0.2 },
  },
  range_wide: { range: { minBars: 15, maxWidthAtr: 4.0, lookbackBars: 180 } },
  balanced: {
    spring: { maxBreakAtr: 0.8, confirmBars: 4 },
    utad: { maxBreakAtr: 0.8, confirmBars: 4 },
    sc: { volZ: 1.3, spreadAtr: 1.1 },
    bc: { volZ: 1.3, spreadAtr: 1.1 },
    ar: { reboundAtr: 1.3, maxBars: 12 },
    sos: { volZ: 0.2, breakAtr: 0.25 },
    sow: { volZ: 0.7, closePos: 0.4, breakAtr: 0.25 },
    range: { minBars: 18, maxWidthAtr: 3.5 },
  },
  calibrated_no_range: {
    spring: { maxBreakAtr: 1.0, confirmBars: 5 },
    utad: { maxBreakAtr: 1.0, confirmBars: 5 },
    sc: { volZ: 1.2, spreadAtr: 1.0 },
    bc: { volZ: 1.2, spreadAtr: 1.0 },
    ar: { reboundAtr: 1.2, maxBars: 15 },
    sos: { volZ: 0, breakAtr: 0.2 },
    sow: { volZ: 0.5, closePos: 0.4, breakAtr: 0.2 },
  },
  combined: {
    spring: { maxBreakAtr: 1.0, confirmBars: 5 },
    utad: { maxBreakAtr: 1.0, confirmBars: 5 },
    sc: { volZ: 1.2, spreadAtr: 1.0 },
    bc: { volZ: 1.2, spreadAtr: 1.0 },
    ar: { reboundAtr: 1.2, maxBars: 15 },
    sos: { volZ: 0, breakAtr: 0.2 },
    sow: { volZ: 0.5, closePos: 0.4, breakAtr: 0.2 },
    range: { minBars: 15, maxWidthAtr: 4.0, lookbackBars: 180 },
  },
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const win = (a) => (a.length ? a.filter((x) => x > 0).length / a.length : null)
const f = (v, d = 2) => (v == null ? '-' : (v * 100).toFixed(d) + '%')
const stat = (arr) => `${String(arr.length).padStart(3)} ${f(mean(arr)).padStart(8)} ${f(win(arr), 0).padStart(4)}`

function splitOf(date) {
  if (date <= TRAIN_END) return 'train'
  if (date >= VAL_START) return 'val'
  return null
}

async function loadBars() {
  const out = {}
  for (const code of CODES) {
    const k = await getKline(code, START, END)
    out[code] = seriesToBars(k.series)
    console.log(`loaded ${code}: ${out[code].length} bars`)
  }
  return out
}

function runVariant(barsByCode, cfg) {
  const agg = {}
  for (const bars of Object.values(barsByCode)) {
    const analysis = analyzeWyckoff(bars, cfg)
    const study = eventStudy(bars, analysis.events, { horizons: [HORIZON] })
    for (const row of study.rows) {
      const split = splitOf(row.detectedDate)
      const h = row.horizons[HORIZON]
      if (!split || !h) continue
      if (!agg[row.type]) agg[row.type] = { train: [], val: [] }
      agg[row.type][split].push(h.return)
    }
  }
  return agg
}

function printVariant(name, agg) {
  console.log(`\n== ${name} ==`)
  console.log('type      train n/avg/win        val n/avg/win')
  for (const type of SHOW_TYPES) {
    const a = agg[type] || { train: [], val: [] }
    console.log(`${type.padEnd(8)} ${stat(a.train)}   ${stat(a.val)}`)
  }
  for (const [label, types] of [['entry', ENTRY_TYPES], ['exit', EXIT_TYPES]]) {
    const train = types.flatMap((t) => agg[t]?.train || [])
    const val = types.flatMap((t) => agg[t]?.val || [])
    console.log(`${label.padEnd(8)} ${stat(train)}   ${stat(val)}`)
  }
}

const barsByCode = await loadBars()
for (const [name, cfg] of Object.entries(VARIANTS)) {
  printVariant(name, runVariant(barsByCode, cfg))
}
