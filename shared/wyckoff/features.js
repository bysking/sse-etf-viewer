// L1 量价基础特征：振幅、收盘位置、量能 Z、价格进展、努力/结果分类。
import { atr, sma, zscore } from '../indicators.js'
import { mergeConfig } from './config.js'

export function classifyEffort(volZ, progressAtr, bullish, cfg) {
  if (volZ == null || progressAtr == null) return 'neutral'
  if (volZ >= cfg.volume.highZ && progressAtr < 0.5) return 'absorption'
  if (!bullish && volZ <= cfg.volume.lowZ) return 'noSupply'
  if (bullish && volZ <= cfg.volume.lowZ) return 'noDemand'
  if (volZ >= 0.5 && progressAtr >= 1.0) return 'genuineMove'
  return 'neutral'
}

/**
 * @param {Array<{date:string,open:number,high:number,low:number,close:number,volume:number}>} bars
 * @param {object} userConfig
 */
export function computeFeatures(bars, userConfig = {}) {
  const cfg = mergeConfig(userConfig)
  const closes = bars.map((b) => Number(b.close))
  const volumes = bars.map((b) => Number(b.volume))
  const atrArr = atr(bars, cfg.swing.atrPeriod)
  const volMA = sma(volumes, cfg.volume.maPeriod)
  const volZ = zscore(volumes, cfg.volume.zWindow)
  const closeMA = sma(closes, 50)

  const spreadAtr = bars.map((b, i) => {
    const a = atrArr[i]
    if (!a || a <= 0) return null
    return (Number(b.high) - Number(b.low)) / a
  })

  const closePos = bars.map((b) => {
    const high = Number(b.high)
    const low = Number(b.low)
    const range = high - low
    if (!Number.isFinite(range) || range <= 0) return 0.5
    return (Number(b.close) - low) / range
  })

  const progressAtr = bars.map((b, i) => {
    const a = atrArr[i]
    if (!a || a <= 0 || i === 0) return null
    return Math.abs(Number(b.close) - Number(bars[i - 1].close)) / a
  })

  const bullish = bars.map((b, i) => {
    if (i === 0) return Number(b.close) >= Number(b.open)
    return Number(b.close) >= Number(bars[i - 1].close)
  })

  const effortResult = bars.map((b, i) => classifyEffort(volZ[i], progressAtr[i], bullish[i], cfg))

  return {
    config: cfg,
    atr: atrArr,
    volMA,
    volZ,
    closeMA,
    spreadAtr,
    closePos,
    progressAtr,
    bullish,
    effortResult,
  }
}
