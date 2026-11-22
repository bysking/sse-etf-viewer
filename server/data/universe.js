// 沪市证券清单（个股 + ETF）合并搜索，用于训练页的标的选择。
//
// 数据来源差异（别混用）：
//   个股：query.sse.com.cn 的 COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L，每页最多 2000 条，需要翻页（约 2521 条）；
//        A_STOCK_CODE 为 '-' 表示非 A 股（B 股 / 已退市占位），要过滤掉。
//   ETF ：复用已有的「当日全市场 ETF 份额」接口，只取代码与简称。
// 深市（000/002/300/159 开头）不在上交所清单里，行情接口也会 404，这里不提供。
import path from 'node:path'
import { httpGet, stripJsonp, fetchDay, todayCST, addDays } from '../sse.js'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CACHE_DIR = process.env.CACHE_DIR || path.join(ROOT, '.cache')
const STOCK_CACHE = path.join(CACHE_DIR, 'stock-list.json')

const QUERY_URL = 'https://query.sse.com.cn/commonQuery.do'
const STOCK_SQLID = 'COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L'
const STOCK_REFERER = 'https://www.sse.com.cn/assortment/stock/list/share/'
const PAGE_SIZE = 2000
const MAX_PAGES = 10
const CACHE_TTL = 24 * 3600e3

/** 纯函数：把上交所个股行转成精简清单，过滤非 A 股与退市 */
export function parseStockRows(rows = []) {
  if (!Array.isArray(rows)) return []
  const out = []
  for (const r of rows) {
    const code = String(r.A_STOCK_CODE ?? '').trim()
    if (!/^\d{6}$/.test(code) || code === '-') continue
    // DELIST_DATE 非 '-' 表示已退市，训练没有意义
    const delisted = r.DELIST_DATE && r.DELIST_DATE !== '-'
    if (delisted) continue
    // 名称按优先级取第一个有效值；上交所会用 '-' 表示空，不能直接当名称
    const name = [r.SEC_NAME_CN, r.COMPANY_ABBR, r.SEC_NAME_FULL]
      .map((v) => String(v ?? '').trim())
      .find((v) => v && v !== '-')
    if (!name) continue
    out.push({ code, name, type: 'stock', board: boardOf(code) })
  }
  return out
}

/** 按代码判断板块，用于页面展示与搜索提示 */
export function boardOf(code) {
  const c = String(code)
  if (c.startsWith('688')) return '科创板'
  if (c.startsWith('605') || c.startsWith('603') || c.startsWith('601') || c.startsWith('600')) return '主板'
  if (c.startsWith('5')) return 'ETF'
  if (c.startsWith('000') && c.length === 6) return '指数'
  return '其他'
}

async function fetchStockPage(pageNo) {
  const params = new URLSearchParams({
    isPagination: 'true',
    'pageHelp.pageSize': String(PAGE_SIZE),
    'pageHelp.pageNo': String(pageNo),
    'pageHelp.beginPage': String(pageNo),
    'pageHelp.cacheSize': '1',
    'pageHelp.endPage': String(pageNo),
    sqlId: STOCK_SQLID,
    _: String(Date.now()),
  })
  const text = await httpGet(`${QUERY_URL}?${params}`, STOCK_REFERER)
  const j = JSON.parse(stripJsonp(text))
  const rows = j.result || j.pageHelp?.data || []
  const total = Number(j.pageHelp?.total) || rows.length
  return { rows, total }
}

function readStockCache() {
  try {
    const j = JSON.parse(fs.readFileSync(STOCK_CACHE, 'utf8'))
    if (j && Array.isArray(j.items) && Date.now() - Date.parse(j.updatedAt || 0) < CACHE_TTL) return j.items
  } catch {
    /* 无缓存 */
  }
  return null
}

function writeStockCache(items) {
  const tmp = STOCK_CACHE + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), items }), 'utf8')
  fs.renameSync(tmp, STOCK_CACHE)
}

/** 拉全量沪市个股清单（分页），带 24h 缓存 */
export async function listStocks({ force = false } = {}) {
  if (!force) {
    const cached = readStockCache()
    if (cached) return cached
  }
  const all = []
  let total = Infinity
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { rows, total: t } = await fetchStockPage(page)
    total = t
    all.push(...rows)
    if (all.length >= total || !rows.length) break
  }
  const items = parseStockRows(all)
  writeStockCache(items)
  return items
}

/** 当日 ETF 清单（复用份额接口的最新可用交易日） */
export async function listEtfs() {
  const now = todayCST()
  for (let i = 0; i < 15; i++) {
    const d = addDays(now, -i)
    try {
      const rows = await fetchDay(d)
      if (rows.length) {
        return rows.map(([code, name, , ext]) => ({
          code,
          name: ext || name,
          type: 'etf',
          board: 'ETF',
        }))
      }
    } catch {
      /* 单日失败继续往前找 */
    }
  }
  return []
}

/** 合并清单，按代码去重（ETF 优先，因为 ETF 清单带扩位简称） */
export async function listUniverse({ force = false } = {}) {
  const [stocks, etfs] = await Promise.all([listStocks({ force }).catch(() => []), listEtfs().catch(() => [])])
  const m = new Map()
  for (const s of stocks) m.set(s.code, s)
  for (const e of etfs) m.set(e.code, e)
  return [...m.values()].sort((a, b) => (a.code < b.code ? -1 : 1))
}

/**
 * 搜索：代码前缀优先，其次名称包含。
 * @param {string} q
 */
export async function searchUniverse(q) {
  const key = String(q || '').trim().toLowerCase()
  if (!key) return { items: [], total: 0 }
  const all = await listUniverse()
  const byPrefix = []
  const byName = []
  for (const it of all) {
    if (it.code.startsWith(key)) byPrefix.push(it)
    else if (String(it.name).toLowerCase().includes(key)) byName.push(it)
  }
  byPrefix.sort((a, b) => (a.code < b.code ? -1 : 1))
  const items = [...byPrefix, ...byName].slice(0, 30)
  return { items, total: byPrefix.length + byName.length }
}
