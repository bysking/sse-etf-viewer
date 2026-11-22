// Wyckoff 引擎参数默认值与合并逻辑。
// 所有阈值都可被策略配置覆盖；回测与监控必须使用同一份配置。

export const ENGINE_VERSION = 'wyckoff-v1'

export const DEFAULT_CONFIG = {
  context: {
    benchmark: '000001',
    weekly: {
      enabled: true,
      maPeriod: 30,
      rangeWeeks: 20,
      // 周线事件识别：默认关闭，开启后会在周 K 上跑同一套事件检测
      events: false,
    },
  },
  shareFlow: {
    enabled: true,
    zWindow: 60,
    cumulativeDays: 3,
    staleMaxDays: 2,
  },
  swing: {
    atrPeriod: 14,
    atrMult: 1.5,
    confirmBars: 2,
  },
  range: {
    minBars: 20,
    maxWidthAtr: 3.0,
    minTouches: 2,
    breakAtr: 0.3,
    lookbackBars: 120,
    maxPivots: 8,
    cooldownBars: 5,
    maxBarsAfterBreak: 20,
    // pivot 区间的方向推断：区间起点之前 N 根的价格变化超过阈值时，
    // 分别视为吸筹（下跌后）或派发（上涨后），否则保持 neutral。
    sideLookbackBars: 60,
    sideMinReturn: 0.05,
  },
  volume: {
    maPeriod: 20,
    zWindow: 60,
    highZ: 1.5,
    lowZ: -0.5,
  },
  sc: {
    lookback: 60,
    volZ: 1.2,
    spreadAtr: 1.0,
    closePos: 0.4,
  },
  bc: {
    lookback: 60,
    volZ: 1.2,
    spreadAtr: 1.0,
    closePos: 0.6,
  },
  ar: {
    maxBars: 15,
    reboundAtr: 1.2,
  },
  st: {
    toleranceAtr: 0.5,
    volBelowClimax: true,
  },
  spring: {
    maxBreakAtr: 1.0,
    confirmBars: 5,
  },
  utad: {
    maxBreakAtr: 1.0,
    confirmBars: 5,
  },
  sos: {
    spreadAtr: 1.2,
    closePos: 0.7,
    volZ: 0.5,
    breakAtr: 0.3,
  },
  sow: {
    spreadAtr: 1.2,
    closePos: 0.3,
    volZ: 1.0,
    breakAtr: 0.3,
  },
  lps: {
    maxPullbackAtr: 1.0,
    volBelowMa: true,
    maxBars: 10,
  },
  lpsy: {
    maxRallyAtr: 1.0,
    volBelowMa: true,
    maxBars: 10,
  },
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (!isObj(extra)) return out
  for (const [k, v] of Object.entries(extra)) {
    // 显式 undefined 不应覆盖默认值（调用方常用 { context: cfg.context } 拼接）
    if (v === undefined) continue
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  }
  return out
}

/** 深合并用户配置，缺省值来自 DEFAULT_CONFIG */
export function mergeConfig(user = {}) {
  const out = deepMerge(DEFAULT_CONFIG, user)
  return out
}

/** 轻量校验：返回错误字符串数组；空数组表示通过 */
export function validateConfig(user = {}) {
  const errors = []
  const numeric = (path, v, min, max) => {
    if (v == null) return
    if (!Number.isFinite(v)) errors.push(`${path} 必须是数字`)
    else if (v < min || v > max) errors.push(`${path} 应在 ${min}–${max} 之间`)
  }
  const c = mergeConfig(user)
  numeric('swing.atrPeriod', c.swing.atrPeriod, 2, 200)
  numeric('swing.atrMult', c.swing.atrMult, 0.1, 10)
  numeric('swing.confirmBars', c.swing.confirmBars, 0, 20)
  numeric('range.minBars', c.range.minBars, 5, 500)
  numeric('range.maxWidthAtr', c.range.maxWidthAtr, 0.1, 20)
  numeric('range.minTouches', c.range.minTouches, 1, 20)
  numeric('range.breakAtr', c.range.breakAtr, 0, 5)
  numeric('range.sideLookbackBars', c.range.sideLookbackBars, 0, 500)
  numeric('range.sideMinReturn', c.range.sideMinReturn, 0, 1)
  numeric('volume.maPeriod', c.volume.maPeriod, 2, 200)
  numeric('volume.zWindow', c.volume.zWindow, 5, 500)
  numeric('sc.lookback', c.sc.lookback, 5, 1000)
  numeric('sc.volZ', c.sc.volZ, -10, 20)
  numeric('sc.spreadAtr', c.sc.spreadAtr, 0, 10)
  numeric('sc.closePos', c.sc.closePos, 0, 1)
  numeric('spring.maxBreakAtr', c.spring.maxBreakAtr, 0, 5)
  numeric('spring.confirmBars', c.spring.confirmBars, 0, 20)
  numeric('sos.breakAtr', c.sos.breakAtr, 0, 5)
  numeric('sow.breakAtr', c.sow.breakAtr, 0, 5)
  return errors
}
