// 纯函数指标库：输入数组、输出等长数组；数据不足处为 null。
// 前端（预览/图表）与后端（回测/监控）共用，避免两套公式漂移。

const num = (v) => (Number.isFinite(v) ? v : null)

/** 简单移动平均 */
export function sma(values, period) {
  const out = new Array(values.length).fill(null)
  if (period <= 0) return out
  let sum = 0
  let count = 0
  for (let i = 0; i < values.length; i++) {
    const v = num(values[i])
    if (v != null) {
      sum += v
      count++
    }
    // 无论当前值是否为空，离开窗口的旧值都要移除
    if (i >= period) {
      const old = num(values[i - period])
      if (old != null) {
        sum -= old
        count--
      }
    }
    if (v != null && count === period) out[i] = sum / period
  }
  return out
}

/** 指数移动平均：用前 period 个有效值的中位数/均值做种子 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null)
  if (period <= 0) return out
  const k = 2 / (period + 1)
  let seed = []
  let prev = null
  for (let i = 0; i < values.length; i++) {
    const v = num(values[i])
    if (v == null) {
      out[i] = prev
      continue
    }
    if (prev == null) {
      seed.push(v)
      if (seed.length === period) {
        prev = seed.reduce((a, b) => a + b, 0) / seed.length
        out[i] = prev
        seed = []
      }
      continue
    }
    prev = v * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** 真实波幅 */
export function trueRange(bars) {
  return bars.map((b, i) => {
    const high = Number(b.high)
    const low = Number(b.low)
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null
    if (i === 0) return high - low
    const pc = Number(bars[i - 1].close)
    if (!Number.isFinite(pc)) return high - low
    return Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc))
  })
}

/**
 * ATR（Wilder 平滑）。第一根用 TR，之后 ATR = (prev*(n-1)+TR)/n。
 * 与常见的 ATR(14) 口径一致。
 */
export function atr(bars, period = 14) {
  const tr = trueRange(bars)
  const out = new Array(bars.length).fill(null)
  if (period <= 0) return out
  let prev = null
  for (let i = 0; i < tr.length; i++) {
    const t = num(tr[i])
    if (t == null) {
      out[i] = prev
      continue
    }
    if (i < period) {
      // 前 period-1 根只记录种子，不输出
      if (i === period - 1) {
        let seed = 0
        let n = 0
        for (let j = 0; j < period; j++) {
          const x = num(tr[j])
          if (x != null) {
            seed += x
            n++
          }
        }
        prev = n ? seed / n : null
        out[i] = prev
      }
      continue
    }
    prev = prev == null ? t : (prev * (period - 1) + t) / period
    out[i] = prev
  }
  // 若数据不足 period 根，不输出（保持 null）
  return out
}

/** 滚动标准差（总体标准差） */
export function stddev(values, period) {
  const out = new Array(values.length).fill(null)
  if (period <= 0) return out
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1)
    if (win.some((v) => num(v) == null)) continue
    const mean = win.reduce((a, b) => a + b, 0) / period
    const variance = win.reduce((a, b) => a + (b - mean) ** 2, 0) / period
    out[i] = Math.sqrt(variance)
  }
  return out
}

/** 滚动 Z 分数：(x - mean) / std；std=0 时为 0 */
export function zscore(values, period) {
  const sd = stddev(values, period)
  const mean = sma(values, period)
  return values.map((v, i) => {
    if (num(v) == null || mean[i] == null || sd[i] == null) return null
    return sd[i] === 0 ? 0 : (v - mean[i]) / sd[i]
  })
}

/** 滚动最大值 */
export function rollingMax(values, period) {
  const out = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1)
    if (win.every((v) => num(v) == null)) continue
    out[i] = win.reduce((m, v) => (num(v) == null ? m : Math.max(m, v)), -Infinity)
  }
  return out
}

/** 滚动最小值 */
export function rollingMin(values, period) {
  const out = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1)
    if (win.every((v) => num(v) == null)) continue
    out[i] = win.reduce((m, v) => (num(v) == null ? m : Math.min(m, v)), Infinity)
  }
  return out
}

/** N 日变化率 */
export function pctChange(values, period = 1) {
  return values.map((v, i) => {
    if (i < period) return null
    const prev = num(values[i - period])
    const cur = num(v)
    if (prev == null || cur == null || prev === 0) return null
    return cur / prev - 1
  })
}

/** N 日滚动求和 */
export function sum(values, period) {
  const out = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1)
    if (win.some((v) => num(v) == null)) continue
    out[i] = win.reduce((a, b) => a + b, 0)
  }
  return out
}

/** RSI（Wilder 平滑） */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null)
  if (period <= 0) return out
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i < values.length; i++) {
    const prev = num(values[i - 1])
    const cur = num(values[i])
    if (prev == null || cur == null) continue
    const ch = cur - prev
    const gain = Math.max(0, ch)
    const loss = Math.max(0, -ch)
    if (i < period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (i === period - 1) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
      continue
    }
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

/** MACD：返回 { dif, dea, hist } */
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast)
  const s = ema(values, slow)
  const dif = values.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]))
  const dea = ema(dif.filter((v) => v != null), signal)
  // 上面的 dea 与 dif 索引错位；重新按有效值对齐
  const difVals = dif.filter((v) => v != null)
  const deaRaw = dea
  const deaAligned = new Array(values.length).fill(null)
  let k = 0
  for (let i = 0; i < dif.length; i++) {
    if (dif[i] != null) {
      deaAligned[i] = deaRaw[k] ?? null
      k++
    }
  }
  const hist = dif.map((v, i) => (v == null || deaAligned[i] == null ? null : v - deaAligned[i]))
  return { dif, dea: deaAligned, hist }
}

/** 最后一个非空值 */
export function lastValue(values) {
  for (let i = values.length - 1; i >= 0; i--) if (num(values[i]) != null) return values[i]
  return null
}

/** 第一个非空值 */
export function firstValue(values) {
  for (const v of values) if (num(v) != null) return v
  return null
}
