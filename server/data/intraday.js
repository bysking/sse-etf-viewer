// 分时 / 周线 K 线数据访问：日线走 dayk，分钟线走 mink 的 period 参数，周线由日线合成。
//
// 重要背景（实测结论，写在这里避免以后重复踩）：
//   1. yunhq 的 mink 接口用 ?period=N 取不同周期，默认 5 分钟；
//   2. 接口按「根数」封顶，不是按日期：1m=60250、5m=12000、15m=4000、30m=2000、60m=1000；
//      所以 5 分钟及以上的历史都只有约 1 年（250 个交易日），不支持翻页取更早数据；
//   3. weekk 端点返回 503，周线只能由日线合成；
//   4. 深市代码（000/002/300/159 开头）在该接口一律 404，只支持沪市。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { httpGet, stripJsonp, YUNHQ_BASES, INDEX_REFERER, todayCST, diffDays } from '../sse.js'
import { getKline } from './kline.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CACHE_DIR = process.env.CACHE_DIR || path.join(ROOT, '.cache')
const INTRADAY_DIR = path.join(CACHE_DIR, 'intraday')
fs.mkdirSync(INTRADAY_DIR, { recursive: true })

/** 支持的周期。minute 表示分钟数，null 表示日线/周线。 */
export const TIMEFRAMES = [
  { key: '1w', label: '周线', minute: null, source: 'day', api: null, maxBars: 8000 },
  { key: '1d', label: '日线', minute: null, source: 'day', api: null, maxBars: 9000 },
  { key: '60m', label: '60分钟', minute: 60, source: 'mink', api: 60, maxBars: 1000 },
  { key: '30m', label: '30分钟', minute: 30, source: 'mink', api: 30, maxBars: 2000 },
  { key: '15m', label: '15分钟', minute: 15, source: 'mink', api: 15, maxBars: 4000 },
  { key: '5m', label: '5分钟', minute: 5, source: 'mink', api: 5, maxBars: 12000 },
]

export const TIMEFRAME_KEYS = TIMEFRAMES.map((t) => t.key)

export function timeframeOf(key) {
  return TIMEFRAMES.find((t) => t.key === key) || null
}

const fmtTs = (n) => {
  const s = String(Math.trunc(Number(n)))
  // 分钟线时间戳：YYYYMMDDHHmm
  if (s.length >= 12) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`
  }
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/**
 * 纯函数：解析 mink 响应。
 *
 * 字段位置很坑，必须按「是否请求了 time」区分（实测 2026-11）：
 *   不请求 time：6 字段 [时间戳, open, high, low, close, volume]
 *   请求 time  ：7 字段 [时间戳, time(=null), open, high, low, close, volume]
 * 时间戳本身已含 HHmm，所以统一不请求 time；这里仍兼容 7 字段，
 * 避免有人改回 select 后静默错位（错位时 volume 会读到 close，表现为成交量柱等高）。
 *
 * 处理顺序很重要：先按时间排序，再补 open。反过来会拿到「输入顺序的前一根」而不是「时间上的前一根」。
 */
export function parseIntraday(json) {
  const rows = Array.isArray(json?.kline) ? json.kline : []
  const raw = []
  for (const r of rows) {
    if (!Array.isArray(r)) continue
    // 7 字段时第 1 位是 time（通常为 null），跳过它
    const base = r.length >= 7 ? 1 : 0
    if (r.length < base + 6) continue
    const ts = fmtTs(r[0])
    if (!/^\d{4}-\d{2}-\d{2}/.test(ts)) continue
    const openRaw = r[base + 1] == null ? null : Number(r[base + 1])
    const high = Number(r[base + 2])
    const low = Number(r[base + 3])
    const close = Number(r[base + 4])
    const volume = Number(r[base + 5])
    if (![high, low, close, volume].every(Number.isFinite)) continue
    raw.push({
      ts,
      date: ts.slice(0, 10),
      open: openRaw != null && Number.isFinite(openRaw) ? openRaw : null,
      high,
      low,
      close,
      volume,
    })
  }
  // 先排序，保证「上一根」拿到的是时间上的前一根
  raw.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))

  const out = []
  for (const b of raw) {
    // open 缺失时用上一根收盘；若落在当根区间外（跳空/数据缺口）就夹到 [low, high]，
    // 否则会造出 high<open 这种自相矛盾的 K 线
    let open = b.open
    if (open == null) {
      const prev = out.length ? out[out.length - 1].close : b.low
      open = Math.min(b.high, Math.max(b.low, prev))
    }
    // 健全性检查：high 必须最大、low 必须最小。字段错位时一定被触发，
    // 宁可丢一根也不要画出错误的 K 线。
    if (b.high < b.low || b.high < open || b.high < b.close) continue
    if (b.low > open || b.low > b.close) continue
    out.push({ ts: b.ts, date: b.date, open, high: b.high, low: b.low, close: b.close, volume: b.volume })
  }
  return { code: json?.code ? String(json.code) : null, total: Number(json?.total) || out.length, bars: out }
}

const fileOf = (code, apiPeriod) => path.join(INTRADAY_DIR, `${code}_${apiPeriod}.json`)

function readCache(code, apiPeriod) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(code, apiPeriod), 'utf8'))
    if (j && Array.isArray(j.bars)) return j
  } catch {
    /* 无缓存 */
  }
  return null
}

function writeCache(code, apiPeriod, bars) {
  const file = fileOf(code, apiPeriod)
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ code, apiPeriod, updatedAt: new Date().toISOString(), bars }), 'utf8')
  fs.renameSync(tmp, file)
}

function mergeBars(a, b) {
  const m = new Map()
  for (const row of a || []) m.set(row.ts, row)
  for (const row of b || []) m.set(row.ts, row)
  return [...m.values()].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0))
}

async function fetchMink(code, apiPeriod, want) {
  // 不要请求 time：带上它会让返回行变成 7 字段（time 位为 null），容易造成字段错位。
  // 时间戳（YYYYMMDDHHmm）本身已经包含时分。
  const qs = new URLSearchParams({
    select: 'date,open,high,low,close,volume',
    begin: String(-want),
    end: '-1',
    period: String(apiPeriod),
  })
  let lastErr = null
  for (const base of YUNHQ_BASES) {
    try {
      const text = await httpGet(`${base}/v1/sh1/mink/${code}?${qs}`, INDEX_REFERER)
      return parseIntraday(JSON.parse(stripJsonp(text)))
    } catch (e) {
      lastErr = e
    }
  }
  const hint = /404/.test(lastErr?.message || '') ? '（该代码不是沪市标的，深市代码不支持）' : ''
  throw new Error(`获取分钟 K 失败（${code}）：${lastErr?.message || '无可用行情地址'}${hint}`)
}

/**
 * 取某标的的分钟 K（全量，最多 maxBars 根）。
 * 缓存策略：已收盘的历史分钟数据不会再变，只对最后一根所在交易日做 60s 短缓存刷新。
 */
export async function getIntradayBars(code, apiPeriod) {
  const tf = TIMEFRAMES.find((t) => t.api === apiPeriod)
  if (!tf) throw new Error(`不支持的分钟周期：${apiPeriod}`)
  const cached = readCache(code, apiPeriod)
  const today = todayCST()
  const cachedLastDay = cached?.bars?.length ? cached.bars[cached.bars.length - 1].date : null
  const freshEnough =
    cached && cachedLastDay && cachedLastDay < today && Date.now() - Date.parse(cached.updatedAt || 0) < 12 * 3600e3
  if (freshEnough) return cached.bars

  const fresh = await fetchMink(code, apiPeriod, tf.maxBars)
  const bars = mergeBars(cached?.bars, fresh.bars).slice(-tf.maxBars)
  if (bars.length) writeCache(code, apiPeriod, bars)
  return bars
}

/** 把日线合成周线，周以周一为起点；最后一周可能未走完，保留但标记 complete=false */
export function toWeeklyBars(dailySeries) {
  const weekStartOf = (date) => {
    const d = new Date(date + 'T00:00:00Z')
    const day = d.getUTCDay()
    const diff = day === 0 ? -6 : 1 - day
    d.setUTCDate(d.getUTCDate() + diff)
    return d.toISOString().slice(0, 10)
  }
  const groups = new Map()
  for (const row of dailySeries || []) {
    const [date, open, high, low, close, volume] = row
    const wk = weekStartOf(date)
    const g = groups.get(wk)
    if (!g) {
      groups.set(wk, {
        ts: date,
        weekStart: wk,
        date: wk,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume) || 0,
        days: 1,
      })
    } else {
      g.ts = date
      g.high = Math.max(g.high, Number(high))
      g.low = Math.min(g.low, Number(low))
      g.close = Number(close)
      g.volume += Number(volume) || 0
      g.days++
    }
  }
  return [...groups.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))
}

/**
 * 统一取数入口：按周期返回 bars。
 * bars 每项形如 { ts, date, open, high, low, close, volume }，
 * 其中 ts 是排序/显示用的时间键（周线是周起始日，分钟线是 YYYY-MM-DD HH:mm）。
 *
 * @param {string} code
 * @param {string} timeframe TIMEFRAMES 里的 key
 * @param {{start?:string,end?:string}} [opts]
 */
export async function getBars(code, timeframe, opts = {}) {
  const tf = timeframeOf(timeframe)
  if (!tf) throw new Error(`不支持的周期：${timeframe}`)

  if (tf.source === 'day') {
    // 周线需要比目标区间更长的日线，才能保证起点那一周是完整的
    const start = opts.start || '2012-01-01'
    const end = opts.end || todayCST()
    const wantStart = tf.key === '1w' ? subtractDays(start, 14) : start
    const raw = await getKline(code, wantStart, end)
    if (tf.key === '1w') {
      const weekly = toWeeklyBars(raw.series)
      return {
        code,
        timeframe: tf.key,
        bars: weekly.filter((b) => b.ts >= start && b.ts <= end),
        adjust: raw.adjust,
      }
    }
    const bars = raw.series.map(([date, open, high, low, close, volume]) => ({
      ts: date,
      date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }))
    return { code, timeframe: tf.key, bars: bars.filter((b) => b.ts >= start && b.ts <= end), adjust: raw.adjust }
  }

  const all = await getIntradayBars(code, tf.api)
  const start = opts.start || null
  const end = opts.end || null
  const bars = all.filter((b) => (!start || b.ts >= start) && (!end || b.ts <= end + '\uffff'))
  return { code, timeframe: tf.key, bars, adjust: 'none', available: all.length ? { start: all[0].ts, end: all[all.length - 1].ts, count: all.length } : null }
}

function subtractDays(date, n) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** 各周期大概能覆盖多少天（用于页面提示，实测校准过） */
export function coverageHintOf(timeframe) {
  const tf = timeframeOf(timeframe)
  if (!tf) return null
  if (tf.source === 'day') return { days: null, text: '约 10 年以上（日线自 2012 年起）' }
  const barsPerDay = { 60: 4, 30: 8, 15: 16, 5: 48 }[tf.api]
  const days = Math.floor(tf.maxBars / barsPerDay)
  return {
    days,
    text: `约 ${days} 个交易日（约 ${(days / 250).toFixed(1)} 年）`,
  }
}

/** 供 API 返回周期清单 */
export function listTimeframes() {
  return TIMEFRAMES.map((t) => ({
    key: t.key,
    label: t.label,
    minute: t.minute,
    coverage: coverageHintOf(t.key),
  }))
}

export { diffDays }
