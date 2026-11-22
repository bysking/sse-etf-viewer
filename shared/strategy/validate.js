// 策略配置校验：用于 AI 生成策略、快速回测和保存前的统一入口。
import { validateConfig } from '../wyckoff/config.js'

export const EVENT_TYPES = ['sc', 'bc', 'ar', 'st', 'spring', 'test', 'utad', 'sos', 'sow', 'lps', 'lpsy']

export const PHASES = [
  'neutral',
  'range',
  'accumulation_A',
  'accumulation_B',
  'accumulation_C',
  'accumulation_D',
  'accumulation_E',
  'distribution_A',
  'distribution_B',
  'distribution_C',
  'distribution_D',
  'distribution_E',
  'markup',
  'markdown',
]

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => Number.isFinite(v)
const isCompare = (v) => isObj(v) && ['gte', 'gt', 'lte', 'lt', 'eq'].some((k) => k in v)
const inRange = (v, lo, hi) => isNum(v) && v >= lo && v <= hi
const isEvent = (t) => typeof t === 'string' && EVENT_TYPES.includes(t.toLowerCase())
const isPhase = (p) => typeof p === 'string' && PHASES.includes(p)

function validateRequire(req, path, errors) {
  if (req == null) return
  if (!isObj(req)) {
    errors.push(`${path}.require 必须是对象`)
    return
  }
  for (const [k, v] of Object.entries(req)) {
    if (typeof v === 'boolean' || typeof v === 'number') continue
    if (isCompare(v)) continue
    errors.push(`${path}.require.${k} 必须是布尔、数字或 {gte|gt|lte|lt|eq} 条件`)
  }
}

function validateEvent(node, path, errors) {
  const raw = node.event
  const spec = isObj(raw) ? raw : { type: raw }
  const type = spec.type
  if (!isEvent(type)) {
    errors.push(`${path}.event 类型不支持：${type ?? '(缺失)'}；可用：${EVENT_TYPES.join(', ')}`)
  }
  const within = spec.withinBars ?? node.withinBars
  if (within != null && !inRange(within, 0, 1000)) errors.push(`${path}.withinBars 应在 0–1000`)
  validateRequire(node.require ?? spec.require, path, errors)
}

function validatePhase(node, path, errors) {
  const spec = node.phase
  if (!isObj(spec)) {
    errors.push(`${path}.phase 必须是对象`)
    return
  }
  if ('in' in spec) {
    if (!Array.isArray(spec.in) || !spec.in.length) errors.push(`${path}.phase.in 必须是非空数组`)
    else for (const p of spec.in) if (!isPhase(p)) errors.push(`${path}.phase.in 含未知阶段：${p}`)
  }
  if ('eq' in spec && !isPhase(spec.eq)) errors.push(`${path}.phase.eq 未知阶段：${spec.eq}`)
  if (spec.minConfidence != null && !inRange(spec.minConfidence, 0, 1)) errors.push(`${path}.phase.minConfidence 应在 0–1`)
}

function validateWeekly(node, path, errors) {
  const spec = node.weekly
  if (!isObj(spec)) {
    errors.push(`${path}.weekly 必须是对象`)
    return
  }
  for (const key of ['phaseIn', 'trendIn']) {
    if (spec[key] != null && (!Array.isArray(spec[key]) || !spec[key].length)) {
      errors.push(`${path}.weekly.${key} 必须是非空数组`)
    }
  }
  if (spec.closeAboveMa != null && typeof spec.closeAboveMa !== 'boolean') errors.push(`${path}.weekly.closeAboveMa 必须是布尔`)
  for (const key of ['positionGte', 'positionLte']) {
    if (spec[key] != null && !inRange(spec[key], 0, 1)) errors.push(`${path}.weekly.${key} 应在 0–1`)
  }
}

function validateWeeklyEvent(node, path, errors) {
  const spec = node.weeklyEvent
  if (!isObj(spec)) {
    errors.push(`${path}.weeklyEvent 必须是对象`)
    return
  }
  if (!isEvent(spec.type ?? spec.event)) {
    errors.push(`${path}.weeklyEvent.type 需要是支持的事件类型`)
  }
  if (spec.withinWeeks != null && !inRange(spec.withinWeeks, 1, 52)) {
    errors.push(`${path}.weeklyEvent.withinWeeks 应在 1–52`)
  }
}

function validateShareFlow(node, path, errors) {
  const spec = node.shareFlow
  if (!isObj(spec)) {
    errors.push(`${path}.shareFlow 必须是对象`)
    return
  }
  if (spec.cumulativeDays != null && !inRange(spec.cumulativeDays, 1, 60)) errors.push(`${path}.shareFlow.cumulativeDays 应在 1–60`)
  if (spec.requireFresh != null && typeof spec.requireFresh !== 'boolean') errors.push(`${path}.shareFlow.requireFresh 必须是布尔`)
  for (const key of ['gt', 'gte', 'lt', 'lte', 'valueGt']) {
    if (spec[key] != null && !isNum(spec[key])) errors.push(`${path}.shareFlow.${key} 必须是数字`)
  }
  if (!['gt', 'gte', 'lt', 'lte', 'valueGt'].some((k) => spec[k] != null)) {
    errors.push(`${path}.shareFlow 至少需要一个比较条件`)
  }
}

function validateFilter(node, path, errors) {
  const spec = node.filter
  if (!isObj(spec)) {
    errors.push(`${path}.filter 必须是对象`)
    return
  }
  if (!['closeAbove', 'volZ', 'close'].includes(spec.fn)) {
    errors.push(`${path}.filter.fn 仅支持 closeAbove / volZ / close`)
  }
  if (spec.fn === 'closeAbove' && typeof spec.value !== 'boolean') {
    errors.push(`${path}.filter.value 必须是布尔`)
  }
  if (spec.fn !== 'closeAbove' && !['gte', 'gt', 'lte', 'lt', 'eq'].some((k) => spec[k] != null)) {
    errors.push(`${path}.filter 缺少比较条件`)
  }
}

function validateStopLoss(node, path, errors) {
  const spec = node.stopLoss
  if (!isObj(spec)) {
    errors.push(`${path}.stopLoss 必须是对象`)
    return
  }
  if (!['eventLow', 'rangeLow', 'price'].includes(spec.reference)) {
    errors.push(`${path}.stopLoss.reference 仅支持 eventLow / rangeLow / price`)
  }
  if (spec.reference === 'eventLow' && !isEvent(spec.event)) {
    errors.push(`${path}.stopLoss.event 需要是支持的事件类型`)
  }
  if (spec.reference === 'price' && !(isNum(spec.price) && spec.price > 0)) {
    errors.push(`${path}.stopLoss.price 必须是正数`)
  }
  if (spec.bufferAtr != null && !inRange(spec.bufferAtr, 0, 10)) errors.push(`${path}.stopLoss.bufferAtr 应在 0–10`)
}

function validateNode(node, path, errors) {
  if (Array.isArray(node)) {
    if (!node.length) errors.push(`${path} 不能为空`)
    node.forEach((n, i) => validateNode(n, `${path}[${i}]`, errors))
    return
  }
  if (!isObj(node)) {
    errors.push(`${path} 必须是条件对象`)
    return
  }
  if (node.all != null || node.any != null) {
    const key = node.all != null ? 'all' : 'any'
    const list = node[key]
    if (!Array.isArray(list) || !list.length) errors.push(`${path}.${key} 必须是非空数组`)
    else list.forEach((n, i) => validateNode(n, `${path}.${key}[${i}]`, errors))
    return
  }
  if (node.not != null) {
    validateNode(node.not, `${path}.not`, errors)
    return
  }

  const recognized = ['event', 'phase', 'weekly', 'weeklyEvent', 'shareFlow', 'filter', 'stopLoss'].filter(
    (k) => node[k] != null,
  )
  if (recognized.length === 0) {
    errors.push(
      `${path} 不支持的条件；可用：event / phase / weekly / weeklyEvent / shareFlow / filter / stopLoss / all / any / not`,
    )
    return
  }
  if (recognized.length > 1) {
    errors.push(`${path} 一个节点只能包含一种条件，发现：${recognized.join(', ')}`)
    return
  }
  const key = recognized[0]
  if (key === 'event') validateEvent(node, path, errors)
  else if (key === 'phase') validatePhase(node, path, errors)
  else if (key === 'weekly') validateWeekly(node, path, errors)
  else if (key === 'weeklyEvent') validateWeeklyEvent(node, path, errors)
  else if (key === 'shareFlow') validateShareFlow(node, path, errors)
  else if (key === 'filter') validateFilter(node, path, errors)
  else if (key === 'stopLoss') validateStopLoss(node, path, errors)
}

function hasTrigger(node) {
  if (!node || typeof node !== 'object') return false
  if (node.event || node.phase || node.weekly || node.weeklyEvent || node.shareFlow || node.filter) return true
  if (node.not) return hasTrigger(node.not)
  for (const key of ['all', 'any']) {
    const list = node[key]
    if (Array.isArray(list) && list.some(hasTrigger)) return true
  }
  return false
}

function hasStopLoss(node) {
  if (!node || typeof node !== 'object') return false
  if (node.stopLoss) return true
  if (node.not) return hasStopLoss(node.not)
  for (const key of ['all', 'any']) {
    const list = node[key]
    if (Array.isArray(list) && list.some(hasStopLoss)) return true
  }
  return false
}

function validateExecution(exec, errors) {
  if (exec == null) return
  if (!isObj(exec)) {
    errors.push('execution 必须是对象')
    return
  }
  if (exec.fillAt != null && exec.fillAt !== 'nextOpen') errors.push('execution.fillAt 仅支持 nextOpen')
  if (exec.tPlus1 != null && typeof exec.tPlus1 !== 'boolean') errors.push('execution.tPlus1 必须是布尔')
  if (exec.feeRate != null && !inRange(exec.feeRate, 0, 0.01)) errors.push('execution.feeRate 应在 0–0.01')
  if (exec.minFee != null && !inRange(exec.minFee, 0, 100)) errors.push('execution.minFee 应在 0–100')
  if (exec.slippageBps != null && !inRange(exec.slippageBps, 0, 100)) errors.push('execution.slippageBps 应在 0–100')
  if (exec.lotSize != null && !(Number.isInteger(exec.lotSize) && exec.lotSize >= 1 && exec.lotSize <= 10000)) {
    errors.push('execution.lotSize 必须是 1–10000 的整数')
  }
  if (exec.cancelIfInvalidated != null && typeof exec.cancelIfInvalidated !== 'boolean') {
    errors.push('execution.cancelIfInvalidated 必须是布尔')
  }
  if (exec.cancelCooldownBars != null && !inRange(exec.cancelCooldownBars, 0, 100)) {
    errors.push('execution.cancelCooldownBars 应在 0–100')
  }
  if (exec.position != null) {
    if (!isObj(exec.position)) {
      errors.push('execution.position 必须是对象')
      return
    }
    if (!['riskBased', 'allIn', 'scaled'].includes(exec.position.type)) {
      errors.push('execution.position.type 仅支持 riskBased / allIn / scaled')
    }
    if (exec.position.type === 'scaled') {
      const tiers = exec.position.tiers
      if (!Array.isArray(tiers) || !tiers.length || tiers.length > 5) {
        errors.push('execution.position.tiers 必须是 1–5 个分批')
      } else {
        let sum = 0
        tiers.forEach((t, i) => {
          if (!isObj(t)) {
            errors.push(`execution.position.tiers[${i}] 必须是对象`)
            return
          }
          if (!inRange(t.pct, 0, 1) || t.pct <= 0) errors.push(`execution.position.tiers[${i}].pct 应在 (0,1]`)
          else sum += t.pct
          if (t.trigger != null && !['immediate', 'event', 'pullbackPct'].includes(t.trigger)) {
            errors.push(`execution.position.tiers[${i}].trigger 仅支持 immediate / event / pullbackPct`)
          }
          if (t.trigger === 'event' && !isEvent(t.event)) {
            errors.push(`execution.position.tiers[${i}].event 需要是支持的事件类型`)
          }
          if (t.trigger === 'pullbackPct' && !inRange(t.value, 0, 1)) {
            errors.push(`execution.position.tiers[${i}].value 应在 0–1`)
          }
        })
        if (sum > 1.0001) errors.push(`execution.position.tiers 的 pct 之和不能超过 1（当前 ${sum.toFixed(2)}）`)
      }
    }
    if (exec.position.riskPct != null && !inRange(exec.position.riskPct, 0, 1)) errors.push('execution.position.riskPct 应在 0–1')
    if (exec.position.maxPositionPct != null && !inRange(exec.position.maxPositionPct, 0, 1)) {
      errors.push('execution.position.maxPositionPct 应在 0–1')
    }
  }
}

/** 返回错误字符串数组；空数组表示通过 */
export function validateStrategyConfig(config) {
  const errors = []
  if (!isObj(config)) return ['策略配置必须是对象']
  if (!/^\d{6}$/.test(String(config.symbol || ''))) errors.push('symbol 应为 6 位代码')
  if (config.engine != null && config.engine !== 'wyckoff-v1') errors.push('engine 仅支持 wyckoff-v1')
  checkWyckoffConfig(config.wyckoff, errors)
  if (!config.entry) {
    errors.push('缺少 entry 条件')
  } else {
    validateNode(config.entry, 'entry', errors)
    if (!hasTrigger(config.entry)) errors.push('entry 至少需要一个事件/阶段/周线/份额/过滤条件')
  }
  if (!config.exit) {
    errors.push('缺少 exit 条件')
  } else {
    validateNode(config.exit, 'exit', errors)
  }
  validateExecution(config.execution, errors)

  const positionType = config.execution?.position?.type ?? 'riskBased'
  if (positionType === 'riskBased' && (!config.exit || !hasStopLoss(config.exit))) {
    errors.push('riskBased 仓位必须在 exit 中包含 stopLoss')
  }
  if (config.initialCash != null && !(isNum(config.initialCash) && config.initialCash > 0)) {
    errors.push('initialCash 必须是正数')
  }
  if (config.shareFlow != null) {
    if (!isObj(config.shareFlow)) errors.push('shareFlow 必须是对象')
    else {
      if (config.shareFlow.enabled != null && typeof config.shareFlow.enabled !== 'boolean') errors.push('shareFlow.enabled 必须是布尔')
      if (config.shareFlow.cumulativeDays != null && !inRange(config.shareFlow.cumulativeDays, 1, 60)) {
        errors.push('shareFlow.cumulativeDays 应在 1–60')
      }
      if (config.shareFlow.staleMaxDays != null && !inRange(config.shareFlow.staleMaxDays, 0, 30)) {
        errors.push('shareFlow.staleMaxDays 应在 0–30')
      }
    }
  }
  return errors
}

function checkWyckoffConfig(wyckoff, errors) {
  if (wyckoff == null) return
  if (!isObj(wyckoff)) {
    errors.push('wyckoff 必须是对象')
    return
  }
  errors.push(...validateConfig(wyckoff))
}
