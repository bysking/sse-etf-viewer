// connect 风格中间件：Vite dev / preview 与生产服务器共用
import { getIndex, getShares, search, todayCST, addDays } from './sse.js'
import { getKline } from './data/kline.js'
import { getSnap } from './data/snap.js'
import { getCalendar } from './data/calendar.js'
import { validateConfig } from '../shared/wyckoff/config.js'
import { analyzeWyckoff, seriesToBars } from '../shared/wyckoff/analyzer.js'
import { eventStudy } from '../shared/wyckoff/eventStudy.js'
import * as repo from './store/repositories.js'
import { executeBacktest } from './backtest/service.js'
import { startJob } from './jobs/queue.js'

class BadRequest extends Error {}
class NotFound extends Error {}

const need = (v, msg) => {
  if (!v) throw new BadRequest(msg)
  return v
}
const isoDate = (s, name) => {
  need(/^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s)), `参数 ${name} 应为 YYYY-MM-DD`)
  return s
}
const isCode = (v) => /^\d{6}$/.test(String(v || '').trim())
const bad = (msg) => new BadRequest(msg)

function readJson(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        tooLarge = true
        reject(new BadRequest('请求体过大'))
        req.resume()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new BadRequest('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function checkStrategyConfig(config) {
  need(config && typeof config === 'object' && !Array.isArray(config), 'config 必须是对象')
  need(isCode(config.symbol), '策略 config.symbol 应为 6 位代码')
  const errors = validateConfig(config.wyckoff || config)
  if (errors.length) throw new BadRequest(errors.join('；'))
  return config
}

function summaryOf(analysis) {
  const counts = {}
  for (const e of analysis.events) counts[e.type] = (counts[e.type] || 0) + 1
  return { counts, eventCount: analysis.events.length, rangeCount: analysis.ranges.length }
}

export function apiMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return next()

    const q = Object.fromEntries(url.searchParams)
    const method = (req.method || 'GET').toUpperCase()
    const send = (status, obj) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(obj))
    }

    try {
      // ---------------- 动态路由 ----------------
      if (url.pathname === '/api/strategies') {
        if (method === 'GET') return send(200, { items: repo.listStrategies() })
        if (method === 'POST') {
          const body = await readJson(req)
          need(String(body.name || '').trim(), '策略名称必填')
          const config = checkStrategyConfig(body.config)
          const created = repo.createStrategy({
            name: String(body.name).trim(),
            config,
            engineVersion: body.engineVersion || 'wyckoff-v1',
            enabled: body.enabled !== false,
          })
          return send(201, created)
        }
        throw bad('不支持的请求方法')
      }

      const backtestsMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/backtests$/)
      if (backtestsMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const strategy = repo.getStrategy(backtestsMatch[1])
        if (!strategy) throw new NotFound('策略不存在')
        const body = await readJson(req)
        const end = isoDate(body.end || todayCST(), 'end')
        const start = isoDate(body.start || addDays(end, -365), 'start')
        if (start > end) throw bad('开始日期不能晚于结束日期')
        const initialCash = body.initialCash == null ? strategy.config.initialCash ?? 100000 : Number(body.initialCash)
        if (!Number.isFinite(initialCash) || initialCash <= 0) throw bad('initialCash 必须是正数')
        const configSnapshot = { ...strategy.config, initialCash }
        const run = repo.createRun({
          strategyId: strategy.id,
          configSnapshot,
          engineVersion: strategy.engineVersion,
          symbol: strategy.config.symbol,
          start,
          end,
        })
        startJob(run.id, () => executeBacktest(run.id))
        return send(202, { id: run.id, status: run.status })
      }

      const strategyMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)$/)
      if (strategyMatch) {
        const id = strategyMatch[1]
        if (method === 'GET') {
          const s = repo.getStrategy(id)
          if (!s) throw new NotFound('策略不存在')
          return send(200, s)
        }
        if (method === 'PUT') {
          const body = await readJson(req)
          if (body.config != null) checkStrategyConfig(body.config)
          const updated = repo.updateStrategy(id, body)
          if (!updated) throw new NotFound('策略不存在')
          return send(200, updated)
        }
        if (method === 'DELETE') {
          if (!repo.deleteStrategy(id)) throw new NotFound('策略不存在')
          return send(200, { ok: true })
        }
        throw bad('不支持的请求方法')
      }

      const runsMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/runs$/)
      if (runsMatch) {
        if (method !== 'GET') throw bad('不支持的请求方法')
        return send(200, { items: repo.listRuns(runsMatch[1]) })
      }

      const signalsMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/signals$/)
      if (signalsMatch) {
        if (method !== 'GET') throw bad('不支持的请求方法')
        const limit = Math.max(1, Math.min(500, Number(q.limit) || 100))
        return send(200, { items: repo.listSignals(signalsMatch[1], limit) })
      }

      const runMatch = url.pathname.match(/^\/api\/backtests\/([^/]+)$/)
      if (runMatch) {
        if (method !== 'GET') throw bad('不支持的请求方法')
        const run = repo.getRun(runMatch[1])
        if (!run) throw new NotFound('回测任务不存在')
        return send(200, run)
      }

      if (url.pathname === '/api/research/events') {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const code = need(isCode(body.code) && String(body.code).trim(), '标的代码应为 6 位数字')
        const end = isoDate(body.end || todayCST(), 'end')
        const start = isoDate(body.start || addDays(end, -365), 'start')
        if (start > end) throw bad('开始日期不能晚于结束日期')

        const cfg = body.config || {}
        const wyckoffCfg = cfg.wyckoff
          ? { ...cfg.wyckoff, context: cfg.context, shareFlow: cfg.shareFlow }
          : { ...(body.wyckoff || cfg), context: body.context ?? cfg.context, shareFlow: body.shareFlow ?? cfg.shareFlow }
        const errors = validateConfig(wyckoffCfg)
        if (errors.length) throw new BadRequest(errors.join('；'))

        const k = await getKline(code, start, end)
        const bars = seriesToBars(k.series)
        if (!bars.length) throw new NotFound('区间内没有日 K 数据')
        let shares = body.shares || null
        if (!shares && body.includeShares) {
          const s = await getShares(code, start, end)
          shares = s.series.filter(([, v]) => v != null)
        }
        const analysis = analyzeWyckoff(bars, wyckoffCfg, { shares })
        const study = eventStudy(bars, analysis.events)
        return send(200, {
          code,
          start,
          end,
          summary: summaryOf(analysis),
          events: analysis.events,
          ranges: analysis.ranges,
          pivots: analysis.pivots,
          eventStudy: { horizons: study.horizons, summary: study.summary, rows: study.rows },
          states: analysis.states.map((s) => ({
            date: s.date,
            phase: s.phase,
            confidence: s.confidence,
            range: s.range,
            eventTypes: s.eventTypes,
            weekly: s.weekly,
            share: s.share,
          })),
          last: analysis.states[analysis.states.length - 1] || null,
        })
      }

      // ---------------- 固定路由 ----------------
      switch (url.pathname) {
        case '/api/health':
          return send(200, { ok: true })
        case '/api/search':
          return send(200, await search(q.q || ''))
        case '/api/shares': {
          const code = need(isCode(q.code) && q.code.trim(), 'ETF 代码应为 6 位数字')
          return send(200, await getShares(code, isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        }
        case '/api/index':
          return send(200, await getIndex(q.code || '000001', isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        case '/api/kline': {
          const code = need(isCode(q.code) && q.code.trim(), '标的代码应为 6 位数字')
          return send(200, await getKline(code, isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        }
        case '/api/snap': {
          const code = need(isCode(q.code) && q.code.trim(), '标的代码应为 6 位数字')
          return send(200, await getSnap(code))
        }
        case '/api/calendar':
          return send(200, await getCalendar(isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        default:
          return send(404, { error: 'not found' })
      }
    } catch (e) {
      if (e instanceof NotFound) return send(404, { error: e.message })
      send(e instanceof BadRequest ? 400 : 502, { error: e.message })
    }
  }
}
