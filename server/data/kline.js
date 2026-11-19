// ETF / 指数日 K 数据访问：复用 yunhq 行情接口，带本地全量缓存。
// 返回值保持与 README 一致的数组格式：[date, open, high, low, close, volume]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { httpGet, stripJsonp, YUNHQ_BASES, INDEX_REFERER, todayCST, diffDays } from '../sse.js'
import { applyForwardAdjust } from './adjust.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CACHE_DIR = process.env.CACHE_DIR || path.join(ROOT, '.cache')
const KLINE_DIR = path.join(CACHE_DIR, 'kline')
fs.mkdirSync(KLINE_DIR, { recursive: true })

const SELECT = 'date,open,high,low,close,volume'
const MAX_BARS = 9000

const dateOfInt = (n) => {
  const s = String(Math.trunc(Number(n)))
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`
}

/** 纯函数：解析 yunhq dayk 响应，便于单测 */
export function parseDayk(json) {
  const rows = Array.isArray(json?.kline) ? json.kline : []
  const series = []
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue
    const date = dateOfInt(r[0])
    const values = r.slice(1, 6).map(Number)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || values.some((v) => !Number.isFinite(v))) continue
    series.push([date, ...values])
  }
  series.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return { code: json?.code ? String(json.code) : null, total: Number(json?.total) || series.length, series }
}

const fileOf = (code) => path.join(KLINE_DIR, `${code}.json`)

function readCache(code) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(code), 'utf8'))
    if (j && Array.isArray(j.series)) return j
  } catch {
    /* 无缓存 */
  }
  return null
}

function writeCache(code, series) {
  const tmp = fileOf(code) + '.' + process.pid + '.tmp'
  const body = JSON.stringify({ code, updatedAt: new Date().toISOString(), series })
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, fileOf(code))
}

function mergeSeries(a, b) {
  const m = new Map()
  for (const row of a || []) m.set(row[0], row)
  for (const row of b || []) m.set(row[0], row)
  return [...m.values()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
}

function estimateBars(start, end) {
  const span = Math.max(1, diffDays(end, start))
  // 交易日约占自然日 5/7；再留 40 根缓冲给节假日与停牌。
  return Math.min(MAX_BARS, Math.max(120, Math.ceil((span * 5) / 7) + 40))
}

async function fetchBars(code, n) {
  const qs = new URLSearchParams({ select: SELECT, begin: String(-n), end: '-1' })
  let lastErr = null
  for (const base of YUNHQ_BASES) {
    try {
      const text = await httpGet(`${base}/v1/sh1/dayk/${code}?${qs}`, INDEX_REFERER)
      return parseDayk(JSON.parse(stripJsonp(text)))
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`获取日 K 失败（${code}）：${lastErr?.message || '无可用行情地址'}`)
}

/**
 * 获取某标的日 K。
 * @param {string} code 6 位代码
 * @param {string} start YYYY-MM-DD
 * @param {string} end   YYYY-MM-DD
 */
export async function getKline(code, start, end) {
  const today = todayCST()
  if (!end || end > today) end = today
  if (!start) start = end
  if (start > end) throw new Error('开始日期不能晚于结束日期')

  let cache = readCache(code)
  const cachedFirst = cache?.series?.[0]?.[0]
  const cachedLast = cache?.series?.at(-1)?.[0]
  const freshEnough =
    cache &&
    cachedFirst <= start &&
    cachedLast >= end &&
    (end < today || Date.now() - Date.parse(cache.updatedAt || 0) < 60_000)

  if (!freshEnough) {
    let want = estimateBars(start, end)
    let fresh = await fetchBars(code, want)
    // 估算窗口没有覆盖到 start，且接口还有更早数据时，扩大窗口重取一次。
    if (fresh.series.length && fresh.series[0][0] > start && fresh.total > fresh.series.length && want < MAX_BARS) {
      want = Math.min(MAX_BARS, Math.max(want * 2, fresh.total))
      fresh = await fetchBars(code, want)
    }
    cache = { code, series: mergeSeries(cache?.series, fresh.series), updatedAt: new Date().toISOString() }
    writeCache(code, cache.series)
  }

  const series = (cache?.series || []).filter((r) => r[0] >= start && r[0] <= end)
  return {
    code,
    adjust: 'none',
    adjustmentCount: 0,
    series,
    asof: series.length ? series[series.length - 1][0] : null,
  }
}

/**
 * 前复权日 K：对 ETF 用已入库的除息事件调整；指数不做调整。
 * @param {string} code
 * @param {string} start
 * @param {string} end
 * @param {Array<{exDate:string}>} dividends 该标的的除息事件
 */
export function applyAdjust(raw, dividends) {
  if (!dividends?.length) return { ...raw, adjust: 'none', adjustmentCount: 0 }
  const exDates = dividends.map((d) => d.exDate)
  const { series, applied } = applyForwardAdjust(raw.series, exDates)
  return {
    ...raw,
    adjust: applied.length ? 'qfq' : 'none',
    series,
    adjustmentCount: applied.length,
  }
}

/** 数据版本戳：用于回测复现（复权口径 + 除息数量 + 最新日期） */
export function dataVersionOf(raw) {
  if (!raw) return null
  const last = raw.series?.[raw.series.length - 1]?.[0] || 'none'
  const first = raw.series?.[0]?.[0] || 'none'
  return `${raw.adjust}:${raw.adjustmentCount ?? 0}:${first}:${last}:${raw.series?.length ?? 0}`
}
