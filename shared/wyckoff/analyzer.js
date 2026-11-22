// 流式 Wyckoff 分析器：逐 bar 推进，只使用已确认信息。
// 输出 events / ranges / 每根 bar 的状态，供回测、事件研究、监控共用。
import { zscore } from '../indicators.js'
import { mergeConfig } from './config.js'
import { computeFeatures } from './features.js'
import { createPivotTracker, inferRangeSide, weeklyContext, weeklyEvents } from './structure.js'

/** API 返回的数组格式 → 引擎使用的对象格式 */
export function seriesToBars(series) {
  return (series || []).map(([date, open, high, low, close, volume]) => ({
    date,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }))
}

/**
 * 份额流对齐：把份额按日映射到价格 bar，计算 delta / 累计 / Z / 新鲜度。
 * @param {Array} bars
 * @param {Array<[string, number]|{date:string,value:number}>} shares
 */
export function computeShareFlow(bars, shares, userConfig = {}) {
  const cfg = mergeConfig(userConfig).shareFlow
  const rows = bars.map(() => ({
    value: null,
    delta: null,
    cum: null,
    z: null,
    fresh: false,
    staleDays: null,
    date: null,
  }))
  if (!cfg.enabled || !Array.isArray(shares) || !shares.length) {
    return { rows, z: new Array(bars.length).fill(null) }
  }

  const norm = shares
    .map((s) => (Array.isArray(s) ? { date: s[0], value: Number(s[1]) } : { date: s.date, value: Number(s.value) }))
    .filter((s) => s.date && Number.isFinite(s.value))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const values = new Array(bars.length).fill(null)
  let p = -1
  let observedAt = null
  for (let i = 0; i < bars.length; i++) {
    while (p + 1 < norm.length && norm[p + 1].date <= bars[i].date) {
      p++
      observedAt = i
    }
    if (p >= 0) {
      values[i] = norm[p].value
      const staleDays = observedAt == null ? null : i - observedAt
      rows[i] = {
        value: values[i],
        delta: null,
        cum: null,
        z: null,
        fresh: staleDays != null && staleDays <= cfg.staleMaxDays,
        staleDays,
        date: norm[p].date,
      }
    }
  }

  const deltas = new Array(bars.length).fill(null)
  for (let i = 1; i < bars.length; i++) {
    if (values[i] != null && values[i - 1] != null) deltas[i] = values[i] - values[i - 1]
  }
  const z = zscore(deltas, cfg.zWindow)

  const n = Math.max(1, cfg.cumulativeDays ?? 3)
  for (let i = 0; i < bars.length; i++) {
    if (values[i] == null) continue
    const cum = i >= n && values[i - n] != null ? values[i] - values[i - n] : null
    rows[i].delta = deltas[i]
    rows[i].z = z[i]
    rows[i].cum = cum
  }
  return { rows, z }
}

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d))

/**
 * 主分析入口。
 * @param {Array} bars 日 K 对象
 * @param {object} userConfig 策略 Wyckoff 参数（可覆盖默认值）
 * @param {object} options { shares }
 */
export function analyzeWyckoff(bars, userConfig = {}, options = {}) {
  if (!Array.isArray(bars) || !bars.length) {
    return { bars: bars || [], features: null, pivots: [], ranges: [], events: [], states: [], weekly: [], share: null }
  }

  const cfg = mergeConfig(userConfig)
  const features = computeFeatures(bars, cfg)
  const weekly = cfg.context?.weekly?.enabled ? weeklyContext(bars, cfg) : new Array(bars.length).fill(null)
  // 周线事件（可选）：只保留 weekEnd <= 当日 的事件，避免使用未收盘的本周数据
  const wEvents = cfg.context?.weekly?.events ? weeklyEvents(bars, cfg, analyzeWyckoff) : []
  const shareFlow = computeShareFlow(bars, options.shares, cfg)
  const share = shareFlow.rows

  const lows = bars.map((b) => b.low)
  const highs = bars.map((b) => b.high)
  const closes = bars.map((b) => b.close)
  const volumes = bars.map((b) => b.volume)
  const lowMin = rollingValues(lows, cfg.sc.lookback, 'min')
  const highMax = rollingValues(highs, cfg.bc.lookback, 'max')

  const tracker = createPivotTracker(bars, features.atr, cfg)
  const pivots = []
  const ranges = []
  const events = []
  const states = new Array(bars.length)

  let activeRange = null
  let lastRangeEnd = null
  let climax = null
  let pendingSpring = null
  let pendingUtad = null
  let phase = 'neutral'
  let confidence = 0

  const atrAt = (i) => {
    const a = features.atr[i]
    if (a && a > 0) return a
    return Math.max(1e-9, Number(bars[i].high) - Number(bars[i].low))
  }


  const setPhase = (p, c) => {
    phase = p
    confidence = Math.min(0.95, Math.max(0, c))
  }

  const snapshotRange = (r) =>
    r
      ? {
          id: r.id,
          startIndex: r.startIndex,
          startDate: r.startDate,
          detectedIndex: r.detectedIndex,
          high: round(r.high),
          low: round(r.low),
          side: r.side,
          seededBy: r.seededBy,
          status: r.status,
          brokenUp: !!r.brokenUp,
          brokenDown: !!r.brokenDown,
          hasClimax: !!r.climax,
          hasSos: !!r.sos,
          hasSow: !!r.sow,
          hasSpring: !!r.spring,
          hasUtad: !!r.utad,
          hasLps: !!r.lps,
          hasLpsy: !!r.lpsy,
        }
      : null

  const analyzeCore = (i) => {
    const bar = bars[i]
    const barEvents = []

    const makeEvent = (type, { occurredIndex = i, price = null, side = null, evidence = {}, ...rest } = {}) => ({
      type,
      side,
      occurredIndex,
      occurredDate: bars[occurredIndex]?.date ?? null,
      detectedIndex: i,
      detectedDate: bar.date,
      price,
      evidence: { ...evidence },
      rangeId: activeRange?.id ?? null,
      ...rest,
    })

    const pushEvent = (ev) => {
      events.push(ev)
      barEvents.push(ev)
      return ev
    }

    const startRange = (spec) => {
      if (activeRange) {
        activeRange.status = 'superseded'
        activeRange.endIndex = i
        lastRangeEnd = i
      }
      activeRange = {
        id: `R-${bars[spec.startIndex].date}`,
        startIndex: spec.startIndex,
        startDate: bars[spec.startIndex].date,
        detectedIndex: i,
        high: Math.max(spec.high, spec.low),
        low: Math.min(spec.high, spec.low),
        side: spec.side || 'neutral',
        seededBy: spec.seededBy || 'pivots',
        status: 'active',
        climax: spec.climax || null,
        arEvent: spec.arEvent || null,
        brokenUp: false,
        brokenDown: false,
        sos: null,
        sow: null,
        spring: null,
        test: null,
        utad: null,
        lps: null,
        lpsy: null,
        st: null,
      }
      ranges.push(activeRange)
      pendingSpring = null
      pendingUtad = null
      pushEvent(
        makeEvent('RangeStart', {
          occurredIndex: spec.startIndex,
          price: (activeRange.high + activeRange.low) / 2,
          side: activeRange.side,
          evidence: {
            high: round(activeRange.high),
            low: round(activeRange.low),
            widthAtr: round((activeRange.high - activeRange.low) / atrAt(i)),
            seededBy: activeRange.seededBy,
          },
        }),
      )
      setPhase(
        activeRange.side === 'distribution'
          ? 'distribution_A'
          : activeRange.side === 'accumulation'
            ? 'accumulation_A'
            : 'range',
        0.45,
      )
      return activeRange
    }

    const endRange = (status) => {
      if (!activeRange) return
      activeRange.status = status
      activeRange.endIndex = i
      lastRangeEnd = i
      const side = activeRange.side
      if (status === 'brokenUp') setPhase(side === 'accumulation' ? 'markup' : 'neutral', 0.6)
      else if (status === 'brokenDown') setPhase(side === 'distribution' ? 'markdown' : 'neutral', 0.6)
      else setPhase('neutral', 0.3)
      activeRange = null
      pendingSpring = null
      pendingUtad = null
    }

    const updatePivotCounts = () => {
      // pivot 范围允许用已确认新 pivot 微调边界；climax 范围由 SC/AR 锚定。
      if (!activeRange || activeRange.seededBy !== 'pivots' || activeRange.brokenUp || activeRange.brokenDown) return
      const a = atrAt(i)
      const hs = pivots.filter((p) => p.type === 'high' && p.detectedIndex <= i && p.index >= activeRange.startIndex)
      const ls = pivots.filter((p) => p.type === 'low' && p.detectedIndex <= i && p.index >= activeRange.startIndex)
      if (hs.length) {
        const h = Math.max(...hs.map((p) => p.price))
        if (h > activeRange.high && h - activeRange.high <= cfg.range.breakAtr * a) activeRange.high = h
      }
      if (ls.length) {
        const l = Math.min(...ls.map((p) => p.price))
        if (l < activeRange.low && activeRange.low - l <= cfg.range.breakAtr * a) activeRange.low = l
      }
    }

    const tryStartPivotRange = () => {
      if (activeRange || climax) return
      if (lastRangeEnd != null && i - lastRangeEnd < cfg.range.cooldownBars) return
      const recent = pivots.filter(
        (p) => p.detectedIndex <= i && p.index >= i - cfg.range.lookbackBars && (lastRangeEnd == null || p.index > lastRangeEnd),
      )
      const hs = recent.filter((p) => p.type === 'high')
      const ls = recent.filter((p) => p.type === 'low')
      if (hs.length < cfg.range.minTouches || ls.length < cfg.range.minTouches) return
      const high = Math.max(...hs.map((p) => p.price))
      const low = Math.min(...ls.map((p) => p.price))
      const startIndex = Math.min(...recent.map((p) => p.index))
      if (i - startIndex < cfg.range.minBars) return
      if (high <= low) return
      if ((high - low) / atrAt(i) > cfg.range.maxWidthAtr) return
      startRange({ high, low, startIndex, side: inferRangeSide(bars, startIndex, cfg.range), seededBy: 'pivots' })
    }

    const detectClimax = () => {
      if (climax && i - climax.index > cfg.ar.maxBars) climax = null
      if (climax) return
      const volZ = features.volZ[i]
      const spreadAtr = features.spreadAtr[i]
      const closePos = features.closePos[i]
      if (
        lowMin[i] != null &&
        bar.low <= lowMin[i] + 1e-9 &&
        volZ != null &&
        volZ >= cfg.sc.volZ &&
        spreadAtr != null &&
        spreadAtr >= cfg.sc.spreadAtr &&
        closePos >= cfg.sc.closePos
      ) {
        const ev = pushEvent(
          makeEvent('SC', {
            price: bar.low,
            side: 'accumulation',
            evidence: {
              volZ: round(volZ),
              spreadAtr: round(spreadAtr),
              closePos: round(closePos),
              lookbackLow: round(lowMin[i]),
            },
          }),
        )
        climax = { side: 'accumulation', index: i, price: bar.low, volume: bar.volume, volZ, event: ev }
        return
      }
      if (
        highMax[i] != null &&
        bar.high >= highMax[i] - 1e-9 &&
        volZ != null &&
        volZ >= cfg.bc.volZ &&
        spreadAtr != null &&
        spreadAtr >= cfg.bc.spreadAtr &&
        closePos <= cfg.bc.closePos
      ) {
        const ev = pushEvent(
          makeEvent('BC', {
            price: bar.high,
            side: 'distribution',
            evidence: {
              volZ: round(volZ),
              spreadAtr: round(spreadAtr),
              closePos: round(closePos),
              lookbackHigh: round(highMax[i]),
            },
          }),
        )
        climax = { side: 'distribution', index: i, price: bar.high, volume: bar.volume, volZ, event: ev }
      }
    }

    const detectAR = () => {
      if (!climax || i <= climax.index || i - climax.index > cfg.ar.maxBars) return
      const a = atrAt(i)
      if (climax.side === 'accumulation' && bar.high - climax.price >= cfg.ar.reboundAtr * a) {
        const ev = makeEvent('AR', {
          price: bar.high,
          side: 'accumulation',
          evidence: { reboundAtr: round((bar.high - climax.price) / a) },
        })
        startRange({
          high: bar.high,
          low: climax.price,
          startIndex: climax.index,
          side: 'accumulation',
          seededBy: 'climax',
          climax,
          arEvent: ev,
        })
        ev.rangeId = activeRange.id
        pushEvent(ev)
        activeRange.sc = climax.event
        climax = null
        return
      }
      if (climax.side === 'distribution' && climax.price - bar.low >= cfg.ar.reboundAtr * a) {
        const ev = makeEvent('AR', {
          price: bar.low,
          side: 'distribution',
          evidence: { reboundAtr: round((climax.price - bar.low) / a) },
        })
        startRange({
          high: climax.price,
          low: bar.low,
          startIndex: climax.index,
          side: 'distribution',
          seededBy: 'climax',
          climax,
          arEvent: ev,
        })
        ev.rangeId = activeRange.id
        pushEvent(ev)
        activeRange.bc = climax.event
        climax = null
      }
    }

    const detectST = () => {
      const r = activeRange
      if (!r || !r.climax || r.st || !r.arEvent || i <= r.arEvent.detectedIndex) return
      if (r.brokenUp || r.brokenDown) return
      const a = atrAt(i)
      const tol = cfg.st.toleranceAtr * a
      const volLower = !cfg.st.volBelowClimax || bar.volume < r.climax.volume
      if (r.side === 'accumulation') {
        if (Math.abs(bar.low - r.climax.price) <= tol && bar.close >= r.climax.price - 0.25 * a && volLower) {
          r.st = pushEvent(
            makeEvent('ST', {
              price: bar.low,
              side: 'accumulation',
              evidence: { distanceAtr: round((bar.low - r.climax.price) / a), volume: bar.volume },
            }),
          )
          setPhase('accumulation_B', confidence + 0.15)
        }
      } else if (r.side === 'distribution') {
        if (Math.abs(bar.high - r.climax.price) <= tol && bar.close <= r.climax.price + 0.25 * a && volLower) {
          r.st = pushEvent(
            makeEvent('ST', {
              price: bar.high,
              side: 'distribution',
              evidence: { distanceAtr: round((r.climax.price - bar.high) / a), volume: bar.volume },
            }),
          )
          setPhase('distribution_B', confidence + 0.15)
        }
      }
    }

    const detectSpring = () => {
      const r = activeRange
      if (!r || r.side !== 'accumulation' || r.spring || r.brokenUp || r.brokenDown) {
        pendingSpring = null
        return
      }
      if (pendingSpring && pendingSpring.rangeId !== r.id) pendingSpring = null
      const a = atrAt(i)
      const maxDepth = cfg.spring.maxBreakAtr * a

      if (pendingSpring) {
        if (bar.low < r.low && r.low - bar.low <= maxDepth && bar.low < pendingSpring.low) {
          pendingSpring.low = bar.low
          pendingSpring.occurredIndex = i
        }
        if (bar.close >= r.low) {
          const ev = pushEvent(
            makeEvent('Spring', {
              occurredIndex: pendingSpring.occurredIndex,
              price: pendingSpring.low,
              side: 'accumulation',
              evidence: {
                breakDepthAtr: round((r.low - pendingSpring.low) / a),
                volZ: round(features.volZ[i]),
                closePos: round(features.closePos[i]),
                volume: bar.volume,
              },
            }),
          )
          r.spring = ev
          pendingSpring = null
          setPhase('accumulation_C', confidence + 0.2)
        } else if (i - pendingSpring.firstBreakIndex > cfg.spring.confirmBars) {
          pendingSpring = null
        }
        return
      }

      if (bar.low < r.low && r.low - bar.low <= maxDepth) {
        pendingSpring = { rangeId: r.id, firstBreakIndex: i, occurredIndex: i, low: bar.low }
        if (bar.close >= r.low) {
          const ev = pushEvent(
            makeEvent('Spring', {
              occurredIndex: i,
              price: bar.low,
              side: 'accumulation',
              evidence: {
                breakDepthAtr: round((r.low - bar.low) / a),
                volZ: round(features.volZ[i]),
                closePos: round(features.closePos[i]),
                volume: bar.volume,
              },
            }),
          )
          r.spring = ev
          pendingSpring = null
          setPhase('accumulation_C', confidence + 0.2)
        }
      }
    }

    const detectTest = () => {
      const r = activeRange
      if (!r || !r.spring || r.test) return
      if (i <= r.spring.detectedIndex) return
      const a = atrAt(i)
      if (
        Math.abs(bar.low - r.spring.price) <= cfg.st.toleranceAtr * a &&
        bar.volume < (r.spring.evidence?.volume ?? Infinity) &&
        bar.close > r.spring.price
      ) {
        r.test = pushEvent(makeEvent('Test', { price: bar.low, side: 'accumulation', evidence: { volZ: round(features.volZ[i]) } }))
      }
    }

    const detectUtad = () => {
      const r = activeRange
      if (!r || r.side !== 'distribution' || r.utad || r.brokenUp || r.brokenDown) {
        pendingUtad = null
        return
      }
      if (pendingUtad && pendingUtad.rangeId !== r.id) pendingUtad = null
      const a = atrAt(i)
      const maxDepth = cfg.utad.maxBreakAtr * a

      if (pendingUtad) {
        if (bar.high > r.high && bar.high - r.high <= maxDepth && bar.high > pendingUtad.high) {
          pendingUtad.high = bar.high
          pendingUtad.occurredIndex = i
        }
        if (bar.close <= r.high) {
          const ev = pushEvent(
            makeEvent('UTAD', {
              occurredIndex: pendingUtad.occurredIndex,
              price: pendingUtad.high,
              side: 'distribution',
              evidence: {
                breakDepthAtr: round((pendingUtad.high - r.high) / a),
                volZ: round(features.volZ[i]),
                closePos: round(features.closePos[i]),
              },
            }),
          )
          r.utad = ev
          pendingUtad = null
          setPhase('distribution_C', confidence + 0.2)
        } else if (i - pendingUtad.firstBreakIndex > cfg.utad.confirmBars) {
          pendingUtad = null
        }
        return
      }

      if (bar.high > r.high && bar.high - r.high <= maxDepth) {
        pendingUtad = { rangeId: r.id, firstBreakIndex: i, occurredIndex: i, high: bar.high }
        if (bar.close <= r.high) {
          const ev = pushEvent(
            makeEvent('UTAD', {
              occurredIndex: i,
              price: bar.high,
              side: 'distribution',
              evidence: {
                breakDepthAtr: round((bar.high - r.high) / a),
                volZ: round(features.volZ[i]),
                closePos: round(features.closePos[i]),
              },
            }),
          )
          r.utad = ev
          pendingUtad = null
          setPhase('distribution_C', confidence + 0.2)
        }
      }
    }

    const detectSos = () => {
      const r = activeRange
      if (!r || r.sos || r.brokenDown || r.side === 'distribution') return
      const a = atrAt(i)
      if (
        bar.close > r.high + cfg.sos.breakAtr * a &&
        features.spreadAtr[i] != null &&
        features.spreadAtr[i] >= cfg.sos.spreadAtr &&
        features.closePos[i] >= cfg.sos.closePos &&
        features.volZ[i] != null &&
        features.volZ[i] >= cfg.sos.volZ
      ) {
        r.sos = pushEvent(
          makeEvent('SOS', {
            price: bar.close,
            side: 'accumulation',
            evidence: {
              breakAtr: round((bar.close - r.high) / a),
              spreadAtr: round(features.spreadAtr[i]),
              closePos: round(features.closePos[i]),
              volZ: round(features.volZ[i]),
            },
          }),
        )
        r.brokenUp = true
        pendingSpring = null
        setPhase('accumulation_D', confidence + 0.2)
      }
    }

    const detectSow = () => {
      const r = activeRange
      if (!r || r.sow || r.brokenUp || r.side === 'accumulation') return
      const a = atrAt(i)
      if (
        bar.close < r.low - cfg.sow.breakAtr * a &&
        features.spreadAtr[i] != null &&
        features.spreadAtr[i] >= cfg.sow.spreadAtr &&
        features.closePos[i] <= cfg.sow.closePos &&
        features.volZ[i] != null &&
        features.volZ[i] >= cfg.sow.volZ
      ) {
        r.sow = pushEvent(
          makeEvent('SOW', {
            price: bar.close,
            side: 'distribution',
            evidence: {
              breakAtr: round((r.low - bar.close) / a),
              spreadAtr: round(features.spreadAtr[i]),
              closePos: round(features.closePos[i]),
              volZ: round(features.volZ[i]),
            },
          }),
        )
        r.brokenDown = true
        pendingUtad = null
        setPhase('distribution_D', confidence + 0.2)
      }
    }

    const detectLps = () => {
      const r = activeRange
      if (!r || !r.sos || r.lps || i <= r.sos.detectedIndex) return
      if (i - r.sos.detectedIndex > cfg.lps.maxBars) return
      const a = atrAt(i)
      const volOk = !cfg.lps.volBelowMa || features.volMA[i] == null || bar.volume < features.volMA[i]
      if (bar.low <= r.high + cfg.lps.maxPullbackAtr * a && bar.close > r.high && volOk) {
        r.lps = pushEvent(
          makeEvent('LPS', {
            price: bar.low,
            side: 'accumulation',
            evidence: { pullbackAtr: round((r.high - bar.low) / a), volZ: round(features.volZ[i]) },
          }),
        )
        setPhase('accumulation_D', confidence + 0.1)
      }
    }

    const detectLpsy = () => {
      const r = activeRange
      if (!r || !r.sow || r.lpsy || i <= r.sow.detectedIndex) return
      if (i - r.sow.detectedIndex > cfg.lpsy.maxBars) return
      const a = atrAt(i)
      const volOk = !cfg.lpsy.volBelowMa || features.volMA[i] == null || bar.volume < features.volMA[i]
      if (bar.high >= r.low - cfg.lpsy.maxRallyAtr * a && bar.close < r.low && volOk) {
        r.lpsy = pushEvent(
          makeEvent('LPSY', {
            price: bar.high,
            side: 'distribution',
            evidence: { rallyAtr: round((bar.high - r.low) / a), volZ: round(features.volZ[i]) },
          }),
        )
        setPhase('distribution_D', confidence + 0.1)
      }
    }

    const detectRangeEnd = () => {
      const r = activeRange
      if (!r) return
      const a = atrAt(i)
      // SOS/SOW 之后区间仍要保留给 LPS/LPSY；只按时间收尾，
      // 避免 SOS 当根就触发通用突破、把区间立刻关掉。
      if (r.sos || r.sow) {
        if (i - (r.sos?.detectedIndex ?? r.sow.detectedIndex) > cfg.range.maxBarsAfterBreak) {
          endRange(r.sos ? 'brokenUp' : 'brokenDown')
        }
        return
      }
      if (bar.close > r.high + cfg.range.breakAtr * a) {
        pushEvent(makeEvent('RangeBreakUp', { price: bar.close, side: 'accumulation', evidence: { breakAtr: round((bar.close - r.high) / a) } }))
        endRange('brokenUp')
      } else if (bar.close < r.low - cfg.range.breakAtr * a) {
        pushEvent(makeEvent('RangeBreakDown', { price: bar.close, side: 'distribution', evidence: { breakAtr: round((r.low - bar.close) / a) } }))
        endRange('brokenDown')
      }
    }

    // 1) 新 pivot
    const newPivots = tracker.update(i)
    if (newPivots.length) pivots.push(...newPivots)

    // 2) 已有区间：更新边界、检测事件
    if (activeRange) updatePivotCounts()

    // 3) 无区间：SC/BC → AR 种子区间；或 pivot 区间
    if (!activeRange) {
      detectClimax()
      if (climax) detectAR()
      if (!activeRange) tryStartPivotRange()
    }

    // 4) 区间内事件
    if (activeRange) {
      detectST()
      detectSpring()
      detectTest()
      detectUtad()
      detectSos()
      detectSow()
      detectLps()
      detectLpsy()
      detectRangeEnd()
    }

    const snap = snapshotRange(activeRange)
    states[i] = {
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      atr: features.atr[i],
      volMA: features.volMA[i],
      volZ: features.volZ[i],
      closeMA: features.closeMA[i],
      spreadAtr: features.spreadAtr[i],
      closePos: features.closePos[i],
      progressAtr: features.progressAtr[i],
      effortResult: features.effortResult[i],
      weekly: weekly[i] || null,
      // 只暴露 detectedDate <= 当日的周线事件（as-of，无未来函数）
      weeklyEvents: wEvents.length
        ? wEvents.filter((e) => e.detectedDate && e.detectedDate <= bar.date).slice(-5)
        : undefined,
      share: share[i],
      range: snap,
      phase,
      confidence: round(confidence, 2),
      eventTypes: barEvents.map((e) => e.type),
      events: barEvents,
      lastPivot: pivots.length ? pivots[pivots.length - 1] : null,
    }
  }

  for (let i = 0; i < bars.length; i++) analyzeCore(i)

  return {
    bars,
    config: cfg,
    features,
    pivots,
    ranges,
    events,
    states,
    weekly,
    share,
  }
}

/** 滚动极值（不依赖 indicators 的 rollingMax/Min，避免重复数组分配） */
function rollingValues(values, period, kind) {
  const out = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1)
    out[i] = kind === 'min' ? Math.min(...win) : Math.max(...win)
  }
  return out
}
