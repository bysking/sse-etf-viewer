// 收盘后调度：按策略的数据依赖选择检查时点，生成信号、驱动双账本、发送通知。
// 生产进程内运行；开发环境不启动，只提供手动检查。
import {
  listStrategies,
  getStrategyState,
  setStrategyState,
  setStrategyVersionStatus,
} from '../store/repositories.js'
import { getCalendar } from '../data/calendar.js'
import { todayCST, addDays } from '../sse.js'
import { executeCheck } from './check.js'

const TICK_MS = 30_000
const PRICE_CHECK_AT = '15:10' // 纯价格事件：收盘后可确认
const SHARE_CHECK_AT = '18:40' // 依赖份额：需等 T 日晚间发布
const SHARE_RETRY_UNTIL = '22:00'

let timer = null
let running = false
let lastTick = null

const hhmm = (d = new Date()) =>
  new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16)

export function shouldRunNow(now = new Date()) {
  return hhmm(now) >= PRICE_CHECK_AT
}

/** 是否已到该策略的检查时点（含份额未发布时的重试窗口） */
export function isCheckDue(strategy, now = new Date()) {
  const t = hhmm(now)
  const usesShares = Boolean(strategy.usesShares)
  if (usesShares) return t >= SHARE_CHECK_AT && t <= SHARE_RETRY_UNTIL
  return t >= PRICE_CHECK_AT
}

/** 同一策略同一天只检查一次（份额策略在窗口内可重试，由 check 内部按需跳过） */
function alreadyCheckedToday(state, date) {
  return state?.lastBar === date && state?.lastCheckedDate === date
}

async function isTradingDay(date) {
  try {
    const cal = await getCalendar(addDays(date, -10), date)
    return cal.dates.includes(date)
  } catch {
    // 日历不可用时回退到工作日判断，并在日志里说明降级
    const d = new Date(date + 'T00:00:00Z').getUTCDay()
    return d !== 0 && d !== 6
  }
}

/**
 * 跑一轮检查。force=true 时忽略时点与「今天已检查」，用于手动触发。
 */
export async function runOnce({ force = false, now = new Date(), onSignal = null } = {}) {
  const date = force ? todayCST() : hhmm(now) === '' ? todayCST() : new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const summary = { date, checked: [], skipped: [], dayOff: false }

  const trading = await isTradingDay(date)
  if (!trading && !force) {
    summary.dayOff = true
    return summary
  }

  const strategies = listStrategies().filter((s) => s.enabled)
  for (const s of strategies) {
    const usesShares = JSON.stringify({ e: s.config.entry, x: s.config.exit }).includes('"shareFlow"')
    const target = { ...s, usesShares }
    if (!force && !isCheckDue(target, now)) {
      summary.skipped.push({ strategyId: s.id, reason: 'notDue' })
      continue
    }
    const state = getStrategyState(s.id)
    if (!force && alreadyCheckedToday(state, date)) {
      summary.skipped.push({ strategyId: s.id, reason: 'alreadyChecked' })
      continue
    }
    try {
      const r = await executeCheck({ strategy: s, date, force })
      summary.checked.push({ strategyId: s.id, name: s.name, ...r })
      onSignal?.(s, r)
    } catch (e) {
      summary.skipped.push({ strategyId: s.id, reason: 'error', error: e.message })
    }
  }
  return summary
}

export function getSchedulerStatus() {
  const cfg = { priceCheckAt: PRICE_CHECK_AT, shareCheckAt: SHARE_CHECK_AT, shareRetryUntil: SHARE_RETRY_UNTIL, tickMs: TICK_MS }
  return {
    enabled: Boolean(timer),
    running,
    lastTick,
    now: hhmm(),
    ...cfg,
  }
}

export function startScheduler({ logger = console } = {}) {
  if (timer) return getSchedulerStatus()
  logger.log('[monitor] 调度已启动', { PRICE_CHECK_AT, SHARE_CHECK_AT, SHARE_RETRY_UNTIL })
  timer = setInterval(async () => {
    if (running) return
    running = true
    lastTick = new Date().toISOString()
    try {
      const r = await runOnce()
      if (r.checked.length) logger.log('[monitor] 本轮检查', JSON.stringify(r))
    } catch (e) {
      logger.error('[monitor] 检查失败', e)
    } finally {
      running = false
    }
  }, TICK_MS)
  // 不阻塞进程退出
  if (typeof timer.unref === 'function') timer.unref()
  return getSchedulerStatus()
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  return getSchedulerStatus()
}
