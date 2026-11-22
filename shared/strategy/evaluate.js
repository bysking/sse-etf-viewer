// 策略条件 AST 求值。只依赖 analyzer 的状态/事件，前后端与回测/监控共用。

const typeOf = (e) => String(e?.type || '').toLowerCase()

export function latestEvent(events, i, type, withinBars = 5) {
  const want = String(type).toLowerCase()
  const limit = Number.isFinite(withinBars) ? withinBars : Infinity
  let found = null
  for (const e of events) {
    if (e.detectedIndex > i) break
    if (typeOf(e) !== want) continue
    if (i - e.detectedIndex <= limit) found = e
  }
  return found
}

function compare(actual, cond) {
  if (cond == null) return true
  if (typeof cond === 'boolean') return Boolean(actual) === cond
  if (typeof cond === 'number') return actual === cond
  if (typeof cond === 'string') return actual === cond
  if (typeof cond === 'object') {
    if ('gte' in cond) return actual != null && actual >= cond.gte
    if ('gt' in cond) return actual != null && actual > cond.gt
    if ('lte' in cond) return actual != null && actual <= cond.lte
    if ('lt' in cond) return actual != null && actual < cond.lt
    if ('eq' in cond) return actual === cond.eq
  }
  return false
}

function eventValue(event, state, key) {
  if (key === 'volumeZ' || key === 'volZ') return event.evidence?.volZ ?? state.volZ
  if (key === 'closeBackInRange') {
    // Spring / UTAD 按定义就是收回区间内
    return event.evidence?.closeBackInRange ?? ['spring', 'utad'].includes(typeOf(event))
  }
  return event.evidence?.[key] ?? event[key] ?? state[key]
}

function matchEvent(node, ctx) {
  const spec = typeof node.event === 'string' ? { type: node.event } : node.event || {}
  const type = spec.type ?? node.type
  if (!type) return false
  const ev = latestEvent(ctx.events, ctx.i, type, node.withinBars ?? spec.withinBars ?? 5)
  if (!ev) return false
  const require = node.require ?? spec.require
  if (!require) return true
  return Object.entries(require).every(([k, cond]) => compare(eventValue(ev, ctx.state, k), cond))
}

function matchPhase(node, state) {
  const spec = node.phase
  if (!spec) return false
  const inList = spec.in ?? spec.eq
  const ok = Array.isArray(inList) ? inList.includes(state.phase) : inList ? state.phase === inList : true
  const conf = spec.minConfidence
  return ok && (conf == null || (state.confidence ?? 0) >= conf)
}

function matchWeekly(node, state) {
  const spec = node.weekly
  if (!spec || !state.weekly) return false
  const w = state.weekly
  if (spec.phaseIn && !spec.phaseIn.includes(w.phase)) return false
  if (spec.trendIn && !spec.trendIn.includes(w.trend)) return false
  if (spec.closeAboveMa != null) {
    const above = w.ma != null && w.close > w.ma
    if (above !== Boolean(spec.closeAboveMa)) return false
  }
  if (spec.positionGte != null && (w.position == null || w.position < spec.positionGte)) return false
  if (spec.positionLte != null && (w.position == null || w.position > spec.positionLte)) return false
  return true
}

function matchShareFlow(node, state) {
  const spec = node.shareFlow
  if (!spec || !state.share) return false
  const s = state.share
  if (spec.requireFresh && !s.fresh) return false
  // 注意：累计窗口由 analyzer 的 shareFlow.cumulativeDays 决定；
  // 这里的 cumulativeDays 仅作为文档提示，不重新计算。
  if (spec.gt != null && !(s.cum != null && s.cum > spec.gt)) return false
  if (spec.gte != null && !(s.cum != null && s.cum >= spec.gte)) return false
  if (spec.lt != null && !(s.cum != null && s.cum < spec.lt)) return false
  if (spec.lte != null && !(s.cum != null && s.cum <= spec.lte)) return false
  if (spec.valueGt != null && !(s.value != null && s.value > spec.valueGt)) return false
  return true
}

/** 周线事件条件：只匹配已收盘周的事件（state.weeklyEvents 已是 as-of） */
function matchWeeklyEvent(node, state) {
  const spec = node.weeklyEvent
  if (!spec || !Array.isArray(state.weeklyEvents) || !state.weeklyEvents.length) return false
  const want = String(spec.type || spec.event || '').toLowerCase()
  if (!want) return false
  const withinWeeks = Number.isFinite(spec.withinWeeks) ? spec.withinWeeks : 4
  const events = state.weeklyEvents
  const latest = events[events.length - 1]
  if (!latest || String(latest.type).toLowerCase() !== want) return false
  // withinWeeks 按自然周估算：与最近一次匹配事件的日期差
  const gapDays = (Date.parse(state.date) - Date.parse(latest.detectedDate)) / 864e5
  return gapDays <= withinWeeks * 7
}

function matchFilter(node, state) {
  const spec = node.filter
  if (!spec) return false
  const fn = spec.fn
  if (fn === 'closeAbove') {
    const above = state.closeMA != null && state.close > state.closeMA
    return above === (spec.value ?? true)
  }
  if (fn === 'volZ') {
    return compare(state.volZ, spec)
  }
  if (fn === 'close') {
    return compare(state.close, spec)
  }
  return false
}

/** 条件树求值；stopLoss/takeProfit 属于风险节点，不参与触发判断 */
export function match(node, ctx) {
  if (!node) return false
  if (node === true) return true
  if (node === false) return false
  if (Array.isArray(node)) return node.every((n) => match(n, ctx))
  if (node.all) return node.all.every((n) => match(n, ctx))
  if (node.any) return node.any.some((n) => match(n, ctx))
  if (node.not) return !match(node.not, ctx)
  if (node.event) return matchEvent(node, ctx)
  if ('phase' in node) return matchPhase(node, ctx.state)
  if ('weekly' in node) return matchWeekly(node, ctx.state)
  if ('weeklyEvent' in node) return matchWeeklyEvent(node, ctx.state)
  if ('shareFlow' in node) return matchShareFlow(node, ctx.state)
  if ('filter' in node) return matchFilter(node, ctx.state)
  return false
}

function findNodes(node, key, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node[key] != null) out.push(node[key])
  for (const k of ['all', 'any', 'not']) {
    const child = node[k]
    if (Array.isArray(child)) child.forEach((c) => findNodes(c, key, out))
    else if (child) findNodes(child, key, out)
  }
  return out
}

/** 结构性止损位（多头）：事件低点 / 区间下沿 / 固定价格 */
export function stopLevelFor(strategy, ctx) {
  const specs = findNodes(strategy?.exit, 'stopLoss')
  if (!specs.length) return null
  const spec = specs[0]
  const atr = ctx.state.atr ?? 0
  const buffer = (spec.bufferAtr ?? 0) * atr
  if (spec.reference === 'eventLow' && spec.event) {
    const ev = latestEvent(ctx.events, ctx.i, spec.event, spec.withinBars ?? Infinity)
    return ev ? ev.price - buffer : null
  }
  if (spec.reference === 'rangeLow') {
    return ctx.state.range ? ctx.state.range.low - buffer : null
  }
  if (spec.reference === 'price' && Number.isFinite(spec.price)) return spec.price - buffer
  return null
}

export function compileStrategy(strategy = {}) {
  return {
    entry(ctx) {
      return match(strategy.entry, ctx)
    },
    exit(ctx) {
      return match(strategy.exit, ctx)
    },
    stopLevel(ctx) {
      return stopLevelFor(strategy, ctx)
    },
  }
}
