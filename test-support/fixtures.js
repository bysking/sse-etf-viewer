// 测试用合成行情：吸筹与派发两套完整 Wyckoff 场景。
const DAY = 864e5
const startUtc = Date.UTC(2024, 0, 1)

export const dateAt = (i) => new Date(startUtc + i * DAY).toISOString().slice(0, 10)
export const mk = (i, open, high, low, close, volume) => ({
  date: dateAt(i),
  open,
  high,
  low,
  close,
  volume,
})

export const WYCKOFF_TEST_CONFIG = {
  swing: { atrPeriod: 14, atrMult: 1.5, confirmBars: 2 },
  ar: { reboundAtr: 2.0, maxBars: 10 },
}

/** SC → AR → ST → Spring → Test → SOS → LPS */
export function accumulationBars() {
  const bars = []
  let i = 0
  for (let k = 0; k < 70; k++) {
    const c = 100 - k * 0.3
    bars.push(mk(i++, c + 0.2, c + 1.2, c - 1.2, c, 1_000_000))
  }
  bars.push(mk(i++, 80, 82, 78, 81, 5_000_000)) // SC
  bars.push(mk(i++, 80.5, 81.5, 79.0, 80.4, 800_000))
  bars.push(mk(i++, 80.6, 81.6, 79.1, 80.5, 800_000))
  bars.push(mk(i++, 80.7, 81.7, 79.2, 80.6, 800_000))
  bars.push(mk(i++, 81, 88, 80.5, 86.5, 1_500_000)) // AR
  for (let k = 0; k < 8; k++) {
    const c = 81.5 - k * 0.3
    bars.push(mk(i++, c + 0.2, c + 0.8, k === 7 ? 78.6 : c - 0.8, c, 700_000)) // ST
  }
  bars.push(mk(i++, 79.0, 80.0, 77.4, 79.5, 1_200_000)) // Spring
  bars.push(mk(i++, 79.4, 80.0, 78.2, 79.6, 500_000)) // Test
  bars.push(mk(i++, 88.2, 90.0, 86.0, 89.5, 4_000_000)) // SOS
  bars.push(mk(i++, 89.6, 89.8, 88.2, 89.3, 900_000)) // LPS
  for (let k = 0; k < 5; k++) bars.push(mk(i++, 89.3, 90.0, 88.6, 89.5, 1_000_000))
  return bars
}

/** BC → AR(向下) → ST → UTAD → SOW → LPSY */
export function distributionBars() {
  const bars = []
  let i = 0
  for (let k = 0; k < 70; k++) {
    const c = 80 + k * 0.3
    bars.push(mk(i++, c - 0.2, c + 1.2, c - 1.2, c, 1_000_000))
  }
  bars.push(mk(i++, 101, 102, 98, 100, 5_000_000)) // BC
  bars.push(mk(i++, 100, 100.6, 98.4, 99.2, 800_000))
  bars.push(mk(i++, 99.8, 100.4, 98.2, 99.0, 800_000))
  bars.push(mk(i++, 99.6, 100.2, 98.0, 98.8, 800_000))
  bars.push(mk(i++, 98, 99, 95, 96, 1_500_000)) // AR 向下
  for (let k = 0; k < 8; k++) {
    const c = 96 + k * 0.3
    bars.push(mk(i++, c - 0.2, k === 7 ? 101.4 : c + 0.8, c - 0.8, c, 700_000)) // ST
  }
  bars.push(mk(i++, 101.5, 102.6, 100.2, 101.5, 3_000_000)) // UTAD
  bars.push(mk(i++, 95.0, 95.2, 91.0, 92.0, 4_000_000)) // SOW
  bars.push(mk(i++, 92.0, 93.5, 91.5, 92.5, 700_000)) // LPSY
  for (let k = 0; k < 5; k++) bars.push(mk(i++, 92.5, 93.0, 91.8, 92.2, 1_000_000))
  return bars
}
