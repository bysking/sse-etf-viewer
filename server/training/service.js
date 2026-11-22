// 人工模拟训练服务层：取数 + 推进 + 下单 + 成绩单。
//
// 训练页的核心约束：任何返回都只能包含「已推进到」的 bar，绝不泄漏未来数据。
// 性能约定：推进接口只返回「新增的那几根」，不返回全量序列（5 分钟线有 12000 根）。
import * as repo from '../store/repositories.js'
import { getBars, timeframeOf, listTimeframes, coverageHintOf } from '../data/intraday.js'
import { applyBuy, applySell, snapshotOf, summarizeSession } from '../../shared/training/engine.js'

/** 初始可见根数：给一点形态背景，否则第一根没得看 */
export const INITIAL_VISIBLE_BARS = 30

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status })

/**
 * 建会话：按用户选的日期取数，从最早可得 bar 开始。
 * 需求已确认：起始日期不限制，拿得到多少算多少，实际起点返回给前端提示。
 */
export async function createSession({ userName, symbol, symbolName, timeframe, startDate, initialCash, positionPct }) {
  const tf = timeframeOf(timeframe)
  if (!tf) throw fail(`不支持的周期：${timeframe}`)
  const cash = Number(initialCash)
  if (!Number.isFinite(cash) || cash <= 0) throw fail('初始资金必须是正数')
  const pct = Number(positionPct)
  if (!Number.isFinite(pct) || pct <= 0 || pct > 1) throw fail('仓位比例应在 0–1 之间')

  const { bars } = await getBars(symbol, timeframe, { start: startDate })
  if (bars.length < 2) throw fail('可用 K 线太少，换个更早的起始日期或更大的周期')

  const cursor = Math.min(bars.length, INITIAL_VISIBLE_BARS)
  const session = repo.createTrainingSession({
    userName,
    symbol,
    symbolName: symbolName ?? null,
    timeframe,
    startDate,
    actualStart: bars[0].ts,
    initialCash: cash,
    positionPct: pct,
    cursor,
    title: `${symbolName || symbol} · ${tf.label}`,
  })
  return {
    session,
    totalBars: bars.length,
    actualStart: bars[0].ts,
    requestedStart: startDate,
    dataStart: bars[0].ts,
    dataEnd: bars[bars.length - 1].ts,
    coverage: coverageHintOf(timeframe),
  }
}

/** 取会话 + 全量 bars（内部用，不直接返回给前端） */
export async function loadContext(sessionId, { userName }) {
  const session = repo.getTrainingSession(sessionId, { userName })
  if (!session) throw fail('训练记录不存在', 404)
  const { bars } = await getBars(session.symbol, session.timeframe, { start: session.startDate })
  if (!bars.length) throw fail('该区间已没有行情数据', 404)
  return { session, bars }
}

function snapshotFor(session, bars, cursor) {
  const last = bars[Math.max(0, cursor - 1)]
  return snapshotOf({
    cash: session.cash,
    units: session.units,
    avgCost: session.avgCost,
    initialCash: session.initialCash,
    price: last?.close,
  })
}

/** 会话元信息 + 当前账户快照 + 已推进进度（不含 bars） */
export async function getSessionState(sessionId, { userName }) {
  const { session, bars } = await loadContext(sessionId, { userName })
  return {
    session,
    snapshot: snapshotFor(session, bars, session.cursor),
    cursor: session.cursor,
    totalBars: bars.length,
    finished: session.cursor >= bars.length,
    dataStart: bars[0].ts,
    dataEnd: bars[bars.length - 1].ts,
    coverage: coverageHintOf(session.timeframe),
    timeframes: listTimeframes(),
  }
}

/**
 * 取已推进区间的 bars 窗口（图表初始化 / 刷新重建用）。
 * @param {number} [from] 0-based 起始下标
 * @param {number} [to] 结束下标（不含），缺省为当前游标
 */
export async function getVisibleBars(sessionId, { userName, from = 0, to = null }) {
  const { session, bars } = await loadContext(sessionId, { userName })
  const end = Math.min(bars.length, session.cursor, to == null ? session.cursor : Number(to))
  const start = Math.max(0, Math.min(end, Number(from) || 0))
  return {
    bars: bars.slice(start, end),
    from: start,
    to: end,
    cursor: session.cursor,
    totalBars: bars.length,
    snapshot: snapshotFor(session, bars, session.cursor),
  }
}

/**
 * 推进：把游标前移 steps 根，落库，并只返回新增的 bars。
 * 到达末尾时自动把会话标记为 finished。
 */
export async function advance(sessionId, { userName, steps = 1 }) {
  const { session, bars } = await loadContext(sessionId, { userName })
  const n = Math.max(1, Math.min(500, Math.trunc(Number(steps) || 1)))
  const from = session.cursor
  const to = Math.min(bars.length, from + n)
  if (to <= from) {
    return {
      added: [],
      cursor: from,
      totalBars: bars.length,
      finished: true,
      snapshot: snapshotFor(session, bars, from),
      session,
    }
  }
  const updated = repo.advanceTrainingCursor(session.id, to) || session
  const finished = to >= bars.length
  if (finished && updated.status !== 'finished') repo.finishTrainingSession(session.id, { status: 'finished' })
  return {
    added: bars.slice(from, to),
    cursor: to,
    totalBars: bars.length,
    finished,
    snapshot: snapshotFor(updated, bars, to),
    session: repo.getTrainingSession(session.id),
  }
}

/** 下单：按当前（最后一根已推进 bar）的收盘价成交 */
export async function placeTrade(sessionId, { userName, side, qty = null }) {
  if (!['buy', 'sell'].includes(side)) throw fail('side 仅支持 buy / sell')
  const { session, bars } = await loadContext(sessionId, { userName })
  if (session.cursor <= 0) throw fail('先按右键推进 K 线，才有可成交的价格')
  const last = bars[session.cursor - 1]
  const price = Number(last.close)

  const result =
    side === 'buy'
      ? applyBuy({
          cash: session.cash,
          units: session.units,
          avgCost: session.avgCost,
          price,
          positionPct: session.positionPct,
        })
      : applySell({ cash: session.cash, units: session.units, avgCost: session.avgCost, price, qty })
  if (result.error) throw fail(result.error)

  const trade = repo.insertTrainingTrade({
    sessionId: session.id,
    barIndex: session.cursor - 1,
    barTs: last.ts,
    side,
    qty: result.qty,
    price: result.price,
    cash: result.cash,
    units: result.units,
    avgCost: result.avgCost,
    pnl: result.pnl ?? null,
  })
  const updated = repo.getTrainingSession(session.id)
  return {
    trade,
    pnl: result.pnl ?? null,
    snapshot: snapshotFor(updated, bars, updated.cursor),
    session: updated,
    cursor: updated.cursor,
    totalBars: bars.length,
    finished: updated.cursor >= bars.length,
  }
}

/** 成交记录列表 */
export async function listTrades(sessionId, { userName }) {
  const session = repo.getTrainingSession(sessionId, { userName })
  if (!session) throw fail('训练记录不存在', 404)
  return { items: repo.listTrainingTrades(session.id) }
}

/**
 * 回看详情：训练已结束或正在回看时，返回完整 bars 与成绩单。
 * 注意：这个接口会返回全部 bars，只应用于「回看」，不用于训练推进。
 */
export async function getSessionDetail(sessionId, { userName }) {
  const { session, bars } = await loadContext(sessionId, { userName })
  const trades = repo.listTrainingTrades(session.id)
  return {
    session,
    bars,
    trades,
    summary: summarizeSession({ session, bars, trades }),
    cursor: session.cursor,
    totalBars: bars.length,
    dataStart: bars[0].ts,
    dataEnd: bars[bars.length - 1].ts,
    coverage: coverageHintOf(session.timeframe),
  }
}

export function listSessions(userName) {
  return repo.listTrainingSessions(userName)
}

export function finishSession(sessionId, { userName, title }) {
  const session = repo.getTrainingSession(sessionId, { userName })
  if (!session) throw fail('训练记录不存在', 404)
  return repo.finishTrainingSession(sessionId, { status: 'finished', title })
}

export function removeSession(sessionId, { userName }) {
  const ok = repo.deleteTrainingSession(sessionId, { userName })
  if (!ok) throw fail('训练记录不存在', 404)
  return { ok: true }
}
