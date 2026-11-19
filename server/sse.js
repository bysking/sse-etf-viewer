// 上交所数据访问层：ETF 每日份额 + 上证指数日K（仅用 Node 内置模块）
// 上交所接口要求 sse.com.cn 的 Referer，浏览器无法伪造，所以必须由服务端代请求。
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = process.env.CACHE_DIR || path.join(ROOT, '.cache')
fs.mkdirSync(CACHE_DIR, { recursive: true })

const QUERY_URL = process.env.SSE_QUERY_URL || 'https://query.sse.com.cn/commonQuery.do'
const SHARE_SQLID = 'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L'
const SHARE_REFERER = 'https://www.sse.com.cn/market/funddata/volumn/etfvolumn/'
export const YUNHQ_BASES = (process.env.SSE_YUNHQ_URLS || 'http://yunhq.sse.com.cn:32041,https://yunhq.sse.com.cn:32042')
  .split(',')
  .map((s) => s.trim())
export const INDEX_REFERER = 'https://www.sse.com.cn/market/price/trends/'
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// ---------------------------------------------------------------- 日期（均为 YYYY-MM-DD 字符串）
export const todayCST = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const utc = (s) => new Date(s + 'T00:00:00Z')
export const addDays = (s, n) => {
  const d = utc(s)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const isWeekend = (s) => [0, 6].includes(utc(s).getUTCDay())
export const diffDays = (a, b) => Math.round((utc(a) - utc(b)) / 864e5)
function weekdays(a, b) {
  const out = []
  for (let d = a; d <= b; d = addDays(d, 1)) if (!isWeekend(d)) out.push(d)
  return out
}

// ---------------------------------------------------------------- HTTP
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const stripJsonp = (t) => {
  t = t.trim()
  const m = t.match(/^[\w$.]+\(([\s\S]*)\)\s*;?$/)
  return m ? m[1] : t
}

function getOnce(url, referer, timeout) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(
      url,
      { headers: { Referer: referer, 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' }, timeout },
      (res) => {
        if (res.statusCode >= 400) {
          res.resume()
          return reject(new Error('HTTP ' + res.statusCode))
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

export async function httpGet(url, referer, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await getOnce(url, referer, 20000)
    } catch (e) {
      last = e
      await sleep(400 * (i + 1))
    }
  }
  throw new Error(`请求 ${url.split('?')[0]} 失败：${last?.message || last}`)
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    }),
  )
  return out
}

// ---------------------------------------------------------------- ETF 份额
const inflight = new Map()

/** 当日全市场 ETF：[[代码, 简称, 份额(万份), 扩位简称], ...]；非交易日为 [] */
export function fetchDay(d) {
  if (inflight.has(d)) return inflight.get(d)
  const p = _fetchDay(d).finally(() => inflight.delete(d))
  inflight.set(d, p)
  return p
}

async function _fetchDay(d) {
  const file = path.join(CACHE_DIR, d + '.json')
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'))
  } catch {
    /* 无缓存 */
  }

  const params = new URLSearchParams({
    isPagination: 'true',
    'pageHelp.pageSize': '10000',
    'pageHelp.pageNo': '1',
    'pageHelp.beginPage': '1',
    'pageHelp.cacheSize': '1',
    'pageHelp.endPage': '1',
    sqlId: SHARE_SQLID,
    STAT_DATE: d,
    _: String(Date.now()),
  })
  const text = await httpGet(QUERY_URL + '?' + params, SHARE_REFERER)
  const j = JSON.parse(stripJsonp(text))
  const rows = (Array.isArray(j.result) && j.result.length ? j.result : j.pageHelp?.data) || []

  const want = d.replaceAll('-', '')
  const slim = []
  for (const r of rows) {
    // 只接受日期吻合的行，避免非交易日被回填成别的日期
    const rd = String(r.STAT_DATE ?? '').replaceAll('-', '').trim()
    if (rd && rd !== want) continue
    const vol = Number(String(r.TOT_VOL).replaceAll(',', ''))
    const code = String(r.SEC_CODE ?? '').trim()
    if (!code || !Number.isFinite(vol)) continue
    slim.push([code, String(r.SEC_NAME ?? '').trim(), vol, String(r.EXT_SEC_NAME ?? '').trim()])
  }

  // 缓存策略：已过去的日子有数据就缓存；空结果（节假日）等 4 天后再缓存，
  // 以免把“数据尚未发布”的近期日期误缓存成空。
  const now = todayCST()
  if ((slim.length && d < now) || (!slim.length && d <= addDays(now, -4))) {
    const tmp = file + '.' + process.pid + '.tmp'
    await fs.promises.writeFile(tmp, JSON.stringify(slim), 'utf8')
    await fs.promises.rename(tmp, file)
  }
  return slim
}

// 最多支持的查询跨度（约 5 年）。份额接口按日取数，越长首次越慢，所以设上限保护。
export const MAX_RANGE_DAYS = 1830

export async function getShares(code, start, end) {
  end = end > todayCST() ? todayCST() : end
  // 允许查询到最近 5 年；超过则从 end 往前截断
  if (diffDays(end, start) > MAX_RANGE_DAYS) start = addDays(end, -MAX_RANGE_DAYS)
  const days = weekdays(start, end)

  const results = await mapLimit(days, 6, async (d) => {
    try {
      return { d, rows: await fetchDay(d) }
    } catch (e) {
      return { d, err: e.message }
    }
  })

  // 区间内每个工作日都会出现在 series 里：当日无数据（节假日/未上市/请求失败）以 null 占位，
  // 由前端按“空数据”处理，保证时间轴连续、缺口可见。
  const series = []
  let name = null
  let failed = 0
  let error = null
  let count = 0
  for (const { d, rows, err } of results) {
    if (err) {
      failed++
      error = err
      series.push([d, null])
      continue
    }
    const hit = rows.find((r) => r[0] === code)
    if (hit) {
      series.push([d, hit[2]])
      name = hit[3] || hit[1]
      count++
    } else {
      series.push([d, null])
    }
  }
  return { code, name, series, days: days.length, count, failed, error }
}

let uni = { t: 0, rows: [], date: null }

async function universe() {
  if (uni.rows.length && Date.now() - uni.t < 30 * 60 * 1000) return uni
  const now = todayCST()
  let lastErr = null
  for (let i = 0; i < 15; i++) {
    const d = addDays(now, -i)
    if (isWeekend(d)) continue
    try {
      const rows = await fetchDay(d)
      if (rows.length) {
        uni = { t: Date.now(), rows, date: d }
        return uni
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`无法获取 ETF 清单：${lastErr?.message || '近15天均无数据'}`)
}

export async function search(q) {
  q = q.trim().toLowerCase()
  const u = await universe()
  const hits = []
  for (const [c, n, , ext] of u.rows) {
    const label = ext || n
    if (c.startsWith(q)) hits.push([0, c, label])
    else if (n.toLowerCase().includes(q) || ext.toLowerCase().includes(q)) hits.push([1, c, label])
  }
  hits.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))
  return { items: hits.slice(0, 20).map(([, code, name]) => ({ code, name })), asof: u.date }
}

// ---------------------------------------------------------------- 上证指数
export async function getIndex(code, start, end) {
  const n = Math.max(30, Math.floor((diffDays(todayCST(), start) * 5) / 7) + 20)
  const qs = new URLSearchParams({ select: 'date,open,high,low,close,volume', begin: String(-n), end: '-1' })
  let last = null
  for (const base of YUNHQ_BASES) {
    try {
      const text = await httpGet(`${base}/v1/sh1/dayk/${code}?${qs}`, INDEX_REFERER)
      const j = JSON.parse(stripJsonp(text))
      const out = []
      for (const r of j.kline || []) {
        const s = String(Math.trunc(Number(r[0])))
        const ds = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`
        if (ds >= start && ds <= end) out.push([ds, Number(r[4])])
      }
      if (out.length) return { code, series: out }
      last = '接口返回为空'
    } catch (e) {
      last = e.message
    }
  }
  throw new Error(`获取上证指数失败：${last}`)
}
